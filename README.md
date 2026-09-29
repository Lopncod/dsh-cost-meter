# dsh-cost-meter

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web / 桌面端用的**花费计**插件：在输入框正下方常驻一枚小胶囊，直接告诉你**这次回答花了多少钱**、**这个会话一共花了多少钱**。

```
本会话消耗 ¥1.23 · 本次回答 ¥0.087            空闲价 · 2h15m 后转高峰
```

[English](README.en.md) | 中文

## 它显示什么

- **本次回答** —— 最近一次已完成轮次（turn）的估算费用。轮次结束的那一刻刷新并闪一下提示。
- **本会话消耗** —— 当前会话的累计估算费用，含正在进行中的那一轮。
- 点击胶囊展开**逐轮明细**：每轮金额、token 四桶拆分（缓存命中读 / 未命中读 / 缓存写 / 输出）、当轮生效单价、高峰/空闲标记、轮内步数；账本里有多个会话时再列出本机已记账的全部会话与总计。

## 安装

用 DSH 的 Plugin Manager 安装本 bundle：

```
plugin_manager  action: install_bundle  target: <本目录绝对路径或本仓库>
```

或直接指向本仓库：

```
plugin_manager  action: install_bundle  target: github:Lopncod/dsh-cost-meter
```

安装后 **需要重启 DSH**：宿主半是启动时 `import` 的 ESM 模块，运行中改文件或重新启用 bundle 都不会重新加载（这一点本地实测确认过）。

## 计价口径

按 DeepSeek 官方价目（人民币 / 百万 token）与**峰谷计价**规则估算：

| 计费桶 | 含义 | Flash 空闲 / 高峰 | Pro 空闲 / 高峰 |
|---|---|---|---|
| 缓存命中读 | 复用前缀缓存的输入 | 0.02 / 0.04 | 0.15 / 0.30 |
| 未命中读 | 未命中缓存的输入 | 1 / 2 | 4.5 / 9 |
| 缓存写 | 写入缓存的输入（按未命中价计） | 1 / 2 | 4.5 / 9 |
| 输出 | 补全（含推理 token） | 4 / 8 | 13.5 / 27 |

- **高峰时段** = 北京时间**周一至周五 09:00–12:00、14:00–18:00**；其余时段（含周末与中国法定节假日全天）按空闲价。
- 金额是**估算值**，不是账单金额；真实扣费以 DeepSeek 侧余额变化为准。

### token 口径（关键实现细节）

四个桶来自会话日志里 `assistant/message` 事件携带的**真实 `usage`**（模型实际被计费的那份数），**不做 token 估算**：

- `inputTokens` 是**未缓存**桶，与 `cacheReadTokens`、`cacheWriteTokens` **互斥**，三者相加才是 prompt 总量。这一点抄的是 DSH 自己的权威定义 —— `@deepseek-ai/dsh-token-meter` 的 `tokenUsage` projection 把它命名为 `uncachedInputTokens` 并与另两个桶相加（见 `lib/types/usage-projection.js`）。
- `reasoningTokens` 是 `outputTokens` 的子集，**不再单独计费**，否则输出侧会被翻倍计费。
- 同一 `(turn, step)` 的重复结算**替换**而非累加；`llm/retry-started` 才重开替换槽 —— 与 token-meter 的 `addReplacing` 同语义，避免重试/重复订阅把一轮算两遍。

## 配置（可选）

`$DSH_HOME/.dsh-cost.json`（Windows 默认 `C:\Users\<你>\.dsh\.dsh-cost.json`），保存后自动生效，无需重启：

```json
{
  "peakMode": "auto",
  "defaultModel": "deepseek-flash",
  "rates": {
    "my-proxy-flash": { "hit": 0.01, "miss": 0.5, "out": 2 }
  }
}
```

| 字段 | 说明 |
|---|---|
| `peakMode` | `"auto"`（默认，按北京时间判峰谷）/ `"always"`（全按高峰价，上限估算）/ `"never"`（全按空闲价） |
| `defaultModel` | `request/header` 缺失时（老日志、非标准调用）用来选价目表的模型名 |
| `rates` | 自定义单价，键是**模型 id 的子串**（最长匹配优先，覆盖内置行），值 `{hit, miss, out}` 为**元/百万 token**；写单个数字表示峰谷同价；键 `_default` 改兜底价 |

账本落在 `$DSH_HOME/.dsh-cost-ledger.json`（逐会话逐轮记录）。删掉它只影响历史显示，下次事件会重新累积。

## 接口

宿主半通过 `ctx.webServer` 提供几个只读路由，同源脚本也能读：

| 路由 | 用途 |
|---|---|
| `GET /dsh-cost/state?sessionId=<id>` | 当前会话 + 全部会话汇总 + 峰谷状态；`sessionId` 不在账本时会回退到最近有记录的会话，并带 `fallback: true` |
| `GET /dsh-cost/rates` | 生效的内置 / 自定义价目表 |
| `GET /dsh-cost/debug` | 最近 12 次 `/state` 请求的完整 URL —— 排查"页面到底有没有在问、问的是哪个 id" |

DSH 的浏览器鉴权栅栏只套在 `/api` 通道上，插件路由不受其影响。

## 开发

```bash
npm test        # 18 项：峰谷边界、价目表最长匹配、真实缓存请求定价、替换语义、账本 JSON 往返
```

目录：

| 文件 | 职责 |
|---|---|
| `lib/pricing.js` | 纯函数计价层：峰谷判定、价目表解析、四桶拆分、费用计算 |
| `lib/ledger.js` | 会话事件折叠成逐轮 / 逐会话账本，含 `(turn, step)` 替换语义与持久化结构 |
| `lib/index.js` | 宿主半：监听 `session/event`、落账本、提供 HTTP 路由 |
| `client.js` | 客户端半：`conversation.composer.dock` 槽位的胶囊与明细弹层 |

技术要点：客户端半是 DSH 的**动态客户端模块**（`window.__ModuleLoader__.load({ id, factory })`），只从冻结平台表 `require('react')`，不 require 任何 Harness 客户端包；样式全部内联且只用 `--dsw-alias-*` 主题 token。

## 已知限制

- **只统计插件启用之后的轮次。** 账本由 `session/event` 实时累积；启用前跑过的旧会话没有历史记录。
- 子代理会话按各自 `sessionId` 单独记账，不计入父会话那一行；总计会一起算。
- fork / resume 出来的会话只累计**本进程内新发生**的事件，被复制的历史前缀不重复计费（与实际计费一致）。

## License

[MIT](LICENSE) © Lopncod
