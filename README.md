# wb-credits — DSH 插件：对话底部显示 WorkBuddy 积分

在 DSH Web 的对话输入卡片下方显示 WorkBuddy 反代网关的**剩余总积分**，
有模型被 6004 限流时显示**限流徽标**，鼠标悬停展开**各账号池余额明细**，
流式输出时显示**最近 8s 的输出速度**（估算 tok/s）。

## 当前进度

| 指标 | 状态 |
|---|---|
| 剩余总积分 | ✅ 已实现（轮询，30s） |
| 模型限流徽标（6004 台账） | ✅ 已实现（轮询，60s，悬停展开明细） |
| 悬停账号池余额明细 | ✅ 已实现（原生 title，零依赖） |
| 最近输出速度（估算 tok/s） | ✅ 已实现（订阅会话流式快照，8s 滑动窗口，空闲隐藏） |
| 每次对话消耗的积分 | ⏳ 待做，见文末「后续」 |
| 当前会话累计消耗 | ⏳ 待做，见文末「后续」 |

## 界面元素

```
[● 限流 2]  [输出 42 tok/s]  WorkBuddy 剩余积分 5,770 / 10,901 · 已用 5,131
```

- **限流徽标**（左侧琥珀色）：仅当网关 `/status` 的模型级限流台账
  （`accounts[].rate_limited_models[]`，6004 用量超限触发的模型级独立冷却）非空时显示。
  悬停展开：受影响账号数、上游权威重置时间（`reset_at`，「将在 X 重置」的滚动 24h 墙钟）、
  网关侧冷却截止（`until`，可能被 `soft_rate_max` 截断，仅供对照）。
  多账号同模型聚合成一行，恢复时间取最晚者。无限流时徽标不占位。
- **最近输出速度**：`输出 N tok/s`，最近 8 秒滑动窗口内的输出速率估算。
  与 DSH 自带的 TPS（整轮平均 `outputTokens ÷ decodeMs`）**互补**——自带值会被
  历史轮次摊平，换慢模型后长时间显示旧平均；这里看的是"此刻"。仅在窗口内有
  输出增量时渲染（空闲、思考停顿、工具执行中自动消失）。
  数据通路：dock 插槽按会话解析 `uiConversation.binding(sid).target('chat')`，
  订阅 chat 视图快照的 `legacy.partial`（流式期间随 animation-frame 更新的累积
  text/reasoning/tool-call blocks）；token 数按字符折算（CJK 1 字 ≈ 1 token、
  拉丁 ≈ 5.2 字符/token，流式期间拿不到精确 usage，收尾帧才有）。
- **悬停明细**：鼠标放到整行上，原生 title 展开「账号池余额明细」——每个账号的
  剩余/已用/总额（失败账号带原因），底部附刷新时间。用原生 `title` 而非弹层：
  零依赖、不挡视线、随 30s 轮询自动更新。

## 架构

```
浏览器 (DSH :18080)                 Host 进程 (node)              workbuddy2api (:7863)
┌──────────────────────┐          ┌───────────────────┐        ┌──────────────────────┐
│ CreditsDock 组件      │  fetch   │ /api/workbuddy.   │ fetch  │ GET /credits         │
│ slot:                │ ───────► │     credits       │ ─────► │  （realm 感知的上游   │
│ conversation.        │          │  /api/workbuddy.  │        │    计费查询 + TTL 缓存）│
│ composer.dock        │          │     status        │ fetch  │ GET /status          │
│  · 积分行（悬停明细）  │ ◄─────── │  读取 config.json │ ─────► │  （账号池 + 模型限流   │
│  · 模型限流徽标       │   JSON   │  里的 api_key     │ ◄───── │    台账，30s 实时）    │
└──────────────────────┘          └───────────────────┘        └──────────────────────┘
```

**为什么不让浏览器直连网关**：一是跨源（18080 → 7863）会被 CORS 拦；二是那会把网关
API Key 暴露在页面里。走 Host 代理两点都避免 —— 密钥只存在于 Host 进程内存中。

## 组成

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 半边：注册受 DSH 鉴权保护的 `GET /api/workbuddy.credits` 与 `GET /api/workbuddy.status`（模型限流聚合） |
| `lib/client.js` | 浏览器半边：`__ModuleLoader__` 工厂格式的 bundle，挂到 `conversation.composer.dock`（积分行 + 限流徽标 + 悬停明细 + 最近输出速度） |
| `package.json` | 声明 `dsh.bundle.patch`（标准 bundle）、`dsh.client`（platform/immediately/inject）、`icon` 与 `exports` |
| `cordis.patch.yml` | bundle patch：按包名插入 `wb-credits` 一行 |
| `locale/en.json` / `locale/zh.json` | 插件清单显示的标题与描述（不激活插件即可读） |
| `icon.svg` | 插件图标（相对路径，≤256 KiB） |
| `selftest.mjs` | 静态自测：bundle/client 声明、icon、locale 是否满足 app-boot 的校验规则 |
| `hosttest.mjs` | 集成测试：假 ctx 驱动 host 半边，内置 mock 网关跑确定性断言（聚合口径 / 502 / 卸载），末尾对真机各探测一枪 |

浏览器半边用 `react.createElement` 而非 JSX，因此**不需要 react/jsx-runtime，
也不需要任何构建工具链**（bundle 是手写的工厂格式，不是 ESM）。

## 安装

本包是一个标准 DSH bundle：`package.json` 声明 `dsh.bundle.patch`，
由自带的 `cordis.patch.yml` 按**包名**挂载。装进 profile 后即可被
Plugin Manager 识别（清单、启停、卸载、配置 schema）。

```powershell
# 从本地目录安装（开发时）
dsh plugin --profile <profile> add /path/to/wb-credits

# 或从 git 安装（公开仓库）
dsh plugin --profile <profile> add github:anneqaq/wb-credits
```

该命令转发给 pnpm，并自动写入 profile 的 `dependencies` 与 `dsh.profile.bundles`。
改动需重启 DSH（`patchReload: live` 时部分改动可热生效）。

浏览器半边声明依赖 `slots`（挂载插槽）与 `uiConversation`（按会话订阅 chat 视图快照测速）。

> **不要再在 profile 的 `cordis.patch.yml` 里手写绝对路径 insert 行。**
> patch 的 `insert` 不去重（app-boot `data.push(...insert)`），bundle 层与本层
> 各插一条同 id 行会让插件挂载两次，Host 侧 `connection.fetch.register`
> 报 duplicate route 而挂载失败。只有在**不想装包**、只想直接挂源码目录做开发时，
> 才临时用绝对路径形式（见 `cordis.patch.yml` 注释）。

## 配置

patch 条目可传 `config` 覆盖默认值：

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:7863` | 网关地址 |
| `apiKey` | 空 | 显式密钥；不建议写在 patch 里（会进版本库） |
| `apiKeyEnv` | `WORKBUDDY_API_KEY` | 从哪个环境变量读密钥 |
| `projectDir` | 空 | 网关项目目录；给定时从它的 `config.json` 读 `api_key` |
| `timeoutMs` | `30000` | 查询网关的超时 |

密钥解析优先级：`config.apiKey` → `apiKeyEnv` → `projectDir/config.json`。

**密钥必须配**：workbuddy2api 的 `/credits` 强制校验 API Key，无鉴权会返回
`401 invalid_api_key`。推荐用环境变量（不进版本库）：

```powershell
$env:WORKBUDDY_API_KEY = '<your-gateway-api-key>'
```

或者指向网关目录，让插件自己读它的 `config.json`。**包内不内置任何机器上的
绝对路径** —— `projectDir` 默认空，需要时用上面的 `config` 或环境变量
`WB_CREDITS_PROJECT_DIR` 指定。


## 显示元数据

| 项 | 位置 |
|---|---|
| 标题 / 描述 | `locale/en.json`（基准）+ `locale/zh.json` |
| 图标 | `package.json` 顶层 `icon` → `./icon.svg` |

这些字段**不激活插件**即可被 Hello 面板与插件清单读取；缺失时回退成裸包名与
`description`、图标用面板默认图。

## 依赖的网关端点

本插件依赖 workbuddy2api 的 `GET /credits`（`internal/server/handler.go`）：

```json
{"service":"workbuddy","ts":1789620787,
 "accounts":[{"uid":"...","nickname":"vva","realm":"cn","remain":1576,"used":3924,"size":5500,"ok":true}],
 "total":{"accounts":1,"failed":0,"ok":1,"remain":1576,"size":5500,"used":3924}}
```

带 TTL 缓存（60s），避免前端轮询把上游计费接口打限流。

### 依赖的网关端点（模型限流徽标）

网关 `GET /status`（`internal/server/handler.go`，模型级台账见 `internal/pool/entry.go`
`Status.RateLimitedModels`，issue #36）：

```json
{"accounts":[{"uid":"...","rate_limited_models":[{"model":"glm-5.2","until":"...","reset_at":"...","reason":"..."}]}], ...}
```

插件 Host 半边按模型聚合（同模型多账号取最晚 `reset_at`/`until`，计数受影响账号），
经 `/api/workbuddy.status` 透给前端。**口径注意**：`reset_at` 是上游「将在 X 重置」的
权威墙钟（滚动 24h 窗口）；`until` 是网关自己的保守退避截止，可能早于上游重置——
徽标明细里两者都展示，以 `reset_at` 为准。

## 验证

```powershell
cd <plugin-dir>
node .\selftest.mjs    # 声明、bundle 语法、双端点路径一致性静态检查
node .\hosttest.mjs    # host 端点：内置 mock 网关跑确定性断言 + 真机探测（[INFO]）
# 真机探测只在网关未启动时需要跳过：
$env:WB_CREDITS_LIVE='0'; node .\hosttest.mjs
```

两个测试都**不需要网关在跑**：hosttest 自带 mock 网关，末尾的真机探测只是
`[INFO]`、不参与通过/失败。

## 卸载

```powershell
dsh plugin --profile <profile> remove wb-credits
```

若曾用绝对路径 insert 行手工挂载，另需从 profile 的 `cordis.patch.yml`
删掉那一行，然后重启 DSH。

## 后续：每次对话 / 会话累计的积分消耗

这两项卡在一个数据通路上：上游 `usage.credit` 会被两层固定字段映射丢掉。

1. 网关 SSE 最后一帧**带** `credit`：
   `"usage":{"completion_tokens":23,...,"credit":0,"total_tokens":55}`
2. pi-ai 的 `parseChunkUsage()`
   （`@earendil-works/pi-ai/dist/api/openai-completions.js:1178`）只取白名单字段，
   **丢弃 `credit`**
3. `dsh-llm-pi-ai` 再映射成 DSH 的 `TokenUsage`（只有 input/output/cache/reasoning），
   **同样没有 credit**

要拿到精确值，需在两处各加 1~2 行把 `credit` 透传出来：

- `parseChunkUsage` 的返回对象里加 `credit: rawUsage.credit`
- 适配器 usage 映射（`dsh-llm-pi-ai/lib/index.js:1362` 附近）把它带进 `TokenUsage`

两处都是 node_modules 内的文件，**DSH 升级后会被覆盖**，需要重新施打。
届时会附一个幂等的重打脚本。
