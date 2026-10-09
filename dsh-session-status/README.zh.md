# dsh-session-status

DeepSeek Harness Web GUI 插件：在侧栏底部常驻一个红/黄/绿状态灯，并在浏览器标签页
标题前加 emoji 前缀、把 favicon 换成同色圆点，一眼看出当前 DSH 是否有进程需要
人工介入、是否正在运行、或完全空闲。

## 状态含义

| 颜色 | 含义 | 判定条件 |
| --- | --- | --- |
| 🔴 红 | **有进程阻塞、需要人工参与** | 任意会话存在待处理的交互（审批 approval / 提问 question / 计划评审 plan-review） |
| 🟡 黄 | **有进程正在运行**（且无阻塞） | 至少一个会话的 Agent 处于运行中 |
| 🟢 绿 | **空闲**（无阻塞、无运行） | 既没有待人工处理，也没有会话在运行 |

判定优先级：`红 > 黄 > 绿`。当某会话既在运行又在等审批时，按规则显示为红色
（阻塞优先），避免把"需要人工"误报成"仅运行中"。

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

**浏览器标签页**（v0.2.0）：在插件生命周期内接管 `document.title` 与 favicon：

- 标题加 emoji 前缀：`🔴 / 🟡 / 🟢 DeepSeek Harness`（tab 标题文字无法染色，
  emoji 是表达颜色的方式）；
- favicon 切换为对应颜色的圆点（内联 SVG data URI，零网络请求、零构建）——
  这是 tab 上**真实着色**的部分，OS 任务栏/dock 上也可见。

实现要点：直接订阅与侧栏灯**同一对**标准 store，无需 React、无需轮询，两处
状态必然一致；`ctx.effect` 的 disposer 在插件卸载 / HMR 重载时自动退订并
**恢复原标题与原 favicon**。Web shell 自身从不写 `document.title`
（`index.html` 的 title 是静态的），无归属冲突；多个浏览器标签各自独立更新
自己的标题。

## 文件结构

```
dsh-session-status/
├── package.json          # dsh.bundle.patch + dsh.client{platform:web}
├── cordis.patch.yml      # 主机侧 Loader 行（- insert: {id, name}）
└── lib/
    ├── index.js          # 主机半：空 apply()（纯 UI 插件，让包进入 Loader）
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

## 激活（重要）

新增的 bundle 只在 **`dsh web` 启动时**被客户端模块扫描器发现（`dsh-client-hmr`
的 `rebuilt` 帧只热替换已存在的条目，`graph` 帧是 no-op，`patchReload: live` 也只
监听两个 `cordis.patch.yml` 文件）。因此安装后必须**重启 web 进程**才会出现指示灯：

```sh
dsh --profile web        # 或 dsh web
```

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
