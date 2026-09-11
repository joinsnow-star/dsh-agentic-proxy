/**
 * Automatic node failover.
 *
 * The plugin holds no traffic (the agent's shell points HTTPS_PROXY straight at the
 * kernel), so "switch nodes" can only mean "make the kernel pick again". This module is
 * therefore a controller loop, not a proxy.
 *
 * Two endpoints are read on every poll, because measurement showed they carry different
 * things:
 *   GET /proxies                    -> the group's membership, `now` and `fixed`
 *   GET /providers/proxies/{name}   -> per-node `alive` and measured delays
 * A provider-supplied node keeps `alive: undefined` in the global view even after a
 * forced re-test (measured), so health must come from the provider endpoint. Inline
 * (non-provider) nodes appear only in the global view, so membership health merges both.
 *
 * Decisions are scoped to the GROUP's membership, not the whole subscription: a group may
 * expose a subset, so the members come from the group and the health from the provider.
 * The one lever is `GET /group/{g}/delay`; see `api.js` for why pinning is deliberately
 * not used.
 *
 * Layers (see FAILOVER.md):
 *   1. prime()    measure once at startup. Until then nodes read `alive: true` with an
 *                 EMPTY history, which is not evidence of anything.
 *   2. tick()     notice when the selected node is known dead, and escalate — throttled.
 *   4. recover()  when nothing in the group is alive, re-fetch the subscription.
 *
 * Layer 3 (the process dying) is kernel.js's job; it owns the process.
 */
import { classifyProvider, groupView } from './api.js'

export const STATE_UP = 'UP'
export const STATE_DEGRADED = 'DEGRADED'

export class Watchdog {
  constructor(options) {
    this.api = options.api
    this.group = options.group
    this.provider = options.provider
    this.testUrl = options.testUrl
    /** How often to read state; both calls are small and local. */
    this.pollMs = options.pollMs ?? 20000
    /** Minimum gap between escalations, so a broken subscription cannot cause churn. */
    this.escalateMs = options.escalateMs ?? 60000
    /** How long an unmeasured group is tolerated before forcing a measurement. */
    this.untestedGraceMs = options.untestedGraceMs ?? 30000
    this.onState = options.onState ?? (() => {})
    this.onEvent = options.onEvent ?? (() => {})
    this.timer = null
    this.stopped = true
    this.lastEscalateAt = 0
    this.lastRecoverAt = 0
    this.untestedSince = 0
    this.state = STATE_UP
    this.last = null
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    void this.prime()
    this.#schedule()
  }

  async stop() {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  #schedule() {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.#schedule())
    }, this.pollMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /**
   * Merge the two views into per-member health for THIS group.
   *
   * A member's state comes from provider health when the provider knows it, and from the
   * global view otherwise (inline nodes). `delay === 0` means measured-and-failed; a
   * missing measurement means untested, never dead.
   */
  async snapshot() {
    const all = await this.api.proxies()
    const group = groupView(all, this.group)
    const health = classifyProvider(await this.api.providerProxies(this.provider), this.testUrl)

    const members = group.members.map((name) => {
      const fromProvider = health.byName.get(name)
      if (fromProvider !== undefined) return { name, state: fromProvider.state, delay: fromProvider.delay }
      const entry = all[name]
      if (entry === undefined) return { name, state: 'untested', delay: null }
      if (entry.alive === false) return { name, state: 'dead', delay: null }
      const delay = lastHistoryDelay(entry.history)
      if (delay === null) return { name, state: 'untested', delay: null }
      return { name, state: delay === 0 ? 'dead' : 'alive', delay }
    })

    const aliveMembers = members.filter((m) => m.state === 'alive').sort((a, b) => a.delay - b.delay)
    const nowState = group.now === undefined ? null : members.find((m) => m.name === group.now) ?? null

    return {
      group,
      providerTotal: health.total,
      members,
      aliveMembers,
      alive: aliveMembers.length,
      dead: members.filter((m) => m.state === 'dead').length,
      untested: members.filter((m) => m.state === 'untested').length,
      nowState,
    }
  }

  /**
   * Layer 1. Measure once so the startup view stops lying.
   *
   * Without this every node reads `alive: true` with an empty history, so a subscription
   * whose nodes are all unreachable looks perfectly healthy and the first selection is
   * arbitrary. Measured effect: 30 untested -> 26 alive / 4 dead, with real delays.
   */
  async prime() {
    try {
      const first = await this.snapshot()
      if (first.members.length === 0 || first.untested === 0) return
      this.onEvent(`启动后开始首次测速（${first.members.length} 个节点）…`)
      await this.api.healthcheckProvider(this.provider)
      this.last = await this.snapshot()
      this.onEvent(`首次测速完成：${this.last.alive} 个可用`)
      await this.#publish()
    } catch (error) {
      this.onEvent(`启动测速失败：${error.message}`)
    }
  }

  /** Layer 2. Decide from measurement; escalate only for a node known dead. */
  async tick() {
    if (this.stopped) return
    try {
      const snap = await this.snapshot()
      this.last = snap

      if (snap.members.length === 0) return // provider has not produced nodes yet

      // Nothing usable and at least one confirmed failure: switching cannot help.
      //
      // DEGRADED is published BEFORE attempting recovery. Recovery costs a provider
      // re-fetch plus a full health check (measured: ~750ms + ~8s), and during that whole
      // window the shim would otherwise keep injecting a proxy that cannot work. Announcing
      // the failure first is what makes the fallback immediate.
      if (snap.alive === 0 && snap.dead > 0) {
        await this.#publish(true)
        await this.recover(snap)
        return
      }

      if (snap.nowState?.state === 'alive') {
        this.untestedSince = 0
        await this.#publish()
        return
      }

      if (snap.nowState === null || snap.nowState.state === 'untested') {
        // "Never measured" is not failure. Allow a grace period, then measure.
        if (this.untestedSince === 0) this.untestedSince = Date.now()
        if (Date.now() - this.untestedSince > this.untestedGraceMs) {
          this.untestedSince = 0
          await this.#escalate(snap, '当前节点尚未测速')
        } else {
          await this.#publish()
        }
        return
      }

      // nowState.state === 'dead'
      this.untestedSince = 0
      await this.#escalate(snap, `当前节点「${snap.group.now}」已失效`)
    } catch (error) {
      // A controller hiccup is not a node problem; kernel.js owns process health.
      this.onEvent(`状态轮询失败：${error.message}`)
    }
  }

  async #escalate(snap, reason) {
    const since = Date.now() - this.lastEscalateAt
    if (since < this.escalateMs) {
      this.onEvent(`${reason}；${Math.ceil((this.escalateMs - since) / 1000)}s 内已处理过，暂不重复`)
      await this.#publish()
      return
    }
    this.lastEscalateAt = Date.now()
    this.onEvent(reason)

    try {
      // (a) Re-measure. A url-test group re-selects as a side effect.
      await this.api.retestGroup(this.group, this.testUrl)
      const after = await this.snapshot()
      this.last = after

      if (after.nowState?.state === 'alive') {
        this.onEvent(`已重新测速并切换到「${after.group.now}」`)
        await this.#publish()
        return
      }

      // (b) Still nothing healthy selected.
      //
      //     Do NOT try to force a choice by pinning. Measured on this kernel: for a
      //     `url-test` group, `PUT /proxies/{g}` stores `fixed` but the kernel IGNORES it
      //     for selection — with `fixed` naming a dead node, traffic still flowed to a live
      //     one (204 in ~305ms). Announcing a switch that did not happen is worse than
      //     admitting the re-test did not help, so say so plainly and let the next tick
      //     decide. This branch always has `alive > 0`: the `alive === 0` case is handled
      //     earlier in tick(), which is the only caller that can reach DEGRADED.
      this.onEvent(`重新测速后仍未自动切换到可用节点（当前「${after.group.now}」）`)
      await this.#publish()
    } catch (error) {
      this.onEvent(`切换失败：${error.message}`)
      await this.#publish()
    }
  }

  /**
   * Layer 4. With no usable member, switching is pointless; the only recovery is a fresh
   * node list, since an airport may have rotated addresses.
   */
  async recover(snap) {
    const since = Date.now() - this.lastRecoverAt
    if (since < this.escalateMs * 5) {
      await this.#publish(true)
      return
    }
    this.lastRecoverAt = Date.now()
    this.onEvent('本组所有节点均不可用，正在重新拉取订阅…')

    try {
      await this.api.refreshProvider(this.provider)
      await this.api.healthcheckProvider(this.provider)
      const after = await this.snapshot()
      this.last = after
      if (after.alive > 0) {
        this.onEvent(`重新拉取订阅后恢复，现有 ${after.alive} 个可用节点`)
        await this.#publish()
        return
      }
      this.onEvent(`重新拉取订阅后仍无可用节点（${snap.members.length} 个节点全部失败）`)
    } catch (error) {
      this.onEvent(`重新拉取订阅失败：${error.message}`)
    }
    await this.#publish(true)
  }

  /**
   * Publish UP or DEGRADED.
   *
   * DEGRADED is written only when every member has been MEASURED and failed — never while
   * any member is merely unmeasured — because a wrong DEGRADED would silently send
   * proxied traffic direct.
   */
  async #publish(forceDegraded = false) {
    const snap = this.last
    let next = STATE_UP
    if (forceDegraded) {
      next = STATE_DEGRADED
    } else if (
      snap !== null &&
      snap.members.length > 0 &&
      snap.alive === 0 &&
      snap.dead > 0 &&
      snap.untested === 0
    ) {
      next = STATE_DEGRADED
    }
    if (next !== this.state) {
      this.state = next
      this.onState(next)
      if (next === STATE_DEGRADED) {
        this.onEvent(`全部 ${snap?.members.length ?? 0} 个节点均不可用，代理命令将回退为直连`)
      }
    }
  }

  /** Snapshot for the settings page. */
  describe() {
    const snap = this.last
    return {
      state: this.state,
      group: this.group,
      provider: this.provider,
      total: snap?.members.length ?? 0,
      alive: snap?.alive ?? 0,
      dead: snap?.dead ?? 0,
      untested: snap?.untested ?? 0,
      now: snap?.group.now ?? '',
      nowState: snap?.nowState?.state ?? 'unknown',
      pinned: snap?.group.fixed ?? '',
      nodes: (snap?.aliveMembers ?? []).slice(0, 30).map((n) => ({
        name: n.name,
        ms: Number.isFinite(n.delay) ? Math.round(n.delay) : null,
      })),
    }
  }
}

/** Newest delay from a history array; null when nothing was ever recorded. */
function lastHistoryDelay(history) {
  const list = Array.isArray(history) ? history : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const delay = Number(list[i]?.delay)
    if (Number.isFinite(delay)) return delay
  }
  return null
}
