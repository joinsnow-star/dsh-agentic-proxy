/**
 * Three-way sync check: local working tree ↔ GitHub `origin/main` ↔ the npm registry.
 *
 * Maintainer tool — deliberately NOT in package.json `files`, because adding a file to the
 * published set would change what npm 0.1.1 holds and break the version↔content mapping the
 * released tags guarantee.
 *
 * The invariant this asserts:
 *
 *   tag v<version>  →  a commit whose `files`-whitelisted content is byte-identical to
 *                      the tarball published on npm as <version>
 *
 * GitHub transport is checked through `git` itself (which honours the user's proxy config),
 * never through a direct HTTP call to codeload — Node's `fetch` ignores HTTP_PROXY, so a
 * machine whose only route to GitHub is a proxy would report a false failure here.
 *
 * Usage: node check-sync.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const run = promisify(execFile)
const git = async (...args) => (await run('git', args)).stdout.trim()

let failures = 0
const ok = (m) => console.log('  PASS ' + m)
const bad = (m) => { failures += 1; console.log('  FAIL ' + m) }

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const version = pkg.version
console.log(`checking dsh-agentic-proxy@${version}\n`)

// ---------------------------------------------------------------- local ----
console.log('[1] local')
const dirty = await git('status', '--porcelain')
if (dirty === '') ok('working tree is clean')
else bad('working tree is dirty:\n' + dirty)
const head = await git('rev-parse', 'HEAD')
ok(`HEAD ${head.slice(0, 7)}`)

// --------------------------------------------------------------- github ----
console.log('\n[2] github (via git, so the user\'s proxy config applies)')
await git('fetch', 'origin', '--tags', '--quiet')
const remote = await git('rev-parse', 'origin/main')
if (remote === head) ok('origin/main is the same commit as local HEAD')
else bad(`origin/main ${remote.slice(0, 7)} != local HEAD ${head.slice(0, 7)} — push or pull`)

const tagName = `v${version}`
let tagCommit = null
try {
  tagCommit = await git('rev-parse', `${tagName}^{commit}`)
  ok(`tag ${tagName} -> ${tagCommit.slice(0, 7)}`)
} catch {
  bad(`tag ${tagName} does not exist — releases must be tagged so an npm version maps to a commit`)
}
// The tag does NOT have to equal HEAD. Commits that only touch repo-only files (docs, this
// script, submission/) legitimately land after a release. What must hold is that nothing
// inside the PUBLISHED set changed since the tag — otherwise the tarball no longer matches
// the commit its version names, and the version has to be bumped.
if (tagCommit !== null) {
  const changed = await git('diff', '--name-only', tagName, 'HEAD', '--', ...pkg.files)
  if (changed === '') ok(`published content unchanged since ${tagName} (HEAD ahead only by repo-only files)`)
  else bad(`published files changed after ${tagName} without a version bump:\n${changed}`)
}

// ------------------------------------------------------------------ npm ----
console.log('\n[3] npm')
const meta = await (await fetch(`https://registry.npmjs.org/${pkg.name}`, {
  headers: { accept: 'application/vnd.npm.install-v1+json' },
})).json()
const latest = meta['dist-tags']?.latest
if (latest === version) ok(`registry latest is ${latest}`)
else bad(`registry latest is ${latest}, local is ${version} — publish, or bump back`)

const dist = meta.versions?.[version]?.dist
if (dist === undefined) {
  bad(`${version} is not on the registry at all`)
} else {
  ok(`tarball ${dist.tarball}`)
}

// ------------------------------------- npm tarball vs local published set ----
console.log('\n[4] npm tarball content vs the local files whitelist')
if (dist === undefined) {
  bad('skipped: nothing to download')
} else {
  const dir = await mkdtemp(join(tmpdir(), 'sync-'))
  try {
    const tgz = join(dir, 'p.tgz')
    const res = await fetch(dist.tarball)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tgz))
    // `tar` ships with Windows 10+ and every POSIX target; kernel.js already relies on it.
    await run('tar', ['-xzf', tgz, '-C', dir])

    const root = join(dir, 'package')
    const walk = async (base, dir0 = base) => {
      const out = []
      for (const entry of await readdir(dir0, { withFileTypes: true })) {
        const full = join(dir0, entry.name)
        if (entry.isDirectory()) out.push(...await walk(base, full))
        else out.push(relative(base, full).replaceAll('\\', '/'))
      }
      return out
    }
    const sha = async (file) =>
      createHash('sha256').update(await readFile(file)).digest('hex')

    const published = (await walk(root)).sort()
    const expected = [...pkg.files].sort()
    // npm ALWAYS packs package.json (and any README/LICENSE it finds) regardless of `files`,
    // so those are legitimate members of the published set rather than whitelist escapes.
    const alwaysIncluded = new Set(['package.json'])
    const declared = published.filter(
      (f) => alwaysIncluded.has(f) || expected.some((e) => f === e || f.startsWith(e + '/')),
    )
    if (declared.length === published.length) ok(`tarball holds only whitelisted files (${published.length})`)
    else bad('tarball holds files outside `files`: ' + published.filter((f) => !declared.includes(f)).join(', '))

    const drifted = []
    for (const rel of published) {
      let localHash
      try {
        localHash = await sha(rel)
      } catch {
        drifted.push(`${rel} (absent locally)`)
        continue
      }
      if (localHash !== await sha(join(root, rel))) drifted.push(rel)
    }
    if (drifted.length === 0) ok(`all ${published.length} published files are byte-identical to the working tree`)
    else bad('drifted from the working tree: ' + drifted.join(', '))

    // Repo-only files must NOT be published — that is what keeps the tags meaningful.
    // Derived from the actual git index rather than a hardcoded list, so adding or removing
    // a repo-only file (or trimming `files`) can never leave this assertion stale.
    const tracked = (await git('ls-files')).split('\n').filter(Boolean)
    const repoOnly = tracked.filter(
      (f) => f !== 'package.json' && !pkg.files.some((e) => f === e || f.startsWith(e + '/')),
    )
    const leaked = published.filter((f) => repoOnly.includes(f))
    if (leaked.length === 0) ok(`repo-only files are not published (${repoOnly.length} checked)`)
    else bad('repo-only files leaked into npm: ' + leaked.join(', '))
  } catch (error) {
    bad(`could not compare tarball content: ${error.message}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log('\n' + (failures === 0 ? 'IN SYNC' : failures + ' SYNC PROBLEM(S)'))
process.exit(failures === 0 ? 0 : 1)
