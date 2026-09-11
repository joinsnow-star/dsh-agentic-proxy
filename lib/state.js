/**
 * The state file the shim reads on every proxied command.
 *
 * It holds exactly three values, and the distinction between the last two is the whole
 * point of having a third state:
 *
 *   UP        kernel running, at least one node usable -> inject the proxy
 *   DEGRADED  kernel running, but no node works        -> warn, run direct
 *   DOWN      kernel not running                        -> warn, run direct
 *
 * Only the first line matters: the shim reads it with `set /p`, which lets liveness be a
 * file read instead of spawning a probe process on every command.
 */
import { readFile, writeFile } from 'node:fs/promises'

export const UP = 'UP'
export const DEGRADED = 'DEGRADED'
export const DOWN = 'DOWN'

const VALID = new Set([UP, DEGRADED, DOWN])

export async function writeState(file, value) {
  if (!VALID.has(value)) throw new Error(`invalid kernel state: ${value}`)
  await writeFile(file, `${value}\n`, 'utf8')
}

export async function readState(file) {
  try {
    const text = await readFile(file, 'utf8')
    const first = text.split(/\r?\n/)[0].trim()
    return VALID.has(first) ? first : DOWN
  } catch {
    return DOWN
  }
}
