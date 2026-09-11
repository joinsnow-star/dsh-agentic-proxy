# 设计说明（锁定版）

> 本文记录已确认的设计决策与依据。事实均有出处，决策均经确认。
> 最后更新：见 git 历史。

## 目标

让 DeepSeek Harness 的 Agent 能访问境外/被阻断资源，并且：

1. **不依赖用户机器上已装的代理软件**（可发布给任何人）；
2. Agent 能**自己决定某条命令是否走代理**；
3. 节点失效能自动切换 —— 由内核负责，不由本插件在 JS 里实现。

## 核心机制

### Agent 如何表达"这条要走代理"

Agent 在命令前加前缀：

```
proxy npm install
proxy curl https://api.github.com
proxy direct curl https://registry.npmmirror.com/react
```

- `proxy <cmd>` —— 走代理
- `proxy direct <cmd>` —— 强制直连

插件的 `proxy.cmd` 会被放进一个**已在 PATH 上**的目录（当前实现为
`C:\Users\ASUS\.local\bin`），因此 Agent 的**普通 pwsh 调用**就能直接执行它，
命令仍运行在 Agent 自己的沙箱里。

### 为什么是"前缀"而不是"插件拦截改写"

已实测确认两条事实：

- `tools/pre-execute` 的 `PreToolDecision` **只有 allow / deny / ask**，
  且源码注释明确写着 *"Input rewriting is excluded because arguments are already
  logged and presented"*。
- `tools/post-execute` 的 `PostToolDecision` **只能 accept / 替换内容 / block**。

即：**官方无法改写一次已发出的命令**。（运行时确实可以通过替换
`tools/execute` 的 `exec.arguments` 达到目的，但那是未文档化的内部行为，
且会导致**日志显示的命令与实际执行的命令不一致** —— 因此不采用。）

前缀方案没有这个问题：命令是什么，日志里就是什么。

### 前缀如何生效

`proxy.cmd` 做三件事：

1. 探测内核端口是否在监听（本地 TCP 连接，开销可忽略）；
2. 在监听 → 注入代理环境变量（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`），再执行 `%*`；
3. 未监听 → **打印明确警告，然后照常执行原命令**（不注入）。

第 3 条是安全阀：不让命令因为"代理没开"而凭空失败，也把"客户端没启动"
这一诊断前移到命令层。

### 分流与选速：交给内核

因为代理指向的是内核的 **mixed-port**，而内核配置里带完整的规则与
`url-test` 组，所以：

- 国内流量按 `GEOIP,CN,DIRECT` 等规则**直连**；
- 境外流量按 `MATCH` 兜底走代理，并由 `url-test` 组**自动选最快节点**；
- 节点失效由内核的 `url-test` 自动切换。

**本插件不在 JS 里实现分流规则，也不自己给节点排序。**
（早期版本曾在 JS 里硬编码 CN 域名表并自行测速排序，已废弃：那样做既不如
内核规则完整，又会与 `url-test` 抢控制权。单一事实来源 = 内核。）

### 配置由谁生成

使用 mihomo 的 **`proxy-providers`**：配置骨架里只写订阅 URL，由**内核自己**
拉取、解析、定时刷新节点；插件只生成一份**很薄且稳定**的骨架：

```yaml
proxy-providers:      # 订阅交给内核
proxy-groups:         # url-test 组，选最快
rules:                # GEOIP,CN,DIRECT + MATCH
```

好处：订阅格式变化、节点刷新、测速切换都由内核承担，插件不解析 YAML 节点。

## 内核

- **选型**：mihomo（Clash.Meta）。支持 vmess / trojan / ss / **hysteria2** /
  vless / reality / tuic / wireguard，单文件静态二进制，自带规则引擎、
  `url-test` 组与 external-controller API。
- **获取**：默认从**镜像优先**的多个源自动下载，全部失败时给出明确的手动放置
  指引（不静默失败）。设置页可改为**自备内核路径**。
- **不打包进仓库**：mihomo 是 **GPL-3.0**，作为独立程序按需下载，避免许可证
  与仓库体积问题。
- **存放**：`$DSH_HOME/dyn-proxy/`（内核二进制、生成的配置、日志、订阅缓存）。
- **生命周期**：**懒启动**（首次需要代理时才起）；**DSH 退出即停止**，不留孤儿
  进程。
- **端口**：默认 `17890`（避开 Clash for Windows 常用的 7890）。

## 交付形态

做成**正式 DSH 插件包**（不是动态 Cordis 插件），以便发布与他人安装。

必需的三个文件（参照已发布插件的真实契约）：

| 文件 | 作用 |
| --- | --- |
| `package.json` | 含 `dsh.bundle.patch: "./cordis.patch.yml"` —— 这是 `dsh plugin add` 判定"是否插件"的**唯一依据** |
| `cordis.patch.yml` | `- insert: [{ id, name }]`，`name` 必须是真实包名 |
| 实现（host 半） | 导出带 `apply` 的 cordis 插件 |

他人安装：

```bash
dsh plugin --profile web add <包名>          # 已发布 npm
dsh plugin --profile web add github:joinsnow-star/dsh-agentic-proxy   # 直接从 GitHub
```

CLI 会自动把包名写入 profile 的 `dsh.profile.bundles`，**无需手改任何 profile 文件**。

## 已知约束与注意事项

- **沙箱策略**：插件通过 `shell` 服务联网时需 `danger-full-access`。默认的
  `workspace-write` 会让 TLS 失败（`schannel: SEC_E_NO_CREDENTIALS`）。
- **shim 是外部文件**：`proxy.cmd` 位于用户 PATH 目录，插件必须能**按标记干净
  卸载**，否则会留下孤儿命令。
- **发布前必须参数化**：早期实现里硬编码了绝对路径与 `danger-full-access`，
  正式包不得如此。
- **`.env` 全局代理不可用于本目标**：`$DSH_HOME/.env` 里设 `HTTP_PROXY` 确实能
  让所有子进程继承（DSH 启动时装一次策略），但那是**全局常开**，Agent 无法
  **逐条**决定是否走代理 —— 与本插件的核心诉求冲突。
- **controller API 不作为正确性依赖**：Clash for Windows 默认
  `randomControllerPort: true`，端口运行时未必固定。
