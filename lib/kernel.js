/**
 * Owns the kernel process. There is no external Clash to lean on — the package must be
 * installable by anyone — so starting, watching and stopping the kernel is this
 * module's whole job.
 *
 * Lifetime policy (chosen deliberately):
 *  - Lazy: the kernel starts on first need, not at plugin load, so a session that never
 *    touches the network pays nothing.
 *  - Tied to DSH: stopping the plugin stops the kernel. A kernel that outlived its
 *    harness would be an orphan holding a port and a tunnel open, so the pid file exists
 *    to recognise exactly that case and clean it up.
 */
import { spawn } from 'node:child_process'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { ensureRoot, paths } from './paths.js'
import { ensureGeoAssets, ensureKernel, fileExists } from './download.js'
import { UP, DOWN, readState, writeState } from './state.js'

/** A TCP connect is the only check that proves the listener is actually accepting. */
export function probePort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function isAlive(pid) {
  try {
    // Signal 0 performs the permission/existence check without delivering anything.
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * The image name of a live pid, or undefined when it cannot be determined.
 *
 * Pids are reused by the OS, so a pid file alone cannot prove the process is still our
 * kernel — an unrelated program may now hold that number. Comparing the image name is
 * what makes the port check trustworthy.
 */
async function pidImage(pid) {
  const { spawnSync } = await import('node:child_process')
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      })
      // "mihomo.exe","1234","Console","1","50,000 K"
      const match = /^"([^"]+)"/.exec(String(r.stdout ?? '').trim())
      return match === null ? undefined : match[1]
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 })
    const text = String(r.stdout ?? '').trim()
    return text === '' ? undefined : text.split('/').pop()
  } catch {
    return undefined
  }
}

export class Kernel {
  constructor(options) {
    this.port = options.port
    this.apiPort = options.apiPort
    this.apiSecret = options.apiSecret
    this.binary = options.binary
    this.configPath = options.configPath
    this.logPath = options.logPath
    this.stateFile = options.stateFile
    this.pidFile = options.pidFile
    this.workDir = options.workDir
    this.onLog = options.onLog
    /** Called with a human-readable line when the process dies or recovers. */
    this.onEvent = options.onEvent ?? (() => {})
    /** Set while stop() is running, so an intentional kill is not treated as a crash. */
    this.stopping = false
    this.child = null
    this.starting = null
    this.startedAt = 0
    this.restarts = 0
    /** Bounded restart ladder: three attempts, then give up and stay DOWN. */
    this.restartDelaysMs = options.restartDelaysMs ?? [5000, 15000, 45000]
    this.autoRestart = options.autoRestart !== false
  }

  /** Write DOWN the moment the process dies, so the shim stops injecting a dead proxy. */
  async markDown() {
    await writeState(this.stateFile, DOWN)
  }

  /** Whether the plugin, not the OS, believes the kernel should be up. */
  async state() {
    return readState(this.stateFile)
  }

  async pid() {
    try {
      const raw = (await readFile(this.pidFile, 'utf8')).trim()
      const value = Number(raw)
      return Number.isInteger(value) && value > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  async isListening() {
    return probePort(this.port)
  }

  /**
   * Whether the pid file names a live process that really is this kernel. A live pid
   * whose image name differs is treated as someone else's process (pid reuse), so it is
   * never killed.
   */
  async ownsPidFile() {
    const pid = await this.pid()
    if (pid === undefined || !isAlive(pid)) return { owns: false, pid, alive: false }
    const image = await pidImage(pid)
    if (image === undefined) return { owns: true, pid, alive: true, unverified: true }
    const expected = basename(this.binary).toLowerCase()
    return { owns: image.toLowerCase() === expected, pid, alive: true, image, expected }
  }

  /**
   * Kill a kernel this plugin previously started but that is no longer wanted (a dead
   * DSH, or a listener on a port we are moving away from). Only ever targets a process
   * proven to be ours by image name.
   */
  async cleanOrphan() {
    const owned = await this.ownsPidFile()
    if (owned.owns) {
      try {
        process.kill(owned.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    await rm(this.pidFile, { force: true })
    await writeState(this.stateFile, DOWN)
  }

  async ensureStarted(options = {}) {
    if (this.starting !== null) return this.starting
    this.starting = this.#start(options).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async #start({ signal, onProgress } = {}) {
    if (await this.isListening()) {
      const owned = await this.ownsPidFile()
      if (owned.owns) {
        // Our kernel is already serving this port; reuse it.
        await writeState(this.stateFile, UP)
        return { started: false, reason: 'already-listening', port: this.port, pid: owned.pid }
      }
      // Something else is listening. Reporting success here would mark the state UP and
      // send every `proxy` command to a stranger's process, so fail loudly instead.
      throw new Error(
        `端口 ${this.port} 已被其他程序占用，本插件的内核无法启动。` +
          '请在「设置 → 代理管家」中改用其他端口。',
      )
    }

    await this.cleanOrphan()

    if (!(await fileExists(this.binary))) {
      const fetched = await ensureKernel(await ensureRoot(), { signal, onProgress })
      const extracted = await this.#extract(fetched.zipPath, this.binary)
      if (extracted !== undefined) return extracted
    }

    // GeoIP data only affects routing (the GEOIP,CN rule); failing here must not stop
    // the kernel from starting.
    await ensureGeoAssets({ root: dirname(this.binary) }, { signal }).catch(() => undefined)

    await writeState(this.stateFile, DOWN)
    const child = spawn(this.binary, ['-d', this.workDir, '-f', this.configPath], {
      cwd: this.workDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    if (this.onLog !== undefined) {
      const forward = (chunk) => this.onLog(String(chunk).trimEnd())
      child.stdout?.on('data', forward)
      child.stderr?.on('data', forward)
    }

    // Two listeners on purpose. `exited` resolves the startup wait; the persistent
    // handler below covers a crash at ANY time, which the startup wait alone never saw —
    // previously a running kernel could die and the state file stayed UP, so every
    // `proxy` command kept injecting a proxy nobody was listening on.
    const exited = new Promise((resolve) => {
      child.once('exit', (code) => {
        if (this.child === child) this.child = null
        resolve(code)
      })
      child.once('error', () => {
        if (this.child === child) this.child = null
        resolve(-1)
      })
    })
    child.once('exit', (code) => {
      void this.#handleExit(child, code)
    })

    if (typeof child.pid === 'number') {
      await writeFile(this.pidFile, `${child.pid}\n`, 'utf8')
    }

    // Poll rather than trust a delay: startup time varies with config size.
    const deadline = Date.now() + 15000
    for (;;) {
      if (await this.isListening()) {
        this.startedAt = Date.now()
        await writeState(this.stateFile, UP)
        return { started: true, port: this.port, pid: child.pid }
      }
      const settled = await Promise.race([
        exited.then((code) => ({ code })),
        new Promise((resolve) => setTimeout(() => resolve(null), 250)),
      ])
      if (settled !== null) {
        await writeState(this.stateFile, DOWN)
        await rm(this.pidFile, { force: true })
        throw new Error(
          `内核启动后立即退出 (exit ${settled.code})。请检查配置与内核版本是否匹配；` +
            `日志: ${this.logPath}`,
        )
      }
      if (Date.now() > deadline) {
        await this.stop()
        throw new Error(`内核在 15 秒内未开始监听 ${this.port}，已停止。请检查 ${this.logPath}`)
      }
    }
  }

  /**
   * Layer 3: the process died. The state file must go DOWN immediately — that is the
   * minimum fix — and then a bounded restart ladder runs. Restarting is deliberately
   * capped: a kernel that cannot stay up (bad config, version mismatch, corrupt binary)
   * will not be fixed by trying forever, and a restart loop would burn CPU silently.
   */
  async #handleExit(child, code) {
    if (this.stopping) return
    if (this.child !== child && this.child !== null) return
    try {
      await this.markDown()
      await rm(this.pidFile, { force: true })
    } catch {
      // Even a failed bookkeeping write must not block recovery.
    }

    // A long healthy run means the earlier attempts are irrelevant.
    const uptimeMs = this.startedAt === 0 ? 0 : Date.now() - this.startedAt
    if (uptimeMs > 60000) this.restarts = 0

    this.onEvent(`内核进程退出 (exit ${code})，状态已标记为不可用`)

    if (!this.autoRestart) return
    if (this.restarts >= this.restartDelaysMs.length) {
      this.onEvent(`内核已连续退出 ${this.restarts} 次，停止自动重启。请检查 ${this.logPath}`)
      return
    }
    const delay = this.restartDelaysMs[this.restarts]
    this.restarts += 1
    this.onEvent(`将在 ${Math.round(delay / 1000)}s 后尝试第 ${this.restarts} 次重启`)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delay)
      if (typeof timer.unref === 'function') timer.unref()
    })
    if (this.stopping) return
    try {
      await this.ensureStarted()
      this.onEvent('内核已自动重启')
    } catch (error) {
      this.onEvent(`自动重启失败：${error.message}`)
    }
  }

  /** mihomo ships a zip; bsdtar understands it and is present on Windows 10+. */
  async #extract(zipPath, target) {    if (zipPath === undefined) return undefined
    const staging = `${target}.staging`
    await rm(staging, { recursive: true, force: true })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(staging, { recursive: true })
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-xf', zipPath, '-C', staging], { windowsHide: true })
      tar.once('error', reject)
      tar.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`解压失败 (tar exit ${code})`))
      })
    })
    const { readdir, rename } = await import('node:fs/promises')
    const entries = await readdir(staging)
    const exe = entries.find((name) => name.toLowerCase().endsWith('.exe'))
    if (exe === undefined) {
      throw new Error(`压缩包内未找到可执行文件：${entries.join(', ') || '(空)'}`)
    }
    await rename(join(staging, exe), target)
    await rm(staging, { recursive: true, force: true })
    await rm(zipPath, { force: true })
    return undefined
  }

  async stop() {
    // Tell the exit handler this is intentional, so it neither marks a crash nor restarts.
    this.stopping = true
    if (this.child !== null && typeof this.child.pid === 'number') {
      try {
        this.child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      this.child = null
    } else {
      // Only a process proven to be this kernel is killed; a reused pid must survive.
      const owned = await this.ownsPidFile()
      if (owned.owns) {
        try {
          process.kill(owned.pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
    await rm(this.pidFile, { force: true })
    await writeState(this.stateFile, DOWN)
  }
}

export async function createKernel(options, env = process.env) {
  const dirs = await ensureRoot(env)
  return new Kernel({
    ...options,
    workDir: dirs.root,
    logPath: dirs.logs,
    stateFile: dirs.state,
    pidFile: dirs.pid,
    configPath: options.configPath ?? dirs.config,
    binary: options.binary ?? dirs.kernel,
  })
}

export { paths, stat }
