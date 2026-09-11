/**
 * Everything that touches the filesystem lives under one root, so the plugin has a
 * single place to create, inspect and remove. Nothing outside this directory is
 * written except the PATH shim, which carries a marker for that reason.
 */
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Marker written into every generated file, so cleanup can prove ownership. */
export const MARKER = '@generated-by-dsh-proxy'

/** Resolve DSH_HOME the same way the harness does, falling back to ~/.dsh. */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.length > 0) return configured
  return join(homedir(), '.dsh')
}

export function rootDir(env = process.env) {
  return join(dshHome(env), 'dyn-proxy')
}

export function paths(env = process.env) {
  const root = rootDir(env)
  return {
    root,
    kernel: join(root, 'mihomo.exe'),
    config: join(root, 'config.yaml'),
    logs: join(root, 'kernel.log'),
    /** Records the running kernel so a later start can detect an orphan. */
    pid: join(root, 'kernel.pid'),
    /**
     * First line is UP or DOWN. The shim reads it with `set /p`, which takes only the
     * first line, so liveness costs a file read instead of spawning a probe process.
     */
    state: join(root, 'kernel.state'),
  }
}

export async function ensureRoot(env = process.env) {
  const dirs = paths(env)
  await mkdir(dirs.root, { recursive: true })
  return dirs
}

/**
 * Directories that are already on the child PATH and writable, in preference order.
 * A shim can only be installed into one of these: the harness gives plugins no way to
 * extend PATH, and a user-level PATH edit would need a DSH restart to be seen.
 */
export function shimDirs(env = process.env) {
  const home = homedir()
  const appData = env.APPDATA
  const candidates = [
    join(home, '.local', 'bin'),
    typeof appData === 'string' && appData.length > 0 ? join(appData, 'npm') : undefined,
    join(home, '.bun', 'bin'),
  ]
  return candidates.filter((value) => typeof value === 'string' && value.length > 0)
}
