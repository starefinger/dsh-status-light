# dsh-session-status

DeepSeek Harness Web GUI plugin: a persistent red/yellow/green status dot in the
sidebar footer that shows, at a glance, whether DSH has a process waiting on a
human, a process running, or nothing going on.

| Color | Meaning | Condition |
| --- | --- | --- |
| 🔴 red | **Blocked — human input needed** | any session has a pending interaction (approval / question / plan-review) |
| 🟡 yellow | **Running** (and nothing blocked) | at least one session's agent is running |
| 🟢 green | **Idle** (no blocked, no running) | neither |

Precedence is `red > yellow > green`: a session that is running *and* waiting on
an approval shows red.

## Data source (zero extra dependencies)

Reads only two standard client render props (no RPC, no added deps):

- `useSessions` → `byId[sessionId].running` (the host agent-running bit, kept live
  by `api-session/status` frames).
- `useSessionPendingInteraction` → `ReadonlyMap<SessionId, interaction>` (the set
  of sessions awaiting a human, registered by `dsh-client-ui-approval` /
  `dsh-client-ui-user-questions` into the `uiSession` pending-interaction domain).

The status is **global** across all sessions, and stays visible even with no
session selected.

## Placement

Registers into `sidebar.footer.action` (a root-scoped, always-visible list slot at
the sidebar foot, beside Settings / the Cordis panel; visible even when the
sidebar collapses to the 56px rail). Uses a fresh `id: "session-status"`, so it is
purely additive and shadows no shipped UI.

## Layout

```
dsh-session-status/
├── package.json          # dsh.bundle.patch + dsh.client{platform:web, inject:[slots]}
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
