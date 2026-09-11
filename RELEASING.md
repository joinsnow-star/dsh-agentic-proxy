# 发布与三方同步

三者指：**本地工作树**、**GitHub（`origin/main` + tag）**、**npm（registry 上的版本）**。

要维持的不变式只有一条：

> tag `v<version>` 所指向的提交，其 `files` 白名单内的内容，
> 与 npm 上 `<version>` 的 tarball **逐字节相同**。

`README.md` / `POLICY.md` 这类仓库专属文件（`submission/`、`.gitignore`、`RELEASING.md`、
`check-sync.mjs`）**不进** `files`，因此永远不会出现在 npm 包里——这正是上面那条不变式能成立的
原因。**不要为了"让仓库和 npm 一样"而把仓库专属文件塞进 `files`**：那会让已发布版本的
内容发生变化，直接破坏 tag 与 npm 的对应关系。

随时可以检查：

```bash
node check-sync.mjs      # 本地 ↔ GitHub ↔ npm 三方比对，退出码非 0 即不同步
npm run verify           # 44 项离线自检（不联网、不创建文件）
```

## 发布一个新版本的顺序

顺序不能颠倒——tag 必须打在**真正被发布的那棵树**上。

1. 改 `package.json` 的 `version`
2. `npm run verify`（44 项必须全过）
3. `git add -A && git commit && git push`
4. `git tag -a v<version> -m "npm <version>"` — 打在**刚推送的那个提交**上
5. `git push origin v<version>`
6. `npm publish`
7. `node check-sync.mjs` — 必须输出 `IN SYNC`

第 4 步必须在第 6 步之前：如果先发布再打 tag，一旦之后又提交了任何东西，就无法证明
tag 指向的是被发布的那棵树。

## 实测踩过的坑

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| npm 强制二次验证 | `403 Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages` | 建 **granular token** 并打开 **Bypass 2FA**，写进 `~/.npmrc`。账号 2FA 关闭也能用（[官方文档](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)写明 bypass"regardless of account-level 2FA settings"） |
| npm 本地缓存了发布前的 404 | 发布成功后 `npm view` 仍报 `E404`，同一次调用里 `repository` 却正常返回 | 用 `npm view --prefer-online`，或直接 `curl https://registry.npmjs.org/<name>` 验证 |
| registry CDN 边缘缓存旧 packument | 0.1.1 已发布且 tarball 返回 200，但版本列表仍只有 0.1.0（持续约 95s） | 同上；**tarball 能 200 就说明发布已生效**，别据版本列表下结论 |
| `dsh plugin` 在 Windows 上吃掉 `^` | 传 `pkg@^0.1.0` 实际装成**精确版本** | `dsh plugin` 以 `shell: true` 转发给 `cmd.exe`，而 `^` 是 cmd 的转义字符。要范围就直接改 profile 的 `package.json` |
| `pnpm add <名字>` 不换规格 | 包已从 `link:`/`github:` 装过时，`add <名字>` 只把旧规格重新解析，不会换成 registry 规格 | 先 `remove` 再 `add` |
| 未发布时裸包名会 404 | 发布**之前** `add dsh-agentic-proxy` 返回 `ERR_PNPM_FETCH_404` | 发布后即正常；这类"发布前"的失败要记成历史，别当成 bug 追 |

## 插件市场（与 npm 发布是两件事）

`dshmarket` **不搜索 npm**，它读 `awesome-dsh-plugin.com` 上的人工策展目录。发布 npm 只让安装
命令变干净，**不会**让插件在市场里被搜到。收录需要向
`awesome-dsh-plugin/awesome-dsh-plugin` 提 PR，只加一个文件
`data/plugins/<owner>__<repo>.yml`（内容见 `submission/`）。其 `contributing.md` 列的门槛里，
两条容易漏：仓库要带 `dsh-plugin` topic，且仓库**创建满 1 天**（CI 自动检查）。
