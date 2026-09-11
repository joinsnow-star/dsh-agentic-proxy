# dsh-agentic-proxy

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的 **按命令代理**：Agent 自己决定哪条
shell 命令走代理，插件负责安装并托管它所需要的代理内核 —— **不依赖你机器上已装的任何代理软件**。

```bash
proxy npm install                 # 这条走代理
proxy curl https://api.github.com # 这条也走代理
curl https://registry.npmmirror.com/react   # 不加前缀 = 直连
```

## 为什么是"命令前缀"

Harness 无法改写一条**已经发出**的命令：`tools/pre-execute` 的决定只有
allow / deny / ask，`tools/post-execute` 只能接受、替换内容或阻断。唯一能在运行时改写
`args` 的路径（替换 `tools/execute` 的 `exec.arguments`）会导致**日志显示的命令与实际执行的
命令不一致**，因此不采用。

`proxy` 是一个真实存在于 PATH 上的 `proxy.cmd`，所以：

- 命令是什么，日志里就是什么；
- 命令仍运行在 Agent 自己的 shell 与文件沙箱内；
- 不需要任何 harness 内部行为，升级不易失效。

## 安装

```bash
dsh plugin --profile web add github:joinsnow-star/dsh-agentic-proxy
```

> **该包尚未发布到 npm。** 所以直接写包名 `add dsh-agentic-proxy` 会被 pnpm 当成
> registry 包名去查询，并返回 `ERR_PNPM_FETCH_404`。请用上面的 GitHub 规格。

从本地源码目录安装（开发用；pnpm 会建一个目录链接，改完代码重启 DSH 即生效）：

```bash
dsh plugin --profile web add D:\path\to\dsh-agentic-proxy
```

`dsh plugin add` 只是把参数原样转发给 profile 目录下的 pnpm，并且**只有以 `.`/`..`
开头的相对路径会被锚定到你当前所在目录**，绝对路径原样透传 —— 这正是它区别于包名的原因。

CLI 会自动把包名写入 profile 的 `dsh.profile.bundles`，**无需手改任何 profile 文件**。

装完必须**重启 DSH**：bundle 层列表只在启动时解析一次，运行中的进程不会热加载新插件
（`patchReload: live` 只热重载 profile 目录下的用户 patch 文件，不含 bundle 列表）。

## 使用

1. 打开 **设置 → 代理管家**，填入你的订阅链接（Clash / mihomo 格式）。
2. 点 **安装命令前缀**，再点 **启动内核**。
3. 之后在 shell 里用 `proxy <命令>` 即可。

## 设计要点

| 关注点 | 做法 |
| --- | --- |
| 内核 | [mihomo](https://github.com/MetaCubeX/mihomo)，首次使用时自动下载 |
| 订阅 | 交给内核的 `proxy-providers`，**插件不解析订阅** |
| 选节点 | 内核的 `url-test` 组自动测速与故障转移，**插件不排序节点** |
| 分流 | `GEOIP,CN,DIRECT` + `MATCH`，**插件不维护国内域名表** |
| 生命周期 | 懒启动；DSH 退出即停止；用 pid 文件识别并清理孤儿进程 |
| 端口 | 默认 `17890`（避开 Clash for Windows 常用的 7890） |

**单一事实来源 = 内核。** 插件只生成一份很薄的配置骨架，其余全部委托给 mihomo。

## 已知限制

- **首次需要能访问 GitHub。** npm 与 npmmirror 都**没有** mihomo 二进制，所以下载源是
  GitHub 直连 + `gh-proxy.com` + `ghproxy.net`。若三者都不可达，请手动下载内核并在设置里
  填入路径。（可在 `FINDINGS.md` 查看实测数据。）
- **无官方 sha256。** 上游不提供校验文件，因此只做了长度比对与 zip 头校验这类弱校验。
- **仅 Windows 已实测。** 内核获取、解压（`tar.exe`）与 shim（`.cmd`）目前是 Windows 路径。
- **`proxy` 会进入 PATH。** 插件停止时会按标记清理；若你手动删过文件，残留的
  `proxy.cmd` 也可以直接删除，插件下次启动会重新生成。
- **模型可能忘记加前缀。** 这是本方案的主要体验风险：不加前缀就是直连。

## 开发

无构建步骤：客户端半是手写的 classic script，直接由 `__ModuleLoader__.load` 注册。

```
lib/paths.js     目录布局
lib/download.js  内核与 GeoIP 数据获取（多镜像）
lib/kernel.js    内核进程生命周期
lib/config.js    生成 mihomo 配置
lib/shim.js      生成 proxy.cmd
lib/rpc.js       设置页的 HTTP RPC 端点
lib/index.js     插件入口
client/client.js 设置页（零构建）
```

`DESIGN.md` 记录设计决策与取舍，`POLICY.md` 是**全部策略的说明书**（各种情况下插件
会怎么做、已知局限清单），`FINDINGS.md` 记录实测事实与出处。

## License

MIT。注意 mihomo 本身是 **GPL-3.0** 且**不随本包分发** —— 它是由用户按需下载的独立程序。
