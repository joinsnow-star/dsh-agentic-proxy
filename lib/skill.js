/**
 * The one thing the Agent cannot guess: that a `proxy ` prefix exists at all.
 *
 * The plugin deliberately registers no model-facing Tool — the Agent's interface is a real
 * command in its own shell, and a Tool would be a second path to the same effect. What the
 * Agent does need is to be TOLD the convention exists, and the harness's own answer to that
 * is the skill catalog: `dsh-tool-skill` keeps a durable catalog in the session, so a
 * registered skill's name and description sit in front of the model on every step while the
 * body is loaded only when the model asks for it.
 *
 * The description therefore carries the syntax itself. If the model reads only the catalog
 * line — the common case — it must still learn `proxy <command>` from it.
 *
 * Registration is CONDITIONAL on the shim actually being on PATH. Telling the model to run
 * `proxy …` when no such command resolves is worse than saying nothing: it would spend a
 * turn on a command that cannot be found. `register()` returns a Cordis disposer, so the
 * skill follows the shim exactly.
 */

/** Kebab-case, matching the registry's own `SKILL_NAME` grammar. */
export const AGENT_SKILL_NAME = 'agentic-proxy'

/** Read on every step, so it states the syntax rather than describing the feature. */
const DESCRIPTION =
  '让某条 shell 命令经代理出网：在命令前加 `proxy ` 前缀（例如 `proxy curl https://example.com`）。' +
  '直连失败、超时，或需要访问境内直连不通的资源时使用。' +
  '内核未运行时该前缀会打印一行警告然后照常直连，不会阻塞也不会让命令失败。'

const WHEN_TO_USE =
  '命令直连失败或超时；或需要访问 GitHub、Google、npm 官方源等境内直连不通的资源。'

/** Loaded only when the model asks, so this can afford the detail. */
const CONTENT = [
  '# agentic-proxy',
  '',
  '让某一条 shell 命令经由本机的代理内核出网。内核由 `dsh-agentic-proxy` 插件下载并托管，',
  '不需要机器上预先装好任何代理软件。',
  '',
  '## 用法',
  '',
  '在命令前加 `proxy ` 前缀：',
  '',
  '```',
  'proxy curl https://example.com',
  'proxy npm install',
  'proxy git push',
  '```',
  '',
  '不加前缀就是直连。**没有** `proxy direct` 这种形式 —— 不带前缀本身就是直连。',
  '',
  '## 什么时候用',
  '',
  '- 直连失败、超时、连接被重置',
  '- 需要访问境内直连不通的资源（GitHub 原始文件、Google、npm 官方源等）',
  '- 已知某条命令依赖境外服务',
  '',
  '## 什么时候不用',
  '',
  '- 访问境内站点（baidu、gitee 等）：分流规则会让它们直连，多套一层没有意义',
  '- 普通本地命令（`ls`、`git status`、`npm run build`）',
  '',
  '## 不必先检查代理是否可用',
  '',
  '`proxy` 自己会判断内核状态。内核没在运行时它**打印一行警告然后照常直连**，不会阻塞、',
  '也不会让命令失败。所以直连失败时直接加前缀重试即可，无需先查询状态。',
  '',
  '## 如果报 schannel / SEC_E_NO_CREDENTIALS',
  '',
  '在受限沙箱里，`curl.exe` 走的是 Windows Schannel，可能拿不到证书凭据而报：',
  '',
  '```',
  'schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030E)',
  '```',
  '',
  '**这不代表代理不通** —— 通道已经建立，是 TLS 后端取不到凭据。换成 OpenSSL 后端的工具',
  '即可，不需要动代理配置：',
  '',
  '```',
  'proxy git -c http.sslBackend=openssl clone https://github.com/xxx/yyy',
  'proxy node -e "fetch(\'https://api.github.com/zen\').then(r => r.text()).then(console.log)"',
  '```',
  '',
  'Node 与 Python 自带 OpenSSL，通常直接可用；**只有 `curl.exe` 和 `git` 需要显式换后端**。',
  '',
  '只对**这一条命令**加 `-c`，不要写进全局 git 配置：Schannel 用的是 Windows 证书库，而某些',
  '环境（企业 MITM 代理）的根证书只装在系统库里，强制 OpenSSL 反而会因无法验证证书而失败。',
  '',
  '## 内核状态在哪看',
  '',
  'DSH 设置 → 代理管家：内核是否运行、当前节点、可用/失效节点数、最快的几个节点。',
  '',
].join('\n')

/**
 * Register the skill if this process has a skill registry. Returns the Cordis disposer, or
 * null when the service is absent — the skill is guidance, never a hard dependency.
 */
export function registerAgentSkill(ctx) {
  const skills = ctx.get('skills')
  if (skills === undefined) return null
  try {
    return skills.register({
      name: AGENT_SKILL_NAME,
      description: DESCRIPTION,
      whenToUse: WHEN_TO_USE,
      content: CONTENT,
      source: 'runtime',
    })
  } catch {
    // A duplicate name (another copy already registered) is a no-op by contract; anything
    // else here must not take the plugin down with it.
    return null
  }
}
