/**
 * Generates the `proxy.cmd` shim that gives the Agent its one explicit switch:
 *
 *     proxy npm install
 *
 * The harness offers no way to rewrite an already-issued command (`PreToolDecision`
 * is allow/deny/ask only), so the switch has to be a real command on the child PATH.
 * That keeps the log honest — what the Agent wrote is what ran — and leaves the
 * command inside the Agent's own shell and sandbox.
 *
 * A bare command is already direct, so there is no `proxy direct` form: not using the
 * shim IS the direct path. That also avoids a cmd.exe trap — `shift` does not affect
 * `%*`, so stripping a leading keyword would mean reassembling the arguments and
 * losing the quoting of values like `"https://a b"`.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MARKER, shimDirs, paths } from './paths.js'

export const SHIM_NAME = 'proxy.cmd'

/**
 * Liveness is read from a state file rather than probed, because probing would mean
 * spawning PowerShell on every proxied command. The plugin owns the file and rewrites
 * it on every kernel transition, so a stale UP only survives a hard DSH crash.
 */
export function renderShim({ port, stateFile }) {
  const url = `http://127.0.0.1:${port}`
  // Messages are ASCII on purpose: cmd.exe reads a .cmd file in the OEM codepage, so
  // non-ASCII text here reaches the agent as mojibake. UTF-8 belongs in the settings
  // page, which is rendered by the browser.
  return [
    '@echo off',
    `rem ${MARKER} - safe to delete; regenerated on plugin start`,
    'setlocal enableextensions',
    `set "PX_STATE_FILE=${stateFile}"`,
    `set "PX_URL=${url}"`,
    '',
    'set "PX_UP=DOWN"',
    'if exist "%PX_STATE_FILE%" set /p PX_UP=<"%PX_STATE_FILE%"',
    '',
    'if /i "%PX_UP%"=="UP" goto :with_proxy',
    // DEGRADED: the kernel is alive but no node works. Proxying would fail anyway, so a
    // direct attempt is strictly more useful — and the warning says so explicitly.
    'if /i "%PX_UP%"=="DEGRADED" goto :degraded',
    'echo [proxy] kernel is not running; continuing WITHOUT a proxy. Start it in DSH Settings - Proxy Manager. 1>&2',
    'goto :run',
    '',
    ':degraded',
    'echo [proxy] no working node right now; continuing WITHOUT a proxy. 1>&2',
    'goto :run',
    '',
    ':with_proxy',
    'set "HTTP_PROXY=%PX_URL%"',
    'set "HTTPS_PROXY=%PX_URL%"',
    'set "ALL_PROXY=%PX_URL%"',
    'set "http_proxy=%PX_URL%"',
    'set "https_proxy=%PX_URL%"',
    'set "all_proxy=%PX_URL%"',
    'set "NO_PROXY=localhost,127.0.0.1,::1"',
    'set "no_proxy=localhost,127.0.0.1,::1"',
    '',
    ':run',
    'if "%~1"=="" (echo Usage: proxy ^<command^>  ^(example: proxy npm install^) 1>&2 & exit /b 2)',
    '%*',
    'set "PX_RC=%ERRORLEVEL%"',
    'exit /b %PX_RC%',
    '',
  ].join('\r\n')
}

async function isOurs(file) {
  try {
    return (await readFile(file, 'utf8')).includes(MARKER)
  } catch {
    return false
  }
}

/** Install into the first writable directory that is already on PATH. */
export async function installShim(env, { port, stateFile }) {
  const body = renderShim({ port, stateFile: stateFile ?? paths(env).state })
  const tried = []
  for (const dir of shimDirs(env)) {
    const target = join(dir, SHIM_NAME)
    try {
      await mkdir(dir, { recursive: true })
      // Never clobber a same-named command we did not write.
      const existing = await isOurs(target)
      if (!(await exists(target)) || existing) {
        await writeFile(target, body, 'utf8')
        return { installed: true, path: target, dir }
      }
      tried.push(`${dir} (已存在同名命令且非本插件生成，跳过)`)
    } catch (error) {
      tried.push(`${dir} (${error.code ?? error.message})`)
    }
  }
  return { installed: false, tried }
}

/**
 * The shim this plugin previously installed, if any.
 *
 * Installation is a manual step (the settings page's button), so a restart cannot assume
 * either state: it must rediscover what is on PATH before deciding whether the Agent may be
 * told that a `proxy` command exists.
 */
export async function findShim(env) {
  for (const dir of shimDirs(env)) {
    const target = join(dir, SHIM_NAME)
    if (await isOurs(target)) return { path: target, dir }
  }
  return null
}

async function exists(file) {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}

/** Remove only a shim we wrote, and only if its content still carries our marker. */
export async function removeShim(env) {
  const removed = []
  for (const dir of shimDirs(env)) {
    const target = join(dir, SHIM_NAME)
    if (await isOurs(target)) {
      await rm(target, { force: true })
      removed.push(target)
    }
  }
  return removed
}
