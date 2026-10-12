# dsh-session-status

DeepSeek Harness Web GUI 插件：在侧栏底部常驻一个红/黄/绿状态灯，并把浏览器
标签页的 favicon 换成同色圆点（标题保持原生不变），一眼看出当前 DSH 是否有
进程需要人工介入、是否正在运行、或完全空闲。

## 状态含义

| 颜色 | 含义 | 判定条件 |
| --- | --- | --- |
| 🔴 红 | **有进程阻塞、需要人工参与** | 任意会话存在待处理的交互（审批 approval / 提问 question / 计划评审 plan-review） |
| 🟡 黄 | **有进程正在运行**（且无阻塞） | 至少一个会话的 Agent 处于运行中 |
| 🟢 绿 | **空闲**（无阻塞、无运行） | 既没有待人工处理，也没有会话在运行 |

判定优先级：`红 > 黄 > 绿`。当某会话既在运行又在等审批时，按规则显示为红色
（阻塞优先），避免把"需要人工"误报成"仅运行中"。

## DSH 0.2.0 兼容（v0.6.0）

本版本跟进 DSH 0.2.0 的设置体系重构：

- **设置模型**：表单现在由各 bundle 插件的 `Config` schema **自动投影**
  （0.2.0 之前的 `settings.register` / `scope.get` / `scope.watch`
  命名空间 API 已移除）。插件因此导出一个零依赖手写 `Config` 节点，满足
  DSH 接触的全部四个面：`~standard.validate`（同步，volatile 字段解析为
  cosmokit 协议的活引用）、扁平 `type`/`dict`/`meta` 走查、叶子 `toJSON()`、
  以及根 `toJSON()` 线格式信封（schemastery 3.18.4 序列化）。命名空间 id
  即 Loader 条目 id（`session-status`）。`~standard` 面与真实 schemastery
   schema 一致地携带 `version: 1` 与 `vendor: "schemastery"`——这是必需的：
   Loader 只对带该 vendor 标记的 schema 执行感知 volatile 的 diff，缺失时
   仅 volatile 字段的写入会被误判为普通配置变更，整体重挂载条目而非就地提交。
- **客户端契约**：`uiSession.pendingInteractions` 被统一的
  `uiSession.sessionStatus` 按会话状态映射取代；设置面从 `settingsScope`
  迁移到共享 `configForms` 服务（`configForms.get("session-status")` →
  `getSnapshot` / `subscribe` / `set`）。
- **热切换**：`iconMode` 与 `bridgeEnabled` 声明为 volatile——设置写入就地
  提交进运行中条目（无需重挂载），插件监听 `loader/volatile-update` 响应。
- **旧值迁移**：0.2.0 之前的全局 `settings.yaml` 中 `session-status:` 段
  会在首次启动时自动迁移（`importLegacyDocument`——旧段 id 与条目 id
  一致）；否则按默认值（`replace` / 桥开启）生效。
- **加载**：*首次安装* bundle 无需重启——运行中的 web 服务会感知
  profile 清单变化（`patchReload: live` 监视 `package.json`，
  `dsh.profile.bundles` 列表变化触发条目树实时调和；已在运行中的
  DSH 0.2.0-rc.2 上实测验证）。*已列 bundle 的版本升级*与*已激活条目
  的宿主侧代码改动*仍需重启 `dsh web`（bundle 列表未变，且宿主模块
  被 ESM loader 缓存）。

## 数据来源（零额外依赖）

只读取 Web 客户端已有的两个**标准数据源**（无需发起任何 RPC，无需新增依赖）：

- `sessions.list`（`SnapshotStore<SessionListState>`）
  → `byId[sessionId].running`：主机侧 Agent 的"运行中"位，由
  `api-session/status` 帧实时更新。侧栏灯经 `useSessions` hook 读取；
  标签页 favicon 直接 `subscribe`/`getSnapshot` 同一 store。
- `uiSession.sessionStatus`（`{getSnapshot, subscribe}` 形态的 store ——
  0.2.0 起**统一**的按会话状态映射 `{running, pendingInteraction,
  completionUnread}`，由 `dsh-client-ui-approval` /
  `dsh-client-ui-user-questions` 经 `registerPendingInteraction` 发布）
  → 任一表项携带 `pendingInteraction` 即存在阻塞。

状态是**全局**的：统计所有会话，而不是只看当前选中会话；即使没有选中任何会话，
指示灯也常驻显示。

## 放置位置

**侧栏**：注册进 `sidebar.footer.action`（root 作用域的列表槽，位于侧栏底部、与
Settings / Cordis 面板并列；即使侧栏折叠成 56px 窄轨也可见）。使用全新
`id: "session-status"`，是**纯增量**添加，不会替换或遮蔽任何出厂 UI。

状态文字（v0.4.1）：侧栏展开时，圆点旁显示当前状态文案——「需人工处理（N）」/
「运行中（N）」/「空闲」，N 为对应会话数；鼠标悬停任意宽度下都有更详细的
tooltip。侧栏折叠成 56px 窄轨时只显示圆点（保持原 20px 视觉，不加内边距），
避免文字被截断。

**浏览器标签页**（v0.2.0 引入；v0.2.1 起仅 favicon；v0.3.0 起两种显示模式可配置）：
在插件生命周期内把 favicon 切换为对应颜色的状态图标（内联 SVG data URI，零网络
请求、零构建）——这是 tab 上**真实着色**的部分，OS 任务栏/dock 上也可见。

> v0.2.0 曾在标题前加 emoji 前缀（`🟢 DeepSeek Harness`），但 emoji 在 tab 上
> 会渲染成紧跟 favicon 的第二个彩色圆，与 favicon 重复成"两个状态图标"，
> v0.2.1 起**标题保持原生不变**，状态仅由 favicon 一个图标表达。

## 标签页图标模式（v0.3.0 起可配置；v0.4.0 起独立成页）

**Settings → 状态监控**（v0.4.0 起为设置面板的独立页面，此前 v0.3.0 挂在「通用」里），
内含「标签页图标」一行，两种模式：

| 模式 | 效果 | 说明 |
| --- | --- | --- |
| **代替原图标**（默认） | 纯色状态圆点 | v0.2.1 的现有行为，原 DSH 图标被隐藏 |
| **与原图标共存** | 原 DSH logo + 右下角状态圆点 | 合成在**单个**内联 SVG 里（logo 路径内联，零网络请求）；logo 颜色随 `prefers-color-scheme` 自动适配明暗主题，状态圆点外圈白色描边保证任意底色下清晰 |

- 选择即时生效并**持久化**到 profile 设置文档（profile patch 的
  `session-status` 段——0.2.0 之前的全局 `settings.yaml` 同名段会在首次启动时
  自动迁移）；跨标签页、跨重启保持。
- 实现走 DSH 原生设置链路（0.2.0 模型）：宿主半导出 bundle 插件的 `Config`
  schema——零依赖的手写 schemastery 兼容节点（`~standard.validate` 同步校验、
  volatile 字段解析为活引用；扁平 `type`/`dict`/`meta` 走查形状；每个叶子带
  `toJSON()`；根 `toJSON()` 信封与 schemastery 3.18.4 序列化逐字节一致，
  客户端用自己的 vendored 拷贝无损 rehydrate）。设置服务**自动**从该 schema
  投影出表单（无需手工注册命名空间——0.2.0 之前的 `settings.register`
  已移除；命名空间 id 即 Loader 条目 id）。浏览器半经共享服务
  `ctx.configForms.get("session-status")` 读取表单（`getSnapshot()` /
  `subscribe()` / `set("iconMode", …)`，与旧 scope 同形），行组件用
  `useSyncExternalStore` 直读。
- **优雅降级**：组合里没有 settings 基础层时（或宿主半尚未随重启生效、scope
  未就绪时），侧栏灯与 favicon 照常工作（默认"代替"模式），设置页不注册 /
  按钮置灰——核心功能从不因设置面缺席而失效。

**设置面板独立页**（v0.4.0）：注册进 `settings.section`（与出厂的「通用 / 模型 / 插件」
页同一槽位，左侧导航栏自动出现「状态监控」入口，未知 section id 回退到齿轮图标，
**零壳改动**）。页面内容 = 页头（标题 + 说明）+「标签页图标」行 +（v0.5.0 起）
「桌面状态桥」开关行（见下节）；浏览器半用 `ctx.get` 软访问 `locale` /
`configForms`，缺席时整页不注册（核心指示灯不受影响）。两行同属
`session-status` 条目配置；桥开关是**顶层**布尔字段 `bridgeEnabled`，
客户端表单用单层 `set()` 即可写入。

实现要点：favicon 逻辑直接订阅与侧栏灯**同一对**标准 store，无需轮询，两处
状态必然一致；`ctx.effect` 的 disposer 在插件卸载 / HMR 重载时自动退订并
**恢复原 favicon**。多个浏览器标签各自独立更新自己的 favicon。壳的
`index.html` 为**每个配色方案各注册一条** icon `<link>`
（`media="(prefers-color-scheme: …)"`，浏览器只采用与当前方案匹配的那条），
因此写入端会更新**全部** icon link，并逐条还原各自的原始 href。

## 桌面状态桥（v0.5.0）

此前指示灯只在浏览器里可见。桌面状态桥让一个**系统托盘小工具**（Windows /
Linux / macOS）在没有浏览器的情况下，把同样的红/黄/绿显示到任务栏上。它复用
你**正在运行**的 web 服务器——**不新增端口、不开 socket、不引入额外传输层**：
宿主半在它上面挂两条**只读**路由。

```
GET /session-status         → 一次 JSON 快照，随后连接关闭
GET /session-status/stream  → SSE：每次状态变化推一帧 + 15 秒保活
```

快照结构：

```json
{ "state": "running", "blocked": 0, "running": 2, "runningIds": ["a","b"], "ts": 1 }
```

`state` 与浏览器侧同一优先级 `红(阻塞) > 黄(运行) > 绿(空闲)`。两个数据源都在
宿主侧，无需额外传输：

- **running** —— 实时 `agents` 注册表，在 `agent/created` / `agent/disposed` /
  `agent/status` 时重算（root 级监听器无 tag，作用域过滤器放行所有 agent 作用域）。
- **blocked** —— 在途的人工请求计数，通过两条纯观测 waterfall tap 统计：
  `approval/request`（工具审批 + 计划评审门）与 `user-questions/request`
  （ask-user / 计划评审提问）。tap 进入时 +1、`finally` 里 -1，因此批准、
  拒绝、中断都自动配平；多余的结算在 0 处钳制。

**安全**：路由仅接受 GET（其余 405）；当 web 服务器绑定到回环之外时，只有
回环来源可读（其余 403）；绑定回环时 socket 本身已限制访问。SSE 并发连接数
有上限（默认 8，超出 503）。桥是**软依赖**：非 web 组合（无 `agents` /
`webServer`）根本不会启动它。

**挂载机制（v0.5.1）**：桥以嵌套插件形式运行，其 `inject` 声明
`agents` + `webServer`，因此 Cordis 只会在同时提供这两个服务的组合里
激活它，其余组合静默跳过。这一点很关键：普通的 `ctx.get("agents")`
对插件**未声明**的服务返回 `undefined`（Cordis 的解析模型：属性读取
要求声明，未声明的查找解析为空）。v0.5.0 的代码正是这么读两个服务的，
守卫因此提前返回，路由在任何一次启动中都没挂上——已用嵌套插件接线
修复。设置**页面策略**（`settings.configure({auto: false})` —— 抑制自动
生成的表单页，因为专属 section 才是 UI 属主）注册在同一个 fiber 内（单一
属主；settings 服务拒绝重复策略）。

**开关**：在 **Settings → 状态监控 → 桌面状态桥** 切换（持久化为 volatile
字段 `bridgeEnabled`）。该字段声明为 **volatile**：设置写入会**就地**提交进
运行中条目的配置引用，Loader 随后向属主 fiber 派发 `loader/volatile-update`
——路由**即时**安装/卸载，**无需重挂载条目**（这是 0.2.0 对旧
settings watcher 的替代）。

**托盘工具**位于本插件**之外**——仓库根目录的 [`../desktop/`](../desktop/)
（所有桌面版本的统一目录，Python 版在
[`../desktop/desktop-python/`](../desktop/desktop-python/)）——单个
`status_tray.py`（Python + pystray），流式读取 SSE 端点并给 🔴/🟡/🟢 托盘图标
换色（桥不可达时显示 ⚪ 灰色）。运行方法见
[`../desktop/desktop-python/README.md`](../desktop/desktop-python/README.md)。
桥的 Node 侧**零依赖**（纯内置模块）；Python 侧只需 pystray + Pillow。

## 文件结构

```
dsh-session-status/
├── package.json          # dsh.bundle.patch + dsh.client{platform:web}
├── cordis.patch.yml      # 主机侧 Loader 行（- insert: {id, name}）
└── lib/
    ├── index.js          # 主机半：插件 Config（设置）+ 桌面状态桥
    ├── bridge.js         # 状态桥：StatusBridge 状态机 + HTTP/SSE 路由
    └── client.js         # 浏览器半：window.__ModuleLoader__.load(...) CJS 包
```

`lib/client.js` 是**手写**的 CJS 包（与出厂 client 插件同构，无需 esbuild/tsdown
构建步骤），唯一的运行时模块依赖是 `react`（浏览器基线种子模块，由 shell 提供）。
CSS 通过 `<style data-plugin>` 注入，配色用 DSW 主题 token
（`--dsw-alias-state-error/warn/success-primary`）并带字面量回退，明暗主题均可读。

## 安装

```sh
# 在插件目录外（插件以 link 方式接入 profile 的 node_modules）：
dsh plugin --profile web add /path/to/dsh-session-status
```

该命令会通过 pnpm 把插件装进 profile 的 `node_modules`，并自动把
`dsh-session-status` 追加进 `dsh.profile.bundles`（主机半与浏览器半一次接好）。

## 激活（实时生效——已在 DSH 0.2.0-rc.2 实测）

**首次安装无需重启。** `patchReload: live` 下，运行中的 web 服务会监视 profile
清单（`package.json`）：`dsh.profile.bundles` 列表变化触发 Loader 条目树实时调和，
宿主半（桥路由 + 页面策略）被激活、client 图被重新扫描——侧栏灯、标签页 favicon
与 `/session-status` 端点会在安装后数秒内出现在**已在运行**的实例中。

仍需 **`dsh web` 重启**（`dsh --profile web`）的情形：

- **升级**已列 bundle 到新版本（bundle 列表未变，清单监视器保持静默）；
- **宿主侧代码改动**作用于已激活条目——宿主模块被 ESM loader 缓存（HMR 模块根
  监视是可选项，出厂 web profile 未开启）。

客户端 bundle 的改动则不同：`client-hmr` 宿主传输对图中每个 client bundle 做
~500ms 的 stat 轮询，变化时重建 combo 并经 `/plugins/events` 推送 `graph` 帧，
浏览器半会在**已打开的页面**内热替换。

> 注意：重启会结束当前正在该 web 进程内运行的会话。

## 卸载

```sh
dsh plugin --profile web remove dsh-session-status
```

## 已知限制

- 状态为全局聚合，不区分"哪个"会话在阻塞；点击无跳转（当前版本仅作状态提示）。
  如需定位具体会话，可配合已内置的"后台任务 / 审批面板"查看。
- "排队中（queued）但未开始运行"的任务按"无运行"计，显示为绿色；这符合
  "没有进程正在运行即为绿色"的字面定义。
