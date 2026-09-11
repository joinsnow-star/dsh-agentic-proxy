# 事实核查记录

本文件只记录**实测/源码确认过的事实**与出处，供实现与后续维护参考。
不要把推测写进来。

## mihomo 内核获取（2026-08 实测）

| 事实 | 证据 |
| --- | --- |
| npm 上**没有**任何 mihomo/clash-meta 二进制包 | `mihomo`/`@mihomo/core`/`clash-meta`/`mihomo-bin` 全部 **404**；`clash-verge` 是 25KB 空壳无 `bin`；`sing-box` 是 211B 占位包 |
| npmmirror 二进制镜像**没有** mihomo/clash | `/-/binary/mihomo/`、`/-/binary/clash/`、`/-/binary/sing-box/` 均 **404**（镜像 99 个条目里 0 命中） |
| 官方最新版 | `MetaCubeX/mihomo` → `tag_name = v1.19.30`（2026-08-16） |
| Windows amd64 资产 | `mihomo-windows-amd64-compatible-v1.19.30.zip` = **18,529,108 字节**（另有 v1/v2/v3 微架构变体，`compatible` 最保守） |
| zip 内含 | `mihomo-windows-amd64-compatible.exe`（解析 ZIP 中央目录确认） |
| **无官方 sha256 资产** | releases 里只有 `toolchain.tar.gz`、`vendor.tar.gz`、`version.txt`(9B) |
| 免 API 配额取版本 | `https://github.com/MetaCubeX/mihomo/releases/latest/download/version.txt` → 200，返回 `v1.19.30`。**不打 api.github.com**（未认证配额仅 60/小时） |
| 资产名含版本号 | 必须先取版本再拼 URL；`latest/download/<含版本名>` 只在下个版本发布前有效 |
| **HEAD 不可靠** | 对下载 URL 发 `-I` 返回 `content_length=6087`，不是真实的 18,529,108 → **必须用 GET** |
| 下载实测（本机无代理） | 直连 github.com：200 / 18,529,108 字节 / 18.19s / **1.02 MB/s**；`gh-proxy.com` 前缀：同速；`ghproxy.net` 前缀：0.41 MB/s |
| 可用镜像 | 仅 `gh-proxy.com`、`ghproxy.net` 两个。`ghfast.top`、`hub.fastgit.org` 及另外 6+ 个**全部 000 超时** |
| **`hub.fastgit.org` 域名已被他人接管** | 现解析到 `31.13.84.2`（Facebook 的 IP）→ **绝不可写入代码或配置** |
| mihomo 支持 hysteria2 | 官方 README 列出 Hysteria；`wiki.metacubex.one/en/config/proxies/hysteria2/` → 200 |

**关键结论**：GitHub 直连可用，"首次运行自动获取内核"成立。但**若用户网络完全无法到 GitHub 且镜像也挂，则没有任何境内兜底源** —— 这是最硬的限制，必须写进 README。

## DSH 插件分发契约（源码确认）

| 事实 | 证据 |
| --- | --- |
| 安装命令 | `dsh plugin --profile <name> add <npm名\|github:owner/repo\|tarball URL>`；CLI 跑 pnpm 后**自动**对账 `dsh.profile.bundles`，**无需手改 profile 文件** |
| 判定"是插件"的唯一依据 | 包声明 `dsh.bundle.patch`（`dsh/lib/plugin-*.js`：`readProfileManifest(...).dsh?.bundle?.patch !== void 0`） |
| `cordis.patch.yml` 格式 | `- insert: [{ id, name }]`，`name` 必须是**真实包名**，否则启动失败 |
| host-only 插件合法 | `beauticode-dsh` 无 `dsh.client` 字段 |
| 客户端半契约 | 产物须导出 `{ apply, createClientModuleSystem }`，否则报 `"did not export the bootstrap module face"`；`dsh.client = { platform, inject, external, immediately }` |
| 参照实现无构建步骤 | `beauticode-dsh` 的 package.json **没有 `scripts` 字段**，客户端 `client.js`(64KB) 是预置/手写产物 |
| 上榜市场 | 向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR 加 `data/plugins/<owner>__<repo>.yml`；仅 `description.en` 必填 |
| 无官方脚手架 | 无 `create-*` 包、无 template/examples |

## Harness 能力边界（源码 + 实测确认）

| 事实 | 证据 |
| --- | --- |
| **无法改写已发出的命令** | `PreToolDecision` 只有 allow/deny/ask，源码注释 *"Input rewriting is excluded because arguments are already logged and presented"*；`PostToolDecision` 只有 accept/替换内容/block |
| 运行时确可改写，但**不采用** | 替换 `tools/execute` 的 `exec.arguments` 实测生效，但**日志显示的命令 ≠ 实际执行的命令**，且属未文档化内部行为 |
| **PATH 不可扩展** | `shellEnv` 强制 `DSH_*` 前缀；pwsh 工具无 `env` 参数；全仓搜 PATH 注入点 0 命中；改用户级 PATH 需**重启 DSH** 才可见 |
| **PATH shim 可行**（已验证） | 向已在 PATH 且可写的目录放 `.cmd`，一次全新 pwsh 调用以裸名执行成功，PATHEXT 含 `.CMD` |
| 可写的既有 PATH 目录 | `~\.local\bin`、`%APPDATA%\npm`、`~\.bun\bin`、`~\.kimi-code\bin`、`anaconda3\Scripts`、`WindowsApps` |
| bash 工具本机不可用 | `wsl -l -v` 只有 `docker-desktop`，无 `/bin/bash` → `bash -c` 报 `execvpe(/bin/bash) failed` |
| 动态插件 vs 正式插件 | 动态：仅进程内存、重启即失、session 级；正式：npm 包 + `dsh.bundle.patch`，重启仍在 |
| `shellEnv` 不能注入 `HTTP_PROXY` | `dsh-shell-env` 强制 `key.startsWith('DSH_')` |

## "." 环境代理（官方机制，但不适用本目标）

- `dsh-http-proxy` 在 `profile-boot` 于**任何插件加载前**装一次全局 dispatcher，把 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` + `NODE_USE_ENV_PROXY=1` 注入**每个**子进程。
- `$DSH_HOME/.env` 是**唯一**接受这些变量名的 `.env` 位置（项目层 `.env` 设它会拒绝启动）。
- **不适用**：它是**全局常开**，Agent 无法**逐条**决定是否走代理 —— 与本插件核心诉求冲突。插件也无法在运行时改这个 policy（沙箱禁止 `require`，且未暴露为 cordis service）。

## 沙箱策略

`shell` 服务默认 `workspace-write`，会让 TLS 失败（`schannel: SEC_E_NO_CREDENTIALS`）；`danger-full-access` 下正常（实测 204）。

**但正式插件不受此限**：正式插件运行在 DSH 主进程，直接用 Node API（`fetch`/`fs`/`child_process`），**不经 `shell` 服务**，因此不需要任何沙箱提权。这是转正式包的额外收益。
