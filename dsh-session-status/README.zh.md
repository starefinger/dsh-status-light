# dsh-status-light（dsh-session-status）

> npm 包名：**`dsh-status-light`** · 仓库目录 / 本地安装路径：`dsh-session-status/` ·
> 设置命名空间 + Loader 行 id：`session-status`。npm 上的 `dsh-session-status`
> 已被一个不相关的项目占用，所以发布包名为 `dsh-status-light`。

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

> ⚠️ **DSH 版本兼容性（v0.5.1）——已知问题：在 DSH 0.2.0 上无法工作。**
> DSH 0.2.0 下插件加载失败，并可能导致 **web GUI 无法启动**；DSH **0.1.5**
> 下运行正常。在发布兼容版本之前，请继续使用 DSH 0.1.5，或先移除插件
> （`dsh plugin --profile web remove dsh-status-light`）再重启。

## 数据来源（零额外依赖）

只读取 Web 客户端已有的两个**标准数据源**（无需发起任何 RPC，无需新增依赖）：

- `sessions.list`（`SnapshotStore<SessionListState>`）
  → `byId[sessionId].running`：主机侧 Agent 的"运行中"位，由
  `api-session/status` 帧实时更新。侧栏灯经 `useSessions` hook 读取；
  tab 标题直接 `subscribe`/`getSnapshot` 同一 store。
- `uiSession.pendingInteractions`（`{getSnapshot, subscribe}` 形态的 store，
  由 `dsh-client-ui-approval` / `dsh-client-ui-user-questions` 等写入）
  → 当前等待人工输入的会话集合。`map.size > 0` 即存在阻塞。

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

- 选择即时生效并**持久化**到 DSH 设置文档（`$DSH_HOME/settings.yaml`，宿主侧
  `session-status` 命名空间，`dsh-settings-file` 提供方热加载）；跨标签页、跨
  重启保持。
- 实现走 DSH 原生设置链路：宿主半 `ctx.settings.register("session-status", …)`
  注册命名空间（schema 为零依赖的手写 schemastery 兼容节点：可调用解析器 +
  `toJSON()` 冻结信封，信封与真实 schemastery 序列化逐字节一致，客户端用自己的
  vendored schemastery 无损 rehydrate）；浏览器半 `ctx.settingsScope.bind({namespace})`
  绑定 scope，行组件用 `useSyncExternalStore` 直读 scope，点击走 `scope.set("iconMode", …)`
  （revision 围栏写入，冲突不会互相覆盖）。
- **优雅降级**：组合里没有 settings 基础层时（或宿主半尚未随重启生效、scope
  未就绪时），侧栏灯与 favicon 照常工作（默认"代替"模式），设置页不注册 /
  按钮置灰——核心功能从不因设置面缺席而失效。

**设置面板独立页**（v0.4.0）：注册进 `settings.section`（与出厂的「通用 / 模型 / 插件」
页同一槽位，左侧导航栏自动出现「状态监控」入口，未知 section id 回退到齿轮图标，
**零壳改动**）。页面内容 = 页头（标题 + 说明）+「标签页图标」行 +（v0.5.0 起）
「桌面状态桥」开关行（见下节）；浏览器半用 `ctx.get` 软访问 `locale` /
`settingsScope`，缺席时整页不注册（核心指示灯不受影响）。两行同属
`session-status` 命名空间；桥开关是**顶层**布尔字段 `bridgeEnabled`，
客户端 scope 用单层 `set()` 即可写入。

实现要点：favicon 逻辑直接订阅与侧栏灯**同一对**标准 store，无需轮询，两处
状态必然一致；`ctx.effect` 的 disposer 在插件卸载 / HMR 重载时自动退订并
**恢复原 favicon**。多个浏览器标签各自独立更新自己的 favicon。

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
修复。`session-status` 设置命名空间注册在同一个 fiber 内（单一属主；
settings 服务拒绝重复注册）。

**开关**：在 **Settings → 状态监控 → 桌面状态桥** 切换（持久化为
`bridgeEnabled`，由 settings watcher 热加载），端点即时出现/消失；宿主半仍
只在 `dsh web` 启动时加载一次，因此新装需要重启一次。

**托盘工具**位于本插件**之外**——源码仓库的 `desktop/` 目录（所有桌面版本的
统一目录，Python 版在 `desktop/desktop-python/`）——单个
`status_tray.py`（Python + pystray），流式读取 SSE 端点并给 🔴/🟡/🟢 托盘图标
换色（桥不可达时显示 ⚪ 灰色）。它**不在 npm 包内**——请从源码仓库获取，
运行方法见其 README。桥的 Node 侧**零依赖**（纯内置模块）；
Python 侧只需 pystray + Pillow。

## 文件结构

```
dsh-session-status/          ← 仓库目录名（npm 包名：dsh-status-light）
├── package.json          # dsh.bundle.patch + dsh.client{platform:web}
├── cordis.patch.yml      # 主机侧 Loader 行（- insert: {id, name}）
└── lib/
    ├── index.js          # 主机半：settings 命名空间 + 桌面状态桥
    ├── bridge.js         # 状态桥：StatusBridge 状态机 + HTTP/SSE 路由
    └── client.js         # 浏览器半：window.__ModuleLoader__.load(...) CJS 包
```

`lib/client.js` 是**手写**的 CJS 包（与出厂 client 插件同构，无需 esbuild/tsdown
构建步骤），唯一的运行时模块依赖是 `react`（浏览器基线种子模块，由 shell 提供）。
CSS 通过 `<style data-plugin>` 注入，配色用 DSW 主题 token
（`--dsw-alias-state-error/warn/success-primary`）并带字面量回退，明暗主题均可读。

## 安装

> `dsh plugin` 是 pnpm 的薄转发层：在你的 profile 目录
> （`$DSH_HOME/profiles/web`）里执行 `pnpm add <spec>`，并在包声明
> `dsh.bundle` 时自动追加进 `dsh.profile.bundles`——主机半与浏览器半一次接好。

### 从 npm（已发布）

```sh
dsh plugin --profile web add dsh-status-light
```

可锁定版本（`dsh-status-light@0.5.1`），或指定私有 registry
（`add --registry <url> dsh-status-light`）。升级：
`dsh plugin --profile web update dsh-status-light`。

### 从 git

```sh
dsh plugin --profile web add github:<owner>/dsh-session-status          # 默认分支
dsh plugin --profile web add github:<owner>/dsh-session-status#v0.5.1   # 锁 tag
```

> 若仓库将来加入构建用的 `prepare` 脚本，pnpm 默认拦截依赖的安装脚本——
> `dsh plugin` 会打印需要加入 profile `pnpm-workspace.yaml` 的 `allowBuilds`
> key，加上后重跑即可。（npm 发布的包是预构建的，无构建步骤，不会触发。）

### 从本地 checkout（开发）

```sh
dsh plugin --profile web add /path/to/dsh-session-status
```

插件以 `link:` 方式接入 profile 的 `node_modules`；改动仓库后在下次
`dsh web` 启动时生效（HMR 只热替换已知的浏览器 bundle，见下节「激活」）。

## 激活（重要）

新增的 bundle 只在 **`dsh web` 启动时**被客户端模块扫描器发现（`dsh-client-hmr`
的 `rebuilt` 帧只热替换已存在的条目，`graph` 帧是 no-op，`patchReload: live` 也只
监听两个 `cordis.patch.yml` 文件）。因此安装后必须**重启 web 进程**才会出现指示灯：

```sh
dsh --profile web        # 或 dsh web
```

> 注意：重启会结束当前正在该 web 进程内运行的会话。

## 发布

插件零依赖且为预构建（浏览器 bundle 是手写的），发布就是普通的 npm 发布：

```sh
cd dsh-session-status
npm publish --access public        # 首次发布：认领包名
npm version patch && npm publish   # 后续发版
```

`files` 字段限定 tarball 内容只有 `lib/`、`cordis.patch.yml` 和两份 README。
包名为 `dsh-status-light`，因为 npm 上的 `dsh-session-status` 已被一个
不相关的项目占用。

## 卸载

```sh
dsh plugin --profile web remove dsh-status-light
```

卸载按已安装状态对账，条目会自动从 `dsh.profile.bundles` 移除。

## 已知限制

- 状态为全局聚合，不区分"哪个"会话在阻塞；点击无跳转（当前版本仅作状态提示）。
  如需定位具体会话，可配合已内置的"后台任务 / 审批面板"查看。
- "排队中（queued）但未开始运行"的任务按"无运行"计，显示为绿色；这符合
  "没有进程正在运行即为绿色"的字面定义。
