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

State text (v0.4.1): with the sidebar expanded, the dot is followed by the
current state label — 需人工处理（N） / 运行中（N） / 空闲 — where N is the
matching session count; a more detailed tooltip is always available on
hover. In the 56px collapsed rail the chip shows the bare dot only (no padding,
the original 20px look) so the label is never clipped.

**Browser tab** (v0.2.0; favicon-only since v0.2.1; two configurable modes since
v0.3.0) — for the lifetime of the plugin the favicon swaps to a status icon of the
matching color (an inline SVG data URI — no network, no build). This is the
genuinely *colored* part of the tab, and it shows in the OS taskbar/dock too.

> v0.2.0 also prefixed `document.title` with an emoji (`🟢 DeepSeek Harness`),
> but the emoji renders in the tab as a second colored dot right beside the
> favicon — two status icons side by side. Since v0.2.1 the **title is left
> untouched** and the favicon alone carries the state.

## Tab-icon mode (configurable in Settings; its own page since v0.4.0)

A dedicated **Settings → Status** page (a full section in the settings nav rail —
it lived under *General* in v0.3.0) holds a **"Tab favicon"** row offering two
modes:

| Mode | Effect | Notes |
| --- | --- | --- |
| **Replace the original icon** (default) | a solid state dot | the existing v0.2.1 behavior — the original DSH icon is hidden |
| **Keep the original icon** | the original DSH logo + a state dot at its bottom-right | composed in a *single* inline SVG (the logo path is inlined — no network); the logo fill adapts to light/dark via `prefers-color-scheme`, and the dot has a white ring so it stays legible on any background |

- The choice takes effect immediately and **persists** to the DSH settings
  document (`$DSH_HOME/settings.yaml`, the host `session-status` namespace,
  hot-reloaded by the `dsh-settings-file` provider) — it survives across tabs and
  restarts.
- It rides DSH's native settings chain: the host half does
  `ctx.settings.register("session-status", …)` (the schema is a hand-rolled,
  dependency-free schemastery-compatible node — a callable resolver plus a frozen
  `toJSON()` envelope byte-identical to real schemastery serialization, which the
  browser rehydrates with its own vendored copy); the browser half binds
  `ctx.settingsScope.bind({ namespace })`, reads the scope with
  `useSyncExternalStore`, and writes with `scope.set("iconMode", …)`
  (revision-fenced — concurrent writes reject rather than clobber).
- **Graceful degradation**: if the settings base layer is absent (or the host half
  has not taken effect across a restart yet, so the scope is not ready), the
  sidebar dot and favicon keep working (defaulting to the *replace* mode) and the
  settings page is simply not registered / its buttons are disabled — the core
  indicator never breaks because the settings surface is missing.

**Dedicated settings page** (v0.4.0): the plugin registers into `settings.section`
— the same seat the shipped General / Models / Plugins pages use — so the nav rail
shows a **Status monitoring** entry with **zero shell changes** (an unknown
section id falls back to the gear glyph). The page content is a header (title +
intro) plus the tab-icon row; the browser half reaches `locale` /
`settingsScope` through `ctx.get` (soft access), so a composition without them
simply has no page.

Implementation note: the favicon logic subscribes to the **same** two standard
stores the sidebar dot reads (no React, no polling), so the two never disagree;
the `ctx.effect` disposer unsubscribes and **restores the original favicon** on
plugin disposal / HMR swap; each browser tab updates its own favicon
independently.

## Layout

```
dsh-session-status/
├── package.json          # dsh.bundle.patch + dsh.client{platform:web}
├── cordis.patch.yml      # host Loader row (- insert: {id, name})
└── lib/
    ├── index.js          # host half: registers the session-status settings namespace (zero-dep schema)
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
