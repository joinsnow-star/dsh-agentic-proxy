// dsh-agentic-proxy — client half.
//
// Hand-written, zero build tools. The loader fetches this with a classic <script src>,
// so it must be a CLASSIC SCRIPT: no import/export, no top-level await.
//
// Contract (from @deepseek-ai/dsh-client-modules, types/client/manifest.d.ts):
//   window.__ModuleLoader__.load({ id, factory })
//   factory(require) -> exports   // must carry `apply`, optionally `inject`/`name`
// Only seed-table specifiers may be required; anything else throws at materialization.
//
// Two different `inject`s exist and are easy to confuse:
//   - package.json `dsh.client.inject`  = package names (graph ordering)
//   - exports.inject                    = cordis service names (what apply() may read)
window.__ModuleLoader__.load({
  id: 'dsh-agentic-proxy',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    // The loader only *inventories* <style data-plugin> tags after materialization, so a
    // plugin must inject its own CSS; there is no styles service here.
    var RPC = '/__dsh-agentic-proxy/rpc'
    var STYLE_ID = 'dsh-agentic-proxy-style'
    var CSS = [
      '.dxp{display:flex;flex-direction:column;gap:12px;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dxp .c{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:8px}',
      '.dxp .l,.dxp .d{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.dxp .ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}',
      '.dxp .x{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.dxp .i{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px}',
      '.dxp .r{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.dxp button{padding:6px 13px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:12px}',
      '.dxp button:disabled{opacity:.5;cursor:default}',
      '.dxp .p{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
    ].join('')

    function call(method, args) {
      return fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, args: args === undefined ? {} : args }),
      }).then(function (res) {
        return res.json().then(function (payload) {
          if (payload && payload.ok === false) throw new Error(payload.error || '调用失败')
          return payload ? payload.value : null
        })
      })
    }

    function Page() {
      var s0 = react.useState(null)
      var st = s0[0]
      var setSt = s0[1]
      var s1 = react.useState('')
      var sub = s1[0]
      var setSub = s1[1]
      var s2 = react.useState('')
      var kernelPath = s2[0]
      var setKernelPath = s2[1]
      var s3 = react.useState(true)
      var autoStart = s3[0]
      var setAutoStart = s3[1]
      var s4 = react.useState(false)
      var busy = s4[0]
      var setBusy = s4[1]
      var s5 = react.useState('')
      var msg = s5[0]
      var setMsg = s5[1]

      function apply(status) {
        if (!status || !status.config) return
        var cfg = JSON.parse(status.config)
        setSt(status)
        setSub(cfg.subscribeUrl)
        setKernelPath(cfg.kernelPath)
        setAutoStart(cfg.autoStart !== false)
      }

      function go(method, args) {
        setBusy(true)
        setMsg('')
        return call(method, args)
          .then(function (r) {
            apply(r)
            return r
          })
          .catch(function (e) {
            setMsg('错误：' + String((e && e.message) || e))
            return null
          })
          .then(function (r) {
            setBusy(false)
            return r
          })
      }

      react.useEffect(function () {
        go('status', {})
      }, [])

      var children = []
      children.push(
        h('div', { className: 'd', key: 'i' },
          '让 Agent 以 ',
          h('code', null, 'proxy <命令>'),
          ' 的方式按需走代理（例如 ',
          h('code', null, 'proxy npm install'),
          '）。内核由本插件自行安装与启动，不依赖你机器上已有的代理软件。'),
      )
      if (msg) children.push(h('div', { className: 'x', key: 'm' }, msg))

      if (st) {
        var stateLines = [
          h('div', { key: '1', className: st.listening ? 'ok' : 'd' },
            st.listening ? '内核正在监听' : '内核未运行',
            h('span', { className: 'd' }, '（端口 ' + JSON.parse(st.config).port + '）')),
          h('div', { key: '2', className: 'd' }, '内核文件：' + (st.kernel && st.kernel.installed ? '已安装' : '尚未安装（首次启动时自动下载）')),
          h('div', { key: '3', className: 'd' }, st.shim && st.shim.installed ? '命令前缀已安装：proxy' : '命令前缀未安装（点下方按钮安装）'),
          h('div', { key: '4', className: 'd' }, '数据目录：' + st.root),
        ]
        // Node health is the part a user needs when requests start failing.
        var f = st.failover
        if (f) {
          var tone = f.alive > 0 ? 'ok' : (f.total > 0 ? 'x' : 'd')
          stateLines.push(h('div', { key: '5', className: tone },
            '节点：' + f.alive + ' 可用 / ' + f.dead + ' 失效 / ' + f.untested + ' 未测（共 ' + f.total + '）'))
          if (f.now) stateLines.push(h('div', { key: '6', className: 'd' }, '当前节点：' + f.now + (f.pinned ? '（已临时指定）' : '')))
          if (f.nodes && f.nodes.length) {
            var top = f.nodes.slice(0, 5).map(function (n) {
              return n.name + (n.ms === null ? '' : '(' + n.ms + 'ms)')
            })
            stateLines.push(h('div', { key: '7', className: 'd' }, '最快：' + top.join('、')))
          }
          if (f.total > 0 && f.alive === 0 && f.dead === f.total) {
            stateLines.push(h('div', { key: '8', className: 'x' }, '所有节点均不可用：代理命令已回退为直连。'))
          } else if (f.untested === f.total && f.total > 0) {
            stateLines.push(h('div', { key: '9', className: 'd' }, '尚未测速：启动后会自动完成首次测速。'))
          }
        }
        if (st.lastError) stateLines.push(h('div', { key: 'e', className: 'x' }, st.lastError))
        children.push(h('div', { className: 'c', key: 'state' }, stateLines))
      }

      children.push(
        h('div', { className: 'c', key: 'cfg' }, [
          h('div', { className: 'l', key: 'l1' }, '订阅链接（Clash / mihomo 格式）'),
          h('input', {
            key: 'i1',
            className: 'i',
            value: sub,
            placeholder: 'https://example.com/api/v1/client/subscribe?token=...',
            onChange: function (e) { setSub(e.target.value) },
          }),
          h('div', { className: 'd', key: 'l2' }, '节点由内核自行拉取、测速与切换；本插件不解析订阅，也不自己给节点排序。'),
          h('div', { className: 'l', key: 'l3' }, '内核路径（留空 = 使用插件自动下载的内核）'),
          h('input', {
            key: 'i2',
            className: 'i',
            value: kernelPath,
            placeholder: '留空即可',
            onChange: function (e) { setKernelPath(e.target.value) },
          }),
          h('label', { className: 'r', key: 'l4' }, [
            h('input', {
              key: 'c1',
              type: 'checkbox',
              checked: autoStart,
              onChange: function (e) { setAutoStart(e.target.checked) },
            }),
            h('span', { key: 'c2', className: 'd' }, '有订阅时随 DSH 启动内核'),
          ]),
        ]),
      )

      children.push(
        h('div', { className: 'r', key: 'acts' }, [
          h('button', {
            key: 'save',
            className: 'p',
            disabled: busy,
            onClick: function () {
              go('save', { subscribeUrl: sub, kernelPath: kernelPath, autoStart: autoStart })
                .then(function (r) { if (r) setMsg('已保存。') })
            },
          }, '保存'),
          h('button', {
            key: 'shim',
            disabled: busy,
            onClick: function () {
              go('install-shim', {}).then(function (r) {
                if (!r) return
                setMsg(r.install && r.install.installed
                  ? '命令前缀已安装到 ' + r.install.path
                  : '未能安装命令前缀：' + JSON.stringify(r.install && r.install.tried))
              })
            },
          }, '安装命令前缀'),
          h('button', {
            key: 'start',
            disabled: busy,
            onClick: function () { go('start', {}).then(function (r) { if (r) setMsg(r.listening ? '内核已启动。' : '启动未成功，请查看上方错误。') }) },
          }, '启动内核'),
          h('button', {
            key: 'stop',
            disabled: busy,
            onClick: function () { go('stop', {}).then(function (r) { if (r) setMsg('内核已停止。') }) },
          }, '停止内核'),
        ]),
        busy ? h('div', { key: 'busy', className: 'd' }, '处理中…') : null,
      )

      return h('div', { className: 'dxp' }, children)
    }

    function apply(ctx) {
      if (!document.getElementById(STYLE_ID)) {
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      }
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'dsh-agentic-proxy', order: 30, label: '代理管家' },
          function () { return h(Page, null) },
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.name = 'dsh-agentic-proxy'
    return module.exports
  },
})
