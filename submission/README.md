# 插件市场收录提交物

`dshmarket`（DSH 的插件市场）**不搜索 npm**，它读的是 `awesome-dsh-plugin.com` 上的人工
策展目录（3455 条，每天约新增 250 条）。所以"发布到 npm"和"市场能搜到"是**两件独立的事**，
两件都要做。

- 发布 npm → 安装命令变成干净的 `dsh plugin --profile web add dsh-agentic-proxy`
- 收录目录 → 市场（以及 dshmarket.com / awesome-dsh-plugin.com）能搜索到

## 目录收录：一个文件就是全部投稿

向 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> 提 PR，**只加一个文件**：

```
data/plugins/joinsnow-star__dsh-agentic-proxy.yml
```

内容就是本目录下的 `joinsnow-star__dsh-agentic-proxy.yml`。合并后目录会在 `main` 上自动
重新生成，通常一天内被市场和站点拾取。

> 描述里含 `: `（冒号加空格）**必须加引号**，否则 YAML 会当成嵌套键。本文件已引号处理。

## 提交前必须满足的门槛（逐条核对）

| # | 要求 | 状态 |
| --- | --- | --- |
| 1 | `package.json` 声明 `dsh.bundle`（不是只有 `dsh.client`） | ✅ `dsh.bundle.patch` 已声明 |
| 2 | 仓库根有 `cordis.patch.yml`，形如 `insert: [{id, name}]` | ✅ |
| 3 | 仓库含真实可用代码（非占位/纯 README） | ✅ 已在真实 DSH 中安装并实测 |
| 4 | **仓库创建满 1 天**（CI 自动检查） | ⏳ 仓库创建于 2026-09-11T19:48:53Z，即 **2026-09-12T19:49Z** 之后才达标 |
| 5 | 仓库添加 `dsh-plugin` topic | ❌ **尚未添加**，需在仓库设置里加 |
| 6 | 描述属实、不带营销词 | ✅ 逐条与代码核对过 |

门槛 4 是硬阻塞：仓库创建后**不到 1 小时**就提交会被 CI 直接拒掉。提前把文件备好，等到达标
日期再提。

## 分类选择

选 `tools`（463 条）。最接近的两个先例是 `dsh-llm-proxy` 与 `dsh-http-proxy`，但它们代理的是
**模型 API 请求**，因此归在 `model`；本插件代理的是 **agent 的 shell 命令**，本质是给 agent
提供一个命令能力，故 `tools` 更贴合实际做的事。分类选得不够准的话，维护者会直接改，不会打回。

## 评审说明

CI 通过只是**前置条件**，不是结论。维护者会实际阅读仓库后才合并——README 明确写了这一点，
所以描述与代码必须一致：本插件确实提供 `proxy <命令>` 前缀、确实自行下载并托管 mihomo 内核、
崩溃后确实会自动重启、节点失效确实会自动切换（均有实测记录，见 `POLICY.md` 与 `FAILOVER.md`）。
