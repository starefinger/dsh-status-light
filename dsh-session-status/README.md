# dsh-session-status

DeepSeek Harness Web GUI plugin: a persistent red/yellow/green status dot in the
sidebar footer, plus a matching colored browser-tab favicon (the title is left
untouched), showing at a glance whether DSH has a process waiting on a human, a
process running, or nothing going on.

| Color | Meaning | Condition |
| --- | --- | --- |
| 🔴 red | **Blocked — human input needed** | any session has a pending interaction (approval / question / plan-review) |
| 🟡 yellow | **Running** (and nothing blocked) | at least one session's agent is running |
| 🟢 green | **Idle** (no blocked, no running) | neither |

Precedence is `red > yellow > green`: a session that is running *and* waiting on
an approval shows red.

## Data source (zero extra dependencies)

Reads only two standard client stores (no RPC, no added deps):

- `sessions.list` (`SnapshotStore<SessionListState>`) →
  `byId[sessionId].running` (the host agent-running bit, kept live by
  `api-session/status` frames). The sidebar dot reads it through the
  `useSessions` hook; the tab favicon subscribes to the same store directly.
- `uiSession.pendingInteractions` (a `{getSnapshot, subscribe}` store written by
  `dsh-client-ui-approval` / `dsh-client-ui-user-questions`) → the set of sessions
  awaiting a human. `map.size > 0` means blocked.

The status is **global** across all sessions, and stays visible even with no
session selected.

## Placement

**Sidebar** — registers into `sidebar.footer.action` (a root-scoped,
always-visible list slot at the sidebar foot, beside Settings / the Cordis panel;
visible even when the sidebar collapses to the 56px rail). Uses a fresh
`id: "session-status"`, so it is purely additive and shadows no shipped UI.

**Browser tab** (v0.2.0, favicon-only since v0.2.1) — for the lifetime of the
plugin the favicon swaps to a solid dot of the matching color (an inline SVG
data URI — no network, no build). This is the genuinely *colored* part of the
tab, and it shows in the OS taskbar/dock too.

> v0.2.0 also prefixed `document.title` with an emoji (`🟢 DeepSeek Harness`),
> but the emoji renders in the tab as a second colored dot right beside the
> favicon — two status icons side by side. Since v0.2.1 the **title is left
> untouched** and the favicon alone carries the state.

Implementation note: it subscribes to the **same** two standard stores the
sidebar dot reads (no React, no polling), so the two never disagree; the
`ctx.effect` disposer unsubscribes and **restores the original favicon** on
plugin disposal / HMR swap; each browser tab updates its own favicon
independently.

## Layout

```
dsh-session-status/
├── package.json          # dsh.bundle.patch + dsh.client{platform:web}
├── cordis.patch.yml      # host Loader row (- insert: {id, name})
└── lib/
    ├── index.js          # host half: empty apply() (pure UI plugin)
    └── client.js         # browser half: window.__ModuleLoader__.load(...) CJS bundle
```

`lib/client.js` is hand-authored CJS in the same shape as the shipped client
plugins (no esbuild/tsdown build step); the only runtime module it requires is
`react` (a browser baseline seed provided by the shell). CSS is injected via a
`<style data-plugin>` tag using DSW theme tokens with literal fallbacks.

## Install

```sh
dsh plugin --profile web add /path/to/dsh-session-status
```

Installs into the profile `node_modules` (as a `link:`) and auto-appends
`dsh-session-status` to `dsh.profile.bundles` — wiring both halves at once.

## Activation (important)

A *new* bundle is discovered only at **`dsh web` boot** (the `dsh-client-hmr`
`rebuilt` frame hot-swaps only already-known entries; `graph` frames are no-ops;
`patchReload: live` only watches the two `cordis.patch.yml` files). So restart the
web process to see the indicator:

```sh
dsh --profile web
```

> Note: restarting ends any session currently running inside that web process.

## Uninstall

```sh
dsh plugin --profile web remove dsh-session-status
```
