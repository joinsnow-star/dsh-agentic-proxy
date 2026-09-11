# 策略说明书

本文件描述 `dsh-agentic-proxy` 在**各种情况下会怎么做**。所有策略均以当前代码为准
（`lib/` 与 `client/`），不含未实现的设想。

---

## 0. 总览

一句话：**插件只做两件事 —— 准备一个本地代理端口，并让 Agent 能按命令选择是否使用它。**
其余（拉订阅、解析节点、测速、选节点、故障转移、按域名分流）全部委托给内核 mihomo。

```
Agent 写命令
   │
   ├─ 不加前缀 ──────────────► 直连（插件完全不介入）
   │
   └─ 加 proxy 前缀 ─► proxy.cmd
                         │
                         ├─ 读状态文件 ─► UP?  ──否──► 警告 + 照常执行（直连）
                         │                │
                         │               是
                         │                │
                         └────────────────┴──► 注入 HTTP(S)_PROXY 指向 127.0.0.1:17890
                                                     │
                                                     ▼
                                              mihomo（按规则分流）
                                                     │
                                    ┌────────────────┴────────────────┐
                                    ▼                                 ▼
                              国内域名 → 直连                 境外域名 → url-test 组
                                                                    （自动选最快节点）
```

---

## 1. 速查表

| 情形 | 插件行为 |
| --- | --- |
| 命令无 `proxy` 前缀 | 完全不介入，行为与没装插件一致 |
| 命令有 `proxy` 前缀，内核在跑 | 注入代理环境变量后执行原命令 |
| 命令有 `proxy` 前缀，内核没跑 | **stderr 警告，然后不带代理照常执行**（不阻断） |
| 命令有 `proxy` 前缀但没带命令 | 打印用法，退出码 2 |
| 目标是中国域名 / 局域网 | 即使走了 `proxy`，内核规则也会判为直连 |
| 目标在境外 | 内核 `MATCH` 兜底走代理，由 `url-test` 选最快节点 |
| 某节点失效 | 内核的 `url-test`（interval 300s）自行切换，插件不参与 |
| 首次使用 | 自动下载内核（约 17.7MB）+ GeoIP 数据 |
| 目标端口被别人占用 | **启动失败并提示换端口**（不会把流量发给陌生程序） |
| 当前节点失效 | 看门狗在一个轮询周期内发现，强制重测并换到可用节点（详见 `FAILOVER.md`） |
| 组内节点全部失效 | 状态转 `DEGRADED`，代理命令**警告后直连**，并尝试重拉订阅 |
| 内核进程崩溃 | **立刻**把状态写 `DOWN`，随后按 5s/15s/45s 有界重启 |
| DSH 退出 | 内核被停止，状态文件写 DOWN，不留下孤儿进程 |
| GitHub 不可达 | 依次尝试两个镜像；全失败则给出手动放置指引 |

---

## 2. 命令策略

### 2.1 前缀形态

只有一种形式：**`proxy <命令>`**。

```cmd
proxy npm install
proxy curl https://api.github.com
proxy git clone https://github.com/x/y
```

### 2.2 为什么没有 `proxy direct`

"不加前缀"本身就是直连，所以 `proxy direct` 是冗余的。更关键的是 `cmd.exe` 的
`shift` 对 `%*` **无效** —— 要剥掉开头的 `direct` 就得手工重组参数，而
`proxy direct curl "https://a b"` 这类带引号的参数会在重组中丢引号。因此不做。

### 2.3 shim 的三步行为

`proxy.cmd` 每次执行时：

1. **读状态文件**（`$DSH_HOME/dyn-proxy/kernel.state` 的第一行，用 `set /p`）。
   这是一次文件读，约 1ms —— 刻意不用"探测端口"，否则每条代理命令都要拉起一个进程。
2. **若为 `UP`**：注入 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（大小写各一份）与
   `NO_PROXY=localhost,127.0.0.1,::1`，然后执行 `%*`。
3. **若为 `DOWN`**：向 stderr 打印一行警告，然后**不带代理照常执行**，并保留原命令的退出码。

第 3 条是刻意的安全阀：代理没开时让命令"因为代理"而失败，会是个很难查的坑；
降级为直连、同时明确告知，比阻断更有用。

### 2.4 为什么用真实命令而不是拦截改写

Harness 层面**无法改写一条已发出的命令**：

- `tools/pre-execute` 的决定只有 `allow` / `deny` / `ask`，源码注释明确写着
  *"Input rewriting is excluded because arguments are already logged and presented"*；
- `tools/post-execute` 只能接受、替换内容或阻断。

运行时确实可以通过替换 `tools/execute` 的 `exec.arguments` 达到改写效果（实测有效），
但那会导致**日志里显示的命令与实际执行的命令不一致**，且属未文档化的内部行为。
因此选用真实的 `proxy.cmd`：命令是什么，记录里就是什么，且命令仍运行在 Agent
自己的 shell 与文件沙箱内。

---

## 3. 分流策略

**由内核执行，插件不自建分流。** 生成的规则（`lib/config.js`）：

```yaml
rules:
  - GEOIP,lan,DIRECT,no-resolve    # 局域网直连，最先匹配
  - DOMAIN-SUFFIX,cn,DIRECT        # .cn 域名直连
  - GEOIP,CN,DIRECT                # 解析到中国 IP 的直连
  - MATCH,auto                     # 兜底：其余全部走代理组
```

顺序有意义：`lan` 优先保证本地流量永不出网；`DOMAIN-SUFFIX,cn` 覆盖 GeoIP 查不到的
中国站点；`MATCH` 是终结规则。

**为什么不在 JS 里维护国内域名表**：那样的表必然不完整，而且会在内核规则之外多出
一层可能判错的逻辑。单一事实来源 = 内核。

---

## 4. 节点策略

**同样由内核执行。** 生成的配置：

```yaml
proxy-providers:
  sub:
    type: http
    url: <你的订阅>
    interval: 3600            # 内核每小时自行重拉订阅
    path: <内核目录>/provider.yaml
    health-check: { enable: true, url: ..., interval: 300 }

proxy-groups:
  - name: auto
    type: url-test            # 自动测速、选最快、失效自动切换
    use: [sub]
    interval: 300
    tolerance: 50             # 与当前节点差距小于 50ms 就不切换，避免抖动
    lazy: false               # 不在空闲时跳过测速

  - name: fallback
    type: fallback            # 按顺序尝试直到一个可用
    use: [sub]
    interval: 300
```

要点：

- **订阅由内核拉取与解析**，插件不解析 YAML 节点，也不在 JS 里排序节点。
  订阅格式变化、节点增删、协议是 vmess 还是 hysteria2，都不需要插件改代码。
- 规则只引用 `auto` 组（`MATCH,auto`）。
- `fallback` 组当前**没有被任何规则引用**，它存在是为了让你能通过内核的
  external-controller 手动切过去。如果你不需要，可以忽略它。

### 4.1 节点失效后的自动切换

内核自身的最坏切换窗口是 300s（provider 健康检查与 `url-test` 的间隔）。
插件在此基础上加了**四层防御**，把响应性压到一个轮询周期（约 20s）：

| 层 | 做什么 | 触发时机 |
| --- | --- | --- |
| 1 | 启动后立刻全量测速（`healthcheckProvider`） | 内核启动完成 |
| 2 | 看门狗每 20s 检查当前节点；失效则强制重测，让内核重选 | 当前节点确认失效 |
| 3 | 内核进程崩溃 → **立刻**写 `DOWN`，再有界重启（5s/15s/45s） | 子进程退出 |
| 4 | 组内全挂 → 先写 `DEGRADED`，再重拉订阅 + 全量测速 | 无可用节点 |

**为什么第 2 层没有"钉住节点"这一步。** 实测：对 `url-test` 组，`PUT /proxies/{g}` 会把
`fixed` 写进去，但**内核在选择时忽略它** —— 把 `fixed` 指向一个已确认失效的节点（同时
`now` 仍是可用节点），真实流量依然正常从可用节点出去（HTTP 204，约 305ms）。既然钉住
既不能强制切换、也不能改变流量走向，它就是无效动作。因此唯一有效的杠杆是
`GET /group/{g}/delay`（强制重测并重选，实测约 5s，且它会顺带清空 `fixed`），插件不再做
无效的钉住动作，也不会再打出"已临时指定某节点"这种并未真实发生的日志。

> 需要区分组类型：`PUT /proxies/{g}` 对 **`select` 组是有效的**（会真正改变 `now`）。
> 但插件的 `auto` 组是 `url-test`，所以该调用在本插件的实际配置下等同空操作。

**注意**：健康数据来自 `GET /providers/proxies/{name}`，**不是**全局 `GET /proxies`
—— 实测全局视图对 provider 节点恒返回 `alive: undefined`。
另外 `alive: true` 本身不是健康证明：刚启动时所有节点都是 `alive: true` 但没有任何
实测延迟，必须先测速。

完整机制、实测数字与验证结果见 **`FAILOVER.md`**。

---

## 5. 内核获取策略

### 5.1 为什么必须下载内核

订阅里是 vmess / hysteria2 这类协议，**无法用纯 Node 实现** —— 必须有原生内核进程。
npm 与 npmmirror 都**没有** mihomo 的二进制包（实测均为 404），所以来源只能是 GitHub。

### 5.2 来源顺序

| 顺序 | 来源 | 单次超时 | 实测 |
| --- | --- | --- | --- |
| 1 | `github.com` 直连 | 10s | 不稳定：曾 1.02MB/s，也曾连续超时 |
| 2 | `gh-proxy.com` 前缀 | 60s | 稳定，与直连峰值同速 |
| 3 | `ghproxy.net` 前缀 | 60s | 稳定，约 0.41MB/s |

第 1 项给**短超时**是刻意的：受限网络下连接会"挂住"（实测 10.6s 才报
`UND_ERR_CONNECT_TIMEOUT`），等满会让人以为插件坏了。

> `hub.fastgit.org` 被刻意排除：该域名已被他人接管（现解析到无关主机的 IP）。

### 5.3 版本发现

用 `releases/latest/download/version.txt` 这个**不含版本号的稳定别名**取版本，
因此**完全不碰 GitHub API**（未认证配额仅 60/小时）。资产文件名含版本号，
所以必须"先取版本、再拼 URL"。

### 5.4 校验（弱校验，如实说明）

上游**不提供 sha256 校验文件**，因此只能做三层弱校验：

1. **长度比对**：下载前用 range 请求问出真实字节数，下载后比对；
2. **zip 头校验**：文件必须以 `PK` 开头 —— 防止镜像在压力下返回一个 HTML 错误页
   却被当作内核存下来；
3. **先写 `.part` 再改名**：中断的下载不会留下一个"看起来能用"的半截文件。

### 5.5 其余资源

- `country.mmdb` 与 `geosite.dat` 用于 `GEOIP,CN` 规则，走同一套镜像链；
- **它们失败不会阻塞内核启动** —— 只影响分流精度（国内站点可能被判去代理），
  属于"降级而非失效"。

### 5.6 手动路径

设置页可填**内核路径**覆盖自动下载。留空则使用插件管理的内核。

---

## 6. 生命周期策略

| 阶段 | 行为 |
| --- | --- |
| 插件加载 | **不启动内核**。仅在 `autoStart` 且 `enabled` 且已填订阅时，后台异步启动一次（不阻塞加载） |
| 首次需要 | 懒启动：下载内核 → 解压 → 生成配置 → 拉起进程 |
| 启动等待 | 轮询端口最多 15s；进程若提前退出，立即报错（含退出码与日志路径） |
| 运行中 | 转发内核 stdout/stderr 到内存环形缓冲（保留最近 200 行） |
| 插件停止 | 杀内核进程、删 pid 文件、状态写 `DOWN` |
| DSH 退出 | 同上（`ctx.effect` 的清理函数） |

**为什么"DSH 退出即停止"**：内核的用处是服务 Agent，而 Agent 只在 DSH 运行时存在。
常驻只会留下一个占着端口和隧道的孤儿进程。

### 6.1 端口归属校验（关键）

内核启动前会判定端口上的监听者**是不是本插件的内核**：

| 端口在监听 | pid 文件指向的进程 | 判定 | 行为 |
| --- | --- | --- | --- |
| 是 | 存活，且镜像名 = 本插件内核 | 就是自己 | 复用，状态写 `UP` |
| 是 | 不存在 / 镜像名不符 | **别人占用的端口** | **报错**（提示换端口），**不写 `UP`** |
| 否 | 存活，且镜像名 = 本插件内核 | 自己但没在服务 | 杀掉，重新启动 |
| 否 | 不存在 / 镜像名不符 | 无 | 删 pid 文件，正常启动 |

为什么需要镜像名比对：**PID 会被操作系统复用**，仅凭 pid 文件无法证明那个进程还是我们的
内核。不比对的话，一个恰好复用了该 PID 的无关进程可能被误杀。

**为什么"端口被占用"必须报错而不是复用**：若把陌生监听者当成自己的内核并写 `UP`，
之后每条 `proxy` 命令都会把流量发给那个陌生程序 —— 这是静默的错误路由，
比启动失败严重得多。

### 6.2 孤儿清理

启动前若发现 pid 文件指向**存活且确属本插件**的内核，说明上一次 DSH 没清干净，杀掉它，
再启动新的。`stop()` 同样只杀镜像名匹配的进程。

这避免了"上一次没清干净 → 端口被占 → 新内核起不来"的死循环。

### 6.3 解压

用系统自带 `tar.exe`（Windows 10+ 的 bsdtar 能解 zip —— 实测通过），
解到临时目录、找到 `.exe`、改名就位，再删掉压缩包与临时目录。
不使用 Node 的实验性 zip API（其签名尚不稳定）。

---

## 7. 状态与故障策略

### 7.1 状态文件

`$DSH_HOME/dyn-proxy/kernel.state`，内容只有第一行 `UP` 或 `DOWN`。
插件在**每次内核状态变化时**重写它；shim 读它。这是"不额外起进程"的代价与收益。

**代价（如实说明）**：状态文件是插件单方面写的。若 DSH 被强杀（内核随之死亡但
没机会写 `DOWN`），状态会停留在 `UP`，直到下次 DSH 启动时被孤儿清理纠正。
这种情况下 `proxy` 命令会注入一个没人监听的代理地址 —— 表现为连接失败，
而不是静默直连。内核监听本身是 TCP，无需心跳即可判定存活（`probePort`）。

### 7.2 端口探测

`probePort` 用一次 TCP 连接（800ms 超时）判定，这是唯一能证明"端口真在收连接"的方法。

### 7.3 失败时的用户可见性

- 内核启动失败 → `status.lastError` 记录原因（含退出码、日志路径）；
- 设置页顶部以红色显示该错误；
- 最近 200 行内核日志可通过 `status` 取回。

插件**不会静默失败**：任何失败要么出现在设置页，要么出现在 `proxy` 命令的 stderr。

---

## 8. 安全与边界策略

| 关注点 | 策略 |
| --- | --- |
| 权限 | 插件运行在 DSH 主进程内，**不需要任何沙箱提权**（不用 `danger-full-access`） |
| 监听范围 | 内核 `allow-lan: false` + `bind-address: 127.0.0.1`，**不对局域网暴露**（且插件不提供开关，见下） |
| 控制接口 | `external-controller` 绑 `127.0.0.1`，带 `secret`（每次插件加载随机生成 16 字节） |
| RPC 端点 | 只接受 `POST`；请求体上限 64KB；**不接受任何文件路径参数**；能做的只有状态查询、启停、改那几项设置、装卸 shim |
| shim 所有权 | `proxy.cmd` 内含来源标记；安装时**不覆盖非本插件的同名命令**；卸载时只删带标记的 |
| 不劫持调用 | 不修改任何工具的参数，不改变任何既有命令的行为 |
| 不静默扩权 | 所有网络出口都是插件自己发起的下载或内核自己的连接 |

### 8.1 为什么没有"允许局域网"开关

早期版本有一个 `allowLan` 字段，但它从未生效（配置生成忽略它，`save` 也不写）。
本次修复**直接删除该字段**而非实现它，理由：

- 打开它意味着把代理**暴露给整个局域网**，任何同网段设备都能借用你的节点；
- 本插件的威胁模型是"本机、本用户、按命令"，局域网暴露是另一个量级的事；
- 一个容易误开的开关，比没有这个开关更危险。真想这么做，可以自行改内核配置。

### 8.2 shim 安装位置

按顺序尝试三个**已在 PATH 上**的用户级目录：

1. `~/.local/bin`
2. `%APPDATA%/npm`
3. `~/.bun/bin`

Harness 不提供扩展 PATH 的机制，改用户级 PATH 又要重启 DSH 才可见 —— 所以只能
放进已存在的目录。三个都失败会返回 `tried` 列表说明原因。

---

## 9. 配置生成策略

**每次启动都重新生成** `config.yaml`（用户手改会被覆盖 —— 这是刻意的，避免
"配置文件与设置页不一致"）。

关键项：

| 项 | 值 | 理由 |
| --- | --- | --- |
| `mixed-port` | 17890（可配） | 混合端口同时支持 HTTP 与 SOCKS |
| `external-controller` | 17891（可配） | 调试与手动切换用 |
| `mode` | `rule` | 按规则分流 |
| `log-level` | `warning` | 减少噪声 |
| `ipv6` | `false` | 避免 IPv6 泄漏导致分流失效 |
| `unified-delay` | `true` | 延迟测量口径统一 |
| `dns.enhanced-mode` | `fake-ip` | 避免 DNS 污染，配合规则分流 |
| `dns.nameserver` | 阿里 / DNSPod DoH | 国内解析快且稳 |
| `dns.fallback` | Cloudflare / Google DoH | 境外域名兜底解析 |
| YAML 字符串 | **单引号** | 双引号会处理转义，`C:\Users\...` 里的 `\U` 会导致内核报 `did not find expected hexdecimal number` |

`config.js` 中另有一处约定：路径统一转成正斜杠（`slashPath`），进一步规避转义问题。

---

## 10. 清理与卸载策略

| 对象 | 位置 | 卸载行为 |
| --- | --- | --- |
| 内核进程 | — | 插件停止时杀掉 |
| 内核与数据 | `$DSH_HOME/dyn-proxy/` | **不自动删除**（含你下载的内核，重装可复用） |
| shim | `~/.local/bin/proxy.cmd` 等 | 设置页可"移除"；或直接删文件 |
| 设置 | `$DSH_HOME/settings.yaml` 的 `dsh-agentic-proxy` 段 | 随插件卸载自然失效 |

`proxy.cmd` 是唯一写到插件目录之外的东西，因此它带标记、可安全手删。

---

## 11. 已知局限与未完成项

如实列出，避免误解。**1–3 与 7 已在本次修复中解决**（保留条目以记录历史）。

| # | 项 | 影响 | 状态 |
| --- | --- | --- | --- |
| 1 | 端口被非本插件程序占用时被误判为"内核已在运行" | 会把流量发给陌生程序（静默错误路由） | ✅ **已修**：新增镜像名归属校验，占用即报错（见 6.1） |
| 2 | `allowLan` 是悬空配置项 | 该设置无任何效果 | ✅ **已删**：字段移除，并说明为何不实现（见 8.1） |
| 3 | `paths.subscription` 未被使用 | 无功能影响 | ✅ **已删** |
| 4 | 内核已在运行时热重载，`config.yaml` 的 `secret` 更新但内核未重载 | 仅影响外部用 controller API；插件自身不用它 | 已知，影响很小 |
| 5 | `fallback` 组未被规则引用 | 无影响，仅作手动切换备选 | 设计如此 |
| 6 | 仅 **Windows** 实测（内核获取、`tar.exe` 解压、`.cmd` shim） | Linux/macOS 未验证 | 待补 |
| 7 | ~~`repository.url` 是占位；无 LICENSE~~ | — | ✅ **已解决**：`LICENSE` 已补；仓库地址已填为 `github.com/joinsnow-star/dsh-agentic-proxy` |
| 8 | ~~**尚未作为正式插件装载验证**~~ | — | ✅ **已验证**：插件已装载、设置页已出现、RPC 已通（见 11.2）；首次装载暴露的 settings 竞态见 11.3 |
| 9 | 首次使用需要能访问 GitHub | 三个来源全挂时无境内兜底 | 已文档化 |
| 10 | 无官方 sha256，仅弱校验 | 无法做密码学校验 | 上游限制 |
| 11 | 宿主半边在 `apply` 期用 `ctx.get('settings')` 取服务，撞上 provider 的异步就绪 | 命名空间注册失败，设置页报「settings 服务不可用」 | ✅ **已修**：改用 `ctx.inject(['settings'], …)` 等待激活（见 11.3） |
| 12 | 看门狗"钉住最快节点"这一步对 `url-test` 组是空操作，却打出"已临时指定"的日志 | 日志声称发生了实际并未发生的切换 | ✅ **已删**：实测 `fixed` 被内核忽略，只保留真正有效的强制重测（见 4.1） |

### 11.1 本次修复的验证

修复后有四项自动化验证通过：

| 验证 | 结果 |
| --- | --- |
| 陌生程序占用端口 | **被拒绝**并提示换端口；状态**未**被写成 `UP` |
| pid 文件指向镜像名不符的存活进程 | 正确判定为非本插件（`image: node.exe` ≠ `mihomo.exe`） |
| `stop()` 遇到复用的 PID | 不杀无关进程 |
| 真实内核全流程：启动 → 复用 → 停止 → 重启 → 代理请求 | 启动成功、复用未重启、重启后代理请求返回 **204** |

### 11.2 正式装载的实测记录

| 步骤 | 命令 / 检查 | 结果 |
| --- | --- | --- |
| ~~反例：裸包名~~ | `dsh plugin --profile web add dsh-agentic-proxy` | 在**发布到 npm 之前**失败 `ERR_PNPM_FETCH_404`（当时 registry 里没有这个包）；发布后已可正常安装，见 11.4 |
| 安装（本地路径） | `dsh plugin --profile web add D:\DeskTop\MyProgram\dsh-agentic-proxy` | **成功**：`+ dsh-agentic-proxy link:D:/DeskTop/MyProgram/dsh-agentic-proxy` |
| 注册为 profile 层 | 读 `%DSH_HOME%\profiles\web\package.json` | `dsh.profile.bundles` 末尾被 `reconcilePlugins` 自动追加 `dsh-agentic-proxy` |
| 目录解析 | 检查 `profiles\web\node_modules\dsh-agentic-proxy` | Junction → 源码目录；`resolveBundleDir` 走 Node 查找路径并跟随符号链接 |
| 配置合成 | `dsh --profile web --dump-config` | **exit 0**（576 行），含 `id: agentic-proxy` / `name: dsh-agentic-proxy` / `inject: [webServer]` |
| 宿主入口导入 | `import('./lib/index.js')` | `name=dsh-agentic-proxy`，`apply=function`，`inject=["webServer"]` |
| 客户端语法 | `node --check client/client.js` | 通过 |
| 自检套件 | `node verify-package.mjs` | `ALL CHECKS PASSED` |
| GitHub 规格（发行路径） | 临时目录内 `pnpm add github:joinsnow-star/dsh-agentic-proxy` | **成功**：`+ dsh-agentic-proxy 0.1.0`（38.4s）；11 个文件齐全、入口可导入 |
| 运行时激活 | 重启后：设置页出现「代理管家」栏、RPC 路由可达 | **已验证** —— 首次装载即成功，并由此暴露 settings 竞态（见 11.3） |

关于 boot 期风险：`settings` 现在通过 `ctx.inject` 等待（见 11.3），`registerRpc` 在
`webServer` 缺失时降级返回 `{registered:false}`，autoStart 走 `void start().catch(...)`
永不抛进 loader。因此 boot 阶段唯一可能的失败点是**导入期**，而导入期已单独验证通过。

### 11.3 首次真实装载暴露的 bug：settings 竞态

第一次重启后插件**成功装载** —— 设置页出现了「代理管家」一栏，RPC 路由可达 —— 但页面显示
`错误：settings 服务不可用`。

**根因（源码级证据）。** `@deepseek-ai/dsh-settings` 的 `SettingsProvider` 在构造函数里就用
`super(ctx, "settings")` 声明了服务，但它的 fiber 要等 `[Service.init]` 里
`this.publish(await this.load())` 这次**异步磁盘读取**完成后才进入 active：

```js
_getImpl(name, strict = true) {
  const impl = this.store[key]
  if (!impl) return
  if (strict && impl.fiber.state !== 2) return   // 只返回"提供者已激活"的服务
  return impl
}
```

所以在我们的 `apply` 时刻服务处于"已声明但未激活"，`ctx.get('settings')`（`strict` 默认
`true`）**既不抛异常也不返回服务，而是返回 `undefined`**，正好落进原来的 else 分支。错误
信息本身也是误导的：服务并非"不可用"，只是"还没就绪"。

**修复。** 改用 `ctx.inject(['settings'], (sctx) => …)` —— `ctx.inject` 即
`ctx.plugin({inject, apply})`（cordis `lib/index.js:1599`），等依赖就绪再启动一个嵌套
fiber，并在 provider 被替换时重跑。这与 harness 自身的插件一致：`dsh-context` 用的就是
`ctx.inject(["settings"], …)`，注释写明 *"Serve the namespace while a settings provider is
composed; inert otherwise"*。同时把 **autoStart 移进该回调** —— 它依赖只在 settings 就绪后
才能读到的配置，留在 `apply` 末尾会永远读到 `DEFAULTS`（订阅地址为空），从而**静默不启动**。

**验证**（用本机 DSH 安装里的**真实 cordis** 搭最小宿主，让 settings 延迟提供，复现同一
可观测状态）：

| 步骤 | 结果 |
| --- | --- |
| `apply` 时刻 `ctx.get('settings')` | `undefined` —— 复现 bug 条件 |
| provider 激活前 `status` | `settingsReady=false`，`lastError=""`（不再误报错误） |
| provider 激活后 `status` | `settingsReady=true` —— 注入的 fiber 正确触发 |
| 命名空间注册 | `dsh-agentic-proxy` 已注册 |
| `save()` 往返 | 订阅地址正确读写 |
| schema 契约 | 可调用 **且** 有 `toJSON()`，6 个字段齐全（满足 `register` 中 `schema(...)` 与 `schema.toJSON()` 两处用法） |

`verify-package.mjs` 新增第 **[8]** 组断言静态守住这个回归：源码（**剥离注释后**，因为解释性
注释里也含该字符串）必须出现 `ctx.inject(['settings']`，且不得出现 eager 的
`ctx.get('settings')`。已用旧代码片段验证该断言确实能抓到回归，而非空转。

### 11.4 发布到 npm 与插件市场的收录关系

**两件独立的事。** `dshmarket`（DSH 的插件市场）**不搜索 npm**，它读的是
`awesome-dsh-plugin.com` 上的人工策展目录（3455 条，每天约新增 250 条），且市场 UI 的安装被
限制在目录内（*"Installs are restricted to sources listed in the curated registry"*）：

- **发布 npm** → 安装命令从 `github:joinsnow-star/dsh-agentic-proxy` 变成 `dsh-agentic-proxy`
- **向策展仓库提 PR** → 市场与站点才能搜索到

两者都不影响"插件本身能否被安装"——`dsh plugin --profile web add github:…` 一直可用。

**npm 发布实测：**

| 步骤 | 结果 |
| --- | --- |
| `npm publish`（首次） | **403**：`Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages` |
| 换用带 **Bypass 2FA** 的 granular token | **成功**：`+ dsh-agentic-proxy@0.1.0` |
| 直接读 registry（绕开 npm 缓存） | `latest=0.1.0`、`fileCount=20`、`integrity=sha512-VQHmz…`、**`dsh` 字段完好** |
| 产物 vs 工作树逐文件 SHA256 | **20/20 一致** |
| 在安装副本里跑它自己的自检 | **ALL CHECKS PASSED**（44 项） |
| profile 切到 registry 规格 | `specifier: 0.1.0`，lockfile 记录同一 integrity |

> npm 自 2025 起强制要求"2FA **或** 带 Bypass 2FA 的 granular token"才能发布
> （[官方文档](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)）。
> 文档写明 bypass token 的放行"regardless of account-level or package-level 2FA settings"，
> 因此**账号 2FA 关闭时**这正是可行路径，不必先去开 2FA。

> 一个诊断陷阱：发布前反复查过包名，那些 **404 被 npm 本地缓存**，导致发布成功后
> `npm view` 仍报 `E404`，而同一次调用里 `repository`/`homepage` 又正常返回。
> 用 `--prefer-online` 或直接 `curl` 问 registry 才能得到真相。

**策展目录收录**（提交物见仓库 `submission/`）：向
`awesome-dsh-plugin/awesome-dsh-plugin` 提 PR，只加一个文件
`data/plugins/joinsnow-star__dsh-agentic-proxy.yml`。其 `contributing.md` 列出的门槛中，
`dsh.bundle` 声明、`cordis.patch.yml`、真实可用代码、描述属实四条均已满足；另有两条需注意：
**仓库需添加 `dsh-plugin` topic**，且**仓库创建满 1 天**（CI 自动检查）。

---

## 附录：全部设置项

命名空间 `dsh-agentic-proxy`（写入 `$DSH_HOME/settings.yaml`）：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 插件总开关 |
| `subscribeUrl` | string | `""` | Clash / mihomo 格式订阅地址 |
| `port` | number | `17890` | 内核混合端口（改此值会重写 shim） |
| `apiPort` | number | `17891` | external-controller 端口 |
| `kernelPath` | string | `""` | 自备内核路径；留空 = 用插件下载的 |
| `autoStart` | boolean | `true` | 是否随 DSH 启动内核 |

以上即**全部**设置项（共 6 项）。另外三个**不可从设置页修改**的常量，定义在
`lib/config.js`：`intervalSec`（订阅重拉间隔，3600s）、`healthCheckSec`（健康检查与
测速间隔，300s）、`DEFAULT_TEST_URL`（测速地址）。
