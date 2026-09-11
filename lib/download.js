/**
 * Fetches the kernel and its GeoIP data on first use.
 *
 * Facts this encodes (see FINDINGS.md for evidence):
 *  - npm and the npmmirror binary mirror carry no mihomo build, so GitHub is the only
 *    real source. There is no mainland fallback if GitHub and both mirrors are down;
 *    that limit is surfaced to the user instead of hidden.
 *  - The version is discovered through `releases/latest/download/version.txt`, a
 *    version-less alias, so the 60/hour unauthenticated API quota is never touched.
 *  - HEAD lies here (it reports 6087 bytes for an 18 MB asset), so sizes are only ever
 *    read from a real GET.
 *  - Upstream publishes no sha256 asset, so integrity is checked by comparing the
 *    received length against the length the same source advertised.
 *  - `hub.fastgit.org` is deliberately absent: the domain now resolves to an unrelated
 *    host and must never be used.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const RELEASES = 'https://github.com/MetaCubeX/mihomo/releases'
const VERSION_URL = `${RELEASES}/latest/download/version.txt`

/**
 * Ordered by measured success and speed on a mainland connection.
 *
 * `github` is first because on an unrestricted network it is the fastest and needs no
 * third party. It is given a short timeout because on a restricted one the connection
 * simply hangs (measured: 10.6s to `UND_ERR_CONNECT_TIMEOUT`, and 21s via curl), and
 * waiting that out on every attempt would make a first run feel broken. Both mirrors were
 * measured working, including a `206` range response whose `content-range` matched the
 * published asset size exactly.
 *
 * `hub.fastgit.org` is deliberately absent: the domain now resolves to an unrelated host.
 */
export const MIRRORS = [
  { id: 'github', timeoutMs: 10000, wrap: (url) => url },
  { id: 'gh-proxy.com', timeoutMs: 60000, wrap: (url) => `https://gh-proxy.com/${url}` },
  { id: 'ghproxy.net', timeoutMs: 60000, wrap: (url) => `https://ghproxy.net/${url}` },
]

const GEO_ASSETS = {
  mmdb: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb',
  geosite: 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat',
}

export function kernelAssetName(version) {
  return `mihomo-windows-amd64-compatible-${version}.zip`
}

/** A per-attempt ceiling, so a hanging mirror cannot stall the whole chain. */
function signalFor(mirror, outer) {
  const timeout = AbortSignal.timeout(mirror.timeoutMs)
  return outer === undefined ? timeout : AbortSignal.any([outer, timeout])
}

export async function latestVersion(signal) {
  const failures = []
  for (const mirror of MIRRORS) {
    try {
      const response = await fetch(mirror.wrap(VERSION_URL), { signal: signalFor(mirror, signal), redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = (await response.text()).trim()
      if (!/^v\d+\.\d+\.\d+$/.test(text)) {
        throw new Error(`版本号格式异常: ${JSON.stringify(text.slice(0, 40))}`)
      }
      return text
    } catch (error) {
      if (signal?.aborted === true) throw error
      failures.push(`${mirror.id}: ${error.message}`)
    }
  }
  throw new Error(`无法获取内核版本号（${failures.join('；')}）`)
}

/** Ask each mirror in turn; the first real answer wins. */
async function probeSizeAny(buildUrl, outer) {
  for (const mirror of MIRRORS) {
    const size = await probeSize(mirror.wrap(buildUrl), mirror, outer)
    if (size !== undefined && size > 0) return size
  }
  return undefined
}
/** A zip always begins with a local file header — catches a mirror that answered with HTML. */
async function looksLikeZip(file) {
  try {
    const head = await readFile(file)
    return head.length > 4 && head[0] === 0x50 && head[1] === 0x4b
  } catch {
    return false
  }
}

/** Weak-but-honest size check: what a source advertises must match what is delivered. */
async function probeSize(url, mirror, outer) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
      signal: signalFor(mirror, outer),
    })
    if (!response.ok && response.status !== 206) return undefined
    const range = response.headers.get('content-range')
    if (typeof range === 'string') {
      const match = /\/(\d+)$/.exec(range)
      if (match !== null) return Number(match[1])
    }
    const length = response.headers.get('content-length')
    return length === null ? undefined : Number(length)
  } catch {
    return undefined
  }
}

/**
 * Download to a temporary name and rename into place, so an interrupted transfer never
 * leaves a half-written file that a later start would mistake for a working binary.
 */
async function download(url, target, { expectedBytes, signal, onProgress, mirror, expectZip = false } = {}) {  const response = await fetch(url, {
    signal: mirror === undefined ? signal : signalFor(mirror, signal),
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0) || expectedBytes || 0
  if (expectedBytes !== undefined && total !== 0 && total !== expectedBytes) {
    throw new Error(`长度不符：期望 ${expectedBytes}，实际 ${total}`)
  }
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.part`
  let written = 0
  const body = Readable.fromWeb(response.body)
  if (onProgress !== undefined) {
    body.on('data', (chunk) => {
      written += chunk.length
      onProgress(written, total)
    })
  }
  try {
    await pipeline(body, createWriteStream(temp))
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  const written2 = (await stat(temp)).size
  if (expectedBytes !== undefined && written2 !== expectedBytes) {
    await rm(temp, { force: true })
    throw new Error(`下载不完整：${written2} / ${expectedBytes} 字节`)
  }
  // A mirror under load can answer 200 with an HTML error page; that must never be
  // renamed into place and later mistaken for a kernel.
  if (expectZip && !(await looksLikeZip(temp))) {
    await rm(temp, { force: true })
    throw new Error(`下载内容不是有效的 zip（${written2} 字节）`)
  }
  await rename(temp, target)
  return written2
}

/** Try each mirror in order; report every failure so a total failure is diagnosable. */
export async function fetchWithMirrors(buildUrl, target, options = {}) {
  const failures = []
  for (const mirror of MIRRORS) {
    const url = mirror.wrap(buildUrl)
    try {
      const bytes = await download(url, target, { ...options, mirror })
      return { source: mirror.id, bytes, url }
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      failures.push(`${mirror.id}: ${error.message}`)
    }
  }
  const detail = failures.join('；')
  throw new Error(
    `所有下载源均失败（${detail}）。` +
      '若你的网络无法访问 GitHub，请手动下载内核后填入「设置 → 代理管家 → 内核路径」。',
  )
}

export async function ensureKernel(dirs, options = {}) {
  const { signal, onProgress, force = false } = options
  if (!force && (await exists(dirs.kernel))) {
    return { installed: false, path: dirs.kernel }
  }
  const version = await latestVersion(signal)
  const asset = kernelAssetName(version)
  const url = `${RELEASES}/download/${version}/${asset}`
  const expected = await probeSizeAny(url, signal)
  const zipPath = join(dirs.root, asset)
  const result = await fetchWithMirrors(url, zipPath, { expectedBytes: expected, signal, onProgress, expectZip: true })
  return { installed: true, version, zipPath, ...result }
}

/**
 * mihomo needs `country.mmdb` for `GEOIP,CN,DIRECT` — without it the routing rule that
 * keeps domestic traffic off the proxy cannot match. Fetched separately so a failure
 * here degrades routing rather than breaking startup.
 */
export async function ensureGeoAssets(dirs, options = {}) {
  const { signal } = options
  const targets = [
    { key: 'mmdb', file: join(dirs.root, 'country.mmdb') },
    { key: 'geosite', file: join(dirs.root, 'geosite.dat') },
  ]
  const results = []
  for (const target of targets) {
    if (await exists(target.file)) {
      results.push({ ...target, installed: false })
      continue
    }
    try {
      await fetchWithMirrors(GEO_ASSETS[target.key], target.file, { signal })
      results.push({ ...target, installed: true })
    } catch (error) {
      results.push({ ...target, installed: false, error: error.message })
    }
  }
  return results
}

async function exists(file) {
  try {
    const info = await stat(file)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

export { exists as fileExists }
