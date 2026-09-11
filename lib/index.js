/**
 * dsh-agentic-proxy — host half.
 *
 * Gives the agent a per-command proxy switch (`proxy <cmd>`) backed by a kernel this
 * plugin installs and supervises itself, so the package works on a machine with no
 * proxy software pre-installed.
 *
 * Why a PATH shim rather than hooking tool calls: the harness cannot rewrite an
 * already-issued command — `PreToolDecision` is allow/deny/ask only — so a rewritten
 * command would execute something the transcript never showed. A real `proxy.cmd` on the
 * child PATH keeps the log honest and leaves the command inside the agent's own shell.
 */
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { renderConfig, DEFAULT_API_PORT, DEFAULT_TEST_URL, GROUP_NAME, PROVIDER_NAME } from './config.js'
import { createKernel, probePort } from './kernel.js'
import { ensureRoot, paths } from './paths.js'
import { writeState } from './state.js'
import { installShim, removeShim, SHIM_NAME } from './shim.js'
import { registerRpc } from './rpc.js'
import { KernelApi } from './api.js'
import { Watchdog } from './watchdog.js'

export const name = 'dsh-agentic-proxy'

/** The package needs the web server to serve its settings page RPC; settings is optional. */
export const inject = ['webServer']

const NS = 'dsh-agentic-proxy'
const DEFAULT_PORT = 17890

const DEFAULTS = {
  enabled: true,
  subscribeUrl: '',
  port: DEFAULT_PORT,
  apiPort: DEFAULT_API_PORT,
  /** Empty means "the kernel this plugin manages"; set it to use your own build. */
  kernelPath: '',
  autoStart: true,
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asPort(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback
}

function normalize(input) {
  const src = input !== null && typeof input === 'object' ? input : {}
  const pick = (key) => (key in src ? src[key] : DEFAULTS[key])
  return {
    enabled: pick('enabled') !== false,
    subscribeUrl: asString(pick('subscribeUrl')).trim(),
    port: asPort(pick('port'), DEFAULTS.port),
    apiPort: asPort(pick('apiPort'), DEFAULTS.apiPort),
    kernelPath: asString(pick('kernelPath')).trim(),
    autoStart: pick('autoStart') !== false,
  }
}

/** Hand-rolled schema keeps this package dependency-free. */
function makeSchema() {
  const callable = (input) => normalize(input)
  callable.toJSON = () => ({
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      subscribeUrl: { type: 'string' },
      port: { type: 'number' },
      apiPort: { type: 'number' },
      kernelPath: { type: 'string' },
      autoStart: { type: 'boolean' },
    },
  })
  return callable
}

export function apply(ctx) {
  const state = {
    settings: null,
    scope: null,
    config: normalize(null),
    kernel: null,
    dirs: null,
    shim: null,
    watchdog: null,
    lastError: '',
    logs: [],
  }

  const settings = ctx.get('settings')
  if (settings !== undefined) {
    try {
      state.scope = settings.register(NS, makeSchema(), { applies: 'live' })
      state.config = normalize(state.scope.get())
    } catch (error) {
      state.lastError = `设置命名空间注册失败：${error.message}`
    }
  } else {
    state.lastError = 'settings 服务不可用'
  }

  const readConfig = () => {
    if (state.scope !== null) {
      try {
        state.config = normalize(state.scope.get())
      } catch {
        // Keep the last good value.
      }
    }
    return state.config
  }

  function pushLog(line) {
    if (line.length === 0) return
    state.logs.push(line)
    if (state.logs.length > 200) state.logs.shift()
  }

  async function prepare() {
    if (state.dirs === null) state.dirs = await ensureRoot()
    return state.dirs
  }

  /** Regenerate config, then bring the kernel up (installing it on first use). */
  async function start({ onProgress } = {}) {
    const config = readConfig()
    const dirs = await prepare()
    if (config.subscribeUrl === '') {
      throw new Error('尚未配置订阅地址。请在「设置 → 代理管家」中填写订阅链接。')
    }
    await writeFile(
      dirs.config,
      renderConfig({
        port: config.port,
        apiPort: config.apiPort,
        apiSecret: state.apiSecret ?? (state.apiSecret = randomBytes(16).toString('hex')),
        subscriptionUrl: config.subscribeUrl,
        providerPath: `${dirs.root}\\provider.yaml`,
      }),
      'utf8',
    )
    if (state.kernel === null) {
      state.kernel = await createKernel(
        {
          port: config.port,
          apiPort: config.apiPort,
          apiSecret: state.apiSecret,
          binary: config.kernelPath === '' ? dirs.kernel : config.kernelPath,
          onEvent: pushLog,
        },
      )
      state.kernel.onLog = pushLog
    }
    const result = await state.kernel.ensureStarted({ onProgress })
    // Failover only makes sense once the kernel is actually serving.
    await startWatchdog()
    return result
  }

  /**
   * Layer 2 + 4. The watchdog only reads and controls; it never touches traffic, because
   * the plugin is not on the traffic path.
   */
  async function startWatchdog() {
    const config = readConfig()
    const dirs = await prepare()
    if (state.watchdog === null) {
      state.watchdog = new Watchdog({
        api: new KernelApi({ port: config.apiPort, secret: state.apiSecret }),
        group: GROUP_NAME,
        provider: PROVIDER_NAME,
        testUrl: DEFAULT_TEST_URL,
        onEvent: pushLog,
        // UP and DEGRADED are the shim's contract; both are written to the state file.
        onState: (next) => {
          void writeState(dirs.state, next)
        },
      })
    }
    state.watchdog.start()
  }

  async function stopWatchdog() {
    if (state.watchdog !== null) {
      await state.watchdog.stop()
      state.watchdog = null
    }
  }

  async function stop() {
    await stopWatchdog()
    if (state.kernel !== null) await state.kernel.stop()
  }

  /** The shim is an external file; install it lazily and only when asked to. */
  async function syncShim() {
    const config = readConfig()
    const dirs = await prepare()
    if (state.shim === null) {
      state.shim = await installShim(process.env, { port: config.port, stateFile: dirs.state })
    }
    return state.shim
  }

  async function status() {
    const config = readConfig()
    const dirs = await prepare()
    const listening = await probePort(config.port)
    let kernel = { installed: false, version: '' }
    try {
      const { stat } = await import('node:fs/promises')
      const info = await stat(config.kernelPath === '' ? dirs.kernel : config.kernelPath)
      kernel = { installed: true, bytes: info.size }
    } catch {
      kernel = { installed: false }
    }
    return {
      config: JSON.stringify(config),
      listening,
      kernelUp: listening,
      kernel,
      shim: state.shim,
      shimName: SHIM_NAME,
      root: dirs.root,
      lastError: state.lastError,
      logs: state.logs.slice(-20).join('\n'),
      /** Watchdog view: what the kernel reports about node health right now. */
      failover: state.watchdog === null ? null : state.watchdog.describe(),
    }
  }

  // ------------------------------------------------------------------ RPC ----

  // The settings page is a browser module, so it talks to the host over HTTP. Note there
  // is no model-facing tool here on purpose: the agent's interface is the `proxy`
  // command, and adding a tool would compete with it for the model's attention.
  const rpc = registerRpc(ctx, {
    status: async () => await status(),
    start: async () => {
      state.lastError = ''
      try {
        await start()
      } catch (error) {
        state.lastError = error.message
      }
      return await status()
    },
    stop: async () => {
      await stop()
      return await status()
    },
    'install-shim': async () => {
      state.shim = null
      const result = await syncShim()
      return { ...(await status()), install: result }
    },
    'remove-shim': async () => {
      const removed = await removeShim(process.env)
      state.shim = { installed: false, removed }
      return await status()
    },
    save: async (args) => {
      if (state.scope === null) throw new Error('settings 服务不可用')
      const input = args !== null && typeof args === 'object' ? args : {}
      const base = readConfig()
      await state.scope.update({
        enabled: input.enabled !== undefined ? input.enabled === true : base.enabled,
        subscribeUrl: input.subscribeUrl !== undefined ? asString(input.subscribeUrl).trim() : base.subscribeUrl,
        port: input.port !== undefined ? asPort(input.port, base.port) : base.port,
        kernelPath: input.kernelPath !== undefined ? asString(input.kernelPath).trim() : base.kernelPath,
        autoStart: input.autoStart !== undefined ? input.autoStart === true : base.autoStart,
      })
      const next = readConfig()
      // The port is baked into the shim, so changing it must regenerate the shim.
      if (next.port !== base.port && state.shim !== null) {
        state.shim = null
        await syncShim()
      }
      return await status()
    },
  })
  if (!rpc.registered) state.lastError = state.lastError || rpc.reason

  // ------------------------------------------------------------ lifecycle ----

  ctx.effect(() => () => {
    // Stopping the plugin must not leave a kernel holding the port or a shim on PATH.
    void stop()
  }, 'dsh-agentic-proxy: kernel teardown')

  if (state.config.autoStart && state.config.enabled && state.config.subscribeUrl !== '') {
    // Deliberately not awaited: startup must not block plugin load, and a failure here
    // is reported through status rather than thrown into the loader.
    void start().catch((error) => {
      state.lastError = error.message
    })
  }
}
