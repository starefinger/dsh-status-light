# dsh-status-light (dsh-session-status)

> npm package: **`dsh-status-light`** · repo folder / local install path:
> `dsh-session-status/` · settings namespace + loader row id: `session-status`.
> The npm name `dsh-session-status` is taken by an unrelated project, so the
> published package is `dsh-status-light`.

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
shows a **Status monitoring** (状态监控) entry with **zero shell changes** (an unknown
section id falls back to the gear glyph). The page content is a header (title +
intro) plus the **tab-icon row** and, since v0.5.0, a **desktop status bridge**
toggle row (see below); the browser half reaches `locale` /
`settingsScope` through `ctx.get` (soft access), so a composition without them
simply has no page. Both rows live in the same `session-status` namespace; the
bridge field is a top-level `bridgeEnabled` boolean so the client scope can
write it with its single-level `set()`.

Implementation note: the favicon logic subscribes to the **same** two standard
stores the sidebar dot reads (no React, no polling), so the two never disagree;
the `ctx.effect` disposer unsubscribes and **restores the original favicon** on
plugin disposal / HMR swap; each browser tab updates its own favicon
independently.

## Desktop status bridge (v0.5.0)

The indicator so far only shows in the browser. The desktop bridge lets a
**system-tray tool** (Windows / Linux / macOS) show the same red / yellow /
green on your taskbar without a browser. It reuses the web server you are
**already** running — **no new port, no socket, no extra transport**: the host
half mounts two **read-only** routes on it.

```
GET /session-status         → one JSON snapshot, then the connection closes
GET /session-status/stream  → SSE: a frame per state change + 15 s keepalive
```

Snapshot shape:

```json
{ "state": "running", "blocked": 0, "running": 2, "runningIds": ["a","b"], "ts": 1 }
```

`state` uses the same `blocked > running > idle` precedence. The two data
sources are host-side and need no extra transport:

- **running** — the live `agents` registry, recomputed on `agent/created` /
  `agent/disposed` / `agent/status` (a root-level listener is untagged, so the
  scope filter admits it for every agent scope).
- **blocked** — human requests in flight, counted through two pure-observation
  waterfall taps on `approval/request` (tool approvals + plan-review gates) and
  `user-questions/request` (ask-user / plan-review questions). A tap
  increments on entry and decrements in a `finally`, so answers, rejections,
  and aborts all self-balance; a stray settle clamps at 0.

**Safety.** The route is GET-only (405 otherwise) and, when the web server
binds beyond loopback, only loopback sources may read it (403 otherwise); on a
loopback bind the socket already restricts access. Stream clients are capped
(default 8) — extra connections get 503. The bridge is a **soft** dependency:
a non-web composition (no `agents` / `webServer`) simply never starts it.

**How it mounts (v0.5.1).** The bridge runs as a nested plugin whose
`inject` declares `agents` + `webServer`, so Cordis activates it only in a
composition that provides both — and silently skips every other one. This
matters because a plain `ctx.get("agents")` lookup returns `undefined` for a
service the plugin has *not* declared in `inject` (the Cordis resolution
model: property reads require the declaration; undeclared lookups resolve to
nothing). The v0.5.0 code read both services that way, so its guard
early-returned and the route never mounted on any boot — fixed by the
nested-plugin wiring. The `session-status` settings namespace is registered
inside the same fiber (single owner; the settings service rejects duplicate
registrations).

**Enable / disable.** Toggle it from **Settings → 状态监控 → 桌面状态桥**
(persisted as `bridgeEnabled`, hot-reloaded by the settings watcher). The
endpoint appears/disappears immediately; the host half still loads once at
`dsh web` boot, so a fresh install needs a restart.

**The tray tool** lives **outside** this plugin, in the source repo's `desktop/`
folder (a home for all desktop versions; the Python one is
`desktop/desktop-python/`) — a single `status_tray.py` (Python + pystray) that
streams the SSE endpoint and recolors a 🔴/🟡/🟢 tray icon (⚪ gray when the
bridge is unreachable). It is **not part of the npm package** — fetch it from
the source repo and see its README to run it. The Node side of the bridge has
**zero dependencies** (built-ins only); the Python side needs only pystray +
Pillow.

## Layout

```
dsh-session-status/          ← repo folder name (npm package: dsh-status-light)
├── package.json          # dsh.bundle.patch + dsh.client{platform:web}
├── cordis.patch.yml      # host Loader row (- insert: {id, name})
└── lib/
    ├── index.js          # host half: settings namespace + the desktop status bridge
    ├── bridge.js         # the bridge: StatusBridge state machine + the HTTP/SSE route
    └── client.js         # browser half: window.__ModuleLoader__.load(...) CJS bundle
```

`lib/client.js` is hand-authored CJS in the same shape as the shipped client
plugins (no esbuild/tsdown build step); the only runtime module it requires is
`react` (a browser baseline seed provided by the shell). CSS is injected via a
`<style data-plugin>` tag using DSW theme tokens with literal fallbacks.

## Install

> `dsh plugin` is a thin pnpm forwarder: it runs `pnpm add <spec>` in your
> profile directory (`$DSH_HOME/profiles/web`) and auto-appends the package to
> `dsh.profile.bundles` when it declares `dsh.bundle` — wiring the host and
> browser halves at once.

### From npm (published)

```sh
dsh plugin --profile web add dsh-status-light
```

Pin a version (`dsh-status-light@0.5.1`) or use a custom registry
(`add --registry <url> dsh-status-light`). To upgrade later:
`dsh plugin --profile web update dsh-status-light`.

### From git

```sh
dsh plugin --profile web add github:<owner>/dsh-session-status   # default branch
dsh plugin --profile web add github:<owner>/dsh-session-status#v0.5.1
```

> If the repo ever adds a build `prepare` script, pnpm blocks install scripts
> by default — `dsh plugin` prints the exact `allowBuilds` key to add to the
> profile's `pnpm-workspace.yaml`; add it and re-run. (The published package
> ships prebuilt: no build step, so this never fires for the npm install.)

### From a local checkout (development)

```sh
dsh plugin --profile web add /path/to/dsh-session-status
```

Installs into the profile `node_modules` (as a `link:`) — edit the repo, the
profile picks it up on the next `dsh web` boot (HMR hot-swaps only the already
known browser bundle; see Activation below).

## Activation (important)

A *new* bundle is discovered only at **`dsh web` boot** (the `dsh-client-hmr`
`rebuilt` frame hot-swaps only already-known entries; `graph` frames are no-ops;
`patchReload: live` only watches the two `cordis.patch.yml` files). So restart the
web process to see the indicator:

```sh
dsh --profile web
```

> Note: restarting ends any session currently running inside that web process.

## Publishing

The package is dependency-free and prebuilt (the browser bundle is hand
authored), so publishing is a plain npm publish of the repo folder:

```sh
cd dsh-session-status
npm publish --access public        # first publish: claim the name
npm version patch && npm publish   # subsequent releases
```

`files` limits the tarball to `lib/`, `cordis.patch.yml`, and the two READMEs.
The name is `dsh-status-light` because `dsh-session-status` is already taken
on npm by an unrelated project.

## Uninstall

```sh
dsh plugin --profile web remove dsh-status-light   # npm / git install
# (local-path installs: remove dsh-session-status, the folder's package name
#  is irrelevant — the dependency is keyed by the resolved spec's package name)
```

Removal is reconciled against installed state: the entry drops out of
`dsh.profile.bundles` automatically.
