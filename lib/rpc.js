/**
 * The settings page is a browser module, so it reaches the host over HTTP. A named route
 * on the harness's own web server is the supported seam for that; the dynamic-plugin
 * `harness.handle` shortcut does not exist for an installed package.
 *
 * The route is deliberately narrow: one POST endpoint, one namespace, and no file paths
 * accepted from the request — a caller can start/stop the kernel, read status, and change
 * the same few settings the settings page owns.
 */
const RPC_PATH = '/__dsh-agentic-proxy/rpc'

/** Cap the body so a malformed or hostile request cannot grow without bound. */
const MAX_BODY = 64 * 1024

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export function registerRpc(ctx, handlers, path = RPC_PATH) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return { registered: false, reason: 'webServer 服务不可用' }
  const dispose = webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只接受 POST' })
        return
      }
      try {
        const body = await readJson(req)
        const method = String(body.method ?? '')
        const handler = handlers[method]
        if (typeof handler !== 'function') {
          sendJson(res, 400, { ok: false, error: `未知方法: ${method}` })
          return
        }
        const value = await handler(body.args)
        sendJson(res, 200, { ok: true, value: value === undefined ? null : value })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })
  return { registered: true, path, dispose }
}

export { RPC_PATH }
