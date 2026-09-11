/**
 * Validate the package the way an installer would, before anything is published.
 * Read-only: creates nothing in the project, only inspects.
 *
 * Checks:
 *   - package.json parses and carries the fields `dsh plugin add` depends on
 *   - every path in `files` exists
 *   - exports targets resolve
 *   - the client half is a classic script (no module syntax) and calls __ModuleLoader__.load
 *   - cordis.patch.yml parses and its `name` matches the package name
 *   - every module parses
 *   - the host half waits for the async `settings` provider instead of racing it
 *   - the failover decisions hold: escape a dead node, never fake a switch, degrade only
 *     when everything is measured-and-dead
 */
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let failures = 0
const ok = (m) => console.log('  PASS ' + m)
const bad = (m) => { failures += 1; console.log('  FAIL ' + m) }

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
console.log('package:', pkg.name, pkg.version)

// --- fields the installer relies on ------------------------------------------
console.log('\n[1] installer-critical fields')
if (typeof pkg.dsh?.bundle?.patch === 'string') ok('dsh.bundle.patch present -> package is treated as a plugin')
else bad('dsh.bundle.patch missing: `dsh plugin add` would not mount it')
if (pkg.name === 'dsh-agentic-proxy') ok('name matches the preset/cordis expectation')
else bad('unexpected name ' + pkg.name)
if (pkg.type === 'module') ok('type=module (host half uses ESM)')
else bad('type is not module')
if (/github\.com\/joinsnow-star\/dsh-agentic-proxy/.test(pkg.repository?.url ?? '')) ok('repository URL set')
else bad('repository URL not set to the real repo')

// --- published file set ------------------------------------------------------
console.log('\n[2] files declared for publication')
for (const entry of pkg.files ?? []) {
  if (existsSync(entry)) ok(entry)
  else bad(entry + ' is declared but missing')
}
for (const required of ['cordis.patch.yml', 'LICENSE', 'README.md']) {
  if (!(pkg.files ?? []).includes(required)) bad(required + ' is not in `files` and would not be published')
}

// --- exports -----------------------------------------------------------------
console.log('\n[3] exports resolve')
const mainTarget = pkg.exports?.['.']?.import
if (mainTarget && existsSync(mainTarget)) ok('main -> ' + mainTarget)
else bad('main export does not resolve')
const clientTarget = pkg.exports?.['./client']
if (clientTarget && existsSync(clientTarget)) ok('client -> ' + clientTarget)
else bad('client export does not resolve')
if (pkg.dsh?.client?.platform === 'web') ok('dsh.client.platform = web')
else bad('dsh.client.platform must be "web"')

// --- client half contract ----------------------------------------------------
console.log('\n[4] client half contract')
const clientSrc = await readFile(clientTarget, 'utf8')
if (clientSrc.includes('__ModuleLoader__.load')) ok('calls window.__ModuleLoader__.load')
else bad('client does not use the module-loader contract')
if (/^\s*(import|export)\s/m.test(clientSrc)) bad('client contains module syntax; it is loaded as a classic script')
else ok('client is a classic script (no import/export)')
if (clientSrc.includes('id: \'dsh-agentic-proxy\'') || clientSrc.includes('id: "dsh-agentic-proxy"')) ok('loader id equals the package name')
else bad('loader id must equal the package name')
if (clientSrc.includes('exports.apply')) ok('exports.apply present')
else bad('exports.apply missing')

// --- cordis patch ------------------------------------------------------------
console.log('\n[5] cordis.patch.yml')
const patch = await readFile(pkg.dsh.bundle.patch, 'utf8')
if (/-\s*insert:/.test(patch)) ok('contains an `insert` row')
else bad('patch has no insert row')
const nameMatch = /name:\s*(\S+)/.exec(patch)
if (nameMatch && nameMatch[1] === pkg.name) ok('row name matches the package name')
else bad(`row name ${nameMatch?.[1]} must equal ${pkg.name}`)

// --- modules parse -----------------------------------------------------------
console.log('\n[6] modules parse')
const { readdir } = await import('node:fs/promises')
for (const dir of ['lib']) {
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.js')) continue
    try {
      await import(pathToFileURL(`${dir}/${file}`).href + `?t=${Date.now()}`)
      ok(`${dir}/${file} imports`)
    } catch (error) {
      bad(`${dir}/${file}: ${error.message}`)
    }
  }
}

// --- host half export shape --------------------------------------------------
console.log('\n[7] host half shape')
const host = await import(pathToFileURL(mainTarget).href + `?t=${Date.now()}`)
if (typeof host.apply === 'function') ok('exports apply')
else bad('host half must export apply')
if (host.name === pkg.name) ok('exports name = ' + host.name)
else bad('exported name mismatch: ' + host.name)
if (Array.isArray(host.inject)) ok('inject declares ' + JSON.stringify(host.inject))
else bad('inject must be an array (needs webServer for the settings RPC)')

// --- settings access must not race the async provider ------------------------
// Regression guard. `settings` is provided by a fiber that only becomes ACTIVE after its
// async init (a disk read), and cordis `get(name, strict=true)` filters out inactive
// providers — so an apply-time `ctx.get('settings')` returns undefined with no error.
// The plugin must wait with ctx.inject instead.
console.log('\n[8] settings is read through ctx.inject, not an eager ctx.get')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const hostSrc = stripComments(await readFile(mainTarget, 'utf8'))
if (/ctx\.inject\(\s*\[\s*['"]settings['"]/.test(hostSrc)) ok("waits for settings via ctx.inject(['settings'], …)")
else bad("host half must wait for the async settings provider with ctx.inject(['settings'], …)")
if (/ctx\.get\(\s*['"]settings['"]\s*\)/.test(hostSrc)) bad("eager ctx.get('settings') returns undefined; the provider is not yet active at apply time")
else ok("no eager ctx.get('settings') read")

// --- failover decisions: behaviour, not shape --------------------------------
// Drives the real Watchdog against a scripted kernel API. Nothing is created on disk and
// no kernel is contacted, so this stays a read-only inspection — but it exercises the
// "switch away from a dead node" logic the whole feature exists for.
console.log('\n[9] failover decisions')
{
  const { Watchdog } = await import('./lib/watchdog.js')
  const TEST = 'https://test'
  const alive = (name, delay) => ({ name, alive: true, extra: { [TEST]: { history: [{ delay }] } } })
  const dead = (name) => ({ name, alive: false, extra: {} })
  const untested = (name) => ({ name, alive: true, extra: {} })

  /** Scripted kernel: `onRetest` decides whether a forced re-test actually re-selects. */
  const rig = ({ members, now, onRetest }) => {
    const calls = []
    const events = []
    const states = []
    const g = { all: members.map((m) => m.name), now, fixed: '' }
    const api = {
      proxies: async () => ({ auto: { ...g } }),
      providerProxies: async () => ({ proxies: members }),
      retestGroup: async () => { calls.push('retestGroup'); if (onRetest) onRetest({ g }) },
      healthcheckProvider: async () => { calls.push('healthcheckProvider') },
      refreshProvider: async () => { calls.push('refreshProvider') },
      // Kept so a future regression that re-introduces pinning is caught, not silently allowed.
      pin: async (_g, n) => { calls.push('pin:' + n); g.fixed = n; g.now = n },
      unpin: async () => { calls.push('unpin'); g.fixed = '' },
    }
    const w = new Watchdog({
      api, group: 'auto', provider: 'sub', testUrl: TEST,
      onEvent: (e) => events.push(e), onState: (s) => states.push(s),
    })
    w.stopped = false // drive tick() by hand instead of waiting on the timer
    return { w, calls, events, states }
  }

  // (a) dead current node, re-test makes the kernel re-select a live one
  {
    const s = rig({ members: [dead('A'), alive('B', 50), alive('C', 80)], now: 'A', onRetest: ({ g }) => { g.now = 'B' } })
    await s.w.tick()
    if (s.calls.includes('retestGroup')) ok('dead node -> forced a re-test')
    else bad('dead node did not trigger a re-test')
    if (s.events.some((e) => e.includes('已重新测速并切换到「B」'))) ok('dead node -> switched to the live node')
    else bad('did not report switching to the live node: ' + s.events.join(' | '))
    if (!s.calls.some((c) => c.startsWith('pin:'))) ok('no pin attempted (url-test ignores `fixed`)')
    else bad('pinned a node even though a url-test group ignores `fixed`')
    if (s.states.length === 0) ok('state stayed UP')
    else bad('state changed while a usable node existed: ' + JSON.stringify(s.states))
  }

  // (b) re-test does not help: report honestly, never fake a switch, never degrade
  {
    const s = rig({ members: [dead('A'), alive('B', 50), alive('C', 80)], now: 'A', onRetest: () => {} })
    await s.w.tick()
    if (!s.calls.some((c) => c.startsWith('pin:'))) ok('did not pin when the re-test did not help')
    else bad('pinned after an ineffective re-test')
    if (s.events.some((e) => e.includes('仍未自动切换到可用节点'))) ok('reported honestly that no switch happened')
    else bad('did not report the failed switch: ' + s.events.join(' | '))
    if (!s.events.some((e) => e.includes('临时指定'))) ok('never claimed a switch it did not make')
    else bad('log claims a temporary pin that a url-test group cannot honour')
    if (s.states.length === 0) ok('did NOT force DEGRADED while usable nodes exist')
    else bad('forced DEGRADED although usable nodes exist — would send proxied traffic direct')
  }

  // (c) every member dead: DEGRADED must be published BEFORE the slow recovery
  {
    const order = []
    const s = rig({ members: [dead('A'), dead('B'), dead('C')], now: 'A' })
    const refresh = s.w.api.refreshProvider
    s.w.api.refreshProvider = async () => { order.push('refresh'); return refresh() }
    s.w.onState = (v) => { order.push('state:' + v); s.states.push(v) }
    await s.w.tick()
    if (s.states.includes('DEGRADED')) ok('all nodes dead -> published DEGRADED')
    else bad('all nodes dead but DEGRADED was never published')
    if (order.indexOf('state:DEGRADED') !== -1 && order.indexOf('state:DEGRADED') < order.indexOf('refresh')) ok('DEGRADED published before the slow re-fetch')
    else bad('recovery ran before DEGRADED: ' + order.join(' -> '))
  }

  // (d) merely unmeasured is not failure
  {
    const s = rig({ members: [untested('A'), alive('B', 50)], now: 'A' })
    await s.w.tick()
    if (!s.calls.includes('retestGroup')) ok('unmeasured current node -> no escalation on the first tick')
    else bad('escalated on an unmeasured node (a guess is not a failure)')
    if (s.states.length === 0) ok('unmeasured current node -> state stayed UP')
    else bad('degraded on an unmeasured node: ' + JSON.stringify(s.states))
  }

  // (e) escalation is throttled
  {
    const s = rig({ members: [dead('A'), alive('B', 50)], now: 'A', onRetest: () => {} })
    await s.w.tick()
    const first = s.calls.filter((c) => c === 'retestGroup').length
    await s.w.tick()
    const second = s.calls.filter((c) => c === 'retestGroup').length
    if (second === first) ok('second tick inside the throttle window did not re-escalate')
    else bad(`escalation was not throttled (${first} -> ${second})`)
  }
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)
