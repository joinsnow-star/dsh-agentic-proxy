/**
 * Thin client for the kernel's external-controller API.
 *
 * The plugin is not on the traffic path, so this is the ONLY way it can observe node
 * health or change the kernel's selection. Endpoint costs were measured (see FAILOVER.md):
 *
 *   GET /proxies                              ~8ms   cheap, safe to poll
 *   GET /group/{g}/delay                      ~5s    forces immediate re-test + re-select
 *   PUT /providers/proxies/{name}             ~750ms forces a subscription re-fetch
 *   GET /providers/proxies/{name}/healthcheck ~7s    forces a full health check
 *
 * Deliberately absent: `PUT /proxies/{g}` (pin a node). Measured on this kernel: for a
 * `url-test` group the controller stores `fixed` but the kernel IGNORES it for selection —
 * with `fixed` naming a known-dead node, traffic still reached the internet through a live
 * one (HTTP 204 in ~305ms). There is no way to force a url-test group's choice, so the
 * only lever is `/group/{g}/delay`. `pin`/`unpin` were removed rather than kept as a no-op
 * that would make the watchdog look like it switched something.
 */

/** A hung controller must never stall the watchdog, so every call is bounded. */
const DEFAULT_TIMEOUT_MS = 8000

export class KernelApi {
  constructor({ port, secret, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.base = `http://127.0.0.1:${port}`
    this.secret = secret
    this.timeoutMs = timeoutMs
  }

  async #call(method, path, body, timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs ?? this.timeoutMs)
    const init = {
      method,
      signal,
      headers: { Authorization: `Bearer ${this.secret}` },
    }
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(`${this.base}${path}`, init)
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} ${text.slice(0, 120)}`)
    return text === '' ? undefined : text
  }

  async #json(path) {
    const text = await this.#call('GET', path)
    return text === undefined ? {} : JSON.parse(text)
  }

  /** Whether the controller answers at all. Used to tell "kernel up" from "kernel gone". */
  async alive() {
    try {
      await this.#call('GET', '/version', undefined, 2000)
      return true
    } catch {
      return false
    }
  }

  async version() {
    return await this.#json('/version')
  }

  /** All proxies and groups, keyed by name. 8ms — used for the group's `now`/`fixed`. */
  async proxies() {
    return (await this.#json('/proxies')).proxies ?? {}
  }

  /**
   * The provider view, which is the ONLY place per-node health is exposed.
   *
   * Measured: `GET /proxies` leaves every provider-supplied node at `alive: undefined`
   * even after forcing a re-test, while this endpoint reports real `alive` flags and
   * per-URL history. Returns the raw parsed body; classifyProvider interprets it.
   */
  async providerProxies(provider) {
    return await this.#json(`/providers/proxies/${encodeURIComponent(provider)}`)
  }

  /** Force an immediate latency test; a `url-test` group re-selects as a side effect. */
  async retestGroup(group, testUrl, timeoutMs = 5000) {
    const query = `?url=${encodeURIComponent(testUrl)}&timeout=${timeoutMs}`
    const text = await this.#call('GET', `/group/${encodeURIComponent(group)}/delay${query}`, undefined, timeoutMs * 3 + 5000)
    return text === undefined ? {} : JSON.parse(text)
  }

  /** Re-fetch the subscription. The only recovery when every node is dead. */
  async refreshProvider(provider) {
    await this.#call('PUT', `/providers/proxies/${encodeURIComponent(provider)}`)
  }

  /** Force a health check across the whole provider. */
  async healthcheckProvider(provider) {
    await this.#call('GET', `/providers/proxies/${encodeURIComponent(provider)}/healthcheck`, undefined, 30000)
  }
}

/**
 * Interpret one group's membership for `now` / `fixed`.
 *
 * Note this deliberately does NOT judge node health: measured on this kernel, the global
 * `/proxies` view reports `alive: undefined` for every provider-supplied node. Health
 * comes from classifyProvider instead. The `alive`/`dead` counters here exist only for
 * inline (non-provider) nodes, which do carry them.
 */
export function groupView(proxies, groupName) {
  const group = proxies[groupName]
  if (group === undefined) {
    return { present: false, total: 0, now: undefined, fixed: '', members: [] }
  }
  const members = Array.isArray(group.all) ? group.all : []
  return {
    present: true,
    total: members.length,
    members,
    now: group.now,
    fixed: typeof group.fixed === 'string' ? group.fixed : '',
  }
}

/**
 * Per-node health from the provider view.
 *
 * A node is classified by MEASUREMENT, not by its `alive` flag alone. Measured: right
 * after load the provider reports `alive: true` for all 30 nodes while their `extra`
 * (the per-test-URL history) is still EMPTY. Treating that as healthy would hide a
 * subscription whose nodes are all unreachable, so a node counts as usable only once a
 * positive delay has actually been recorded.
 *
 *   alive    alive === true AND a positive delay exists
 *   dead     alive === false, or a recorded delay of 0
 *   untested no measurement yet
 */
export function classifyProvider(providerBody, testUrl) {
  const list = Array.isArray(providerBody?.proxies) ? providerBody.proxies : []
  const byName = new Map()
  const aliveNodes = []
  let alive = 0
  let dead = 0
  let untested = 0

  for (const entry of list) {
    const name = entry?.name
    if (typeof name !== 'string' || name.length === 0) continue
    const extra = entry?.extra ?? {}
    const perUrl = extra[testUrl] ?? Object.values(extra)[0]
    const delay = lastDelay(perUrl?.history)

    let state
    if (entry?.alive === false || delay === 0) state = 'dead'
    else if (delay === null) state = 'untested'
    else state = 'alive'

    byName.set(name, { state, delay })
    if (state === 'alive') {
      alive += 1
      aliveNodes.push({ name, delay })
    } else if (state === 'dead') dead += 1
    else untested += 1
  }

  aliveNodes.sort((a, b) => a.delay - b.delay)
  return {
    total: list.length,
    alive,
    dead,
    untested,
    byName,
    aliveNodes,
    /** True once every node has a real measurement. */
    fullyMeasured: list.length > 0 && untested === 0,
  }
}

/** Most recent delay, with 0 meaning "measured and failed". Null means never measured. */
function lastDelay(history) {
  const list = Array.isArray(history) ? history : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const delay = Number(list[i]?.delay)
    if (Number.isFinite(delay)) return delay
  }
  return null
}
