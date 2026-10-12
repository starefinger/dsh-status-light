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

## DSH 0.2.0 compatibility (v0.6.0)

This version tracks the DSH 0.2.0 settings rearchitecture:

- **Settings model.** Forms are now *projected automatically* from each
  bundle plugin's `Config` schema (the pre-0.2.0 `settings.register` /
  `scope.get` / `scope.watch` namespace API is gone). The plugin therefore
  exports a zero-dependency hand-rolled `Config` node that satisfies all four
  surfaces DSH touches: `~standard.validate` (sync, volatile fields resolve to
  cosmokit-protocol live references), the flat `type`/`dict`/`meta` walk, a
  per-leaf `toJSON()`, and the root `toJSON()` wire envelope (schemastery
  3.18.4 serialization). The namespace id is the Loader entry id
  (`session-status`). The `~standard` face carries `version: 1` and
  `vendor: "schemastery"` exactly like a real schemastery schema — required:
  the Loader only runs its schema-aware volatile diff for that vendor tag,
  and without it a volatile-only write would be misread as an ordinary config
  change and remount the whole entry instead of committing in place.
- **Client contract.** `uiSession.pendingInteractions` is replaced by the
  unified `uiSession.sessionStatus` per-session status map; the settings
  surface moves from `settingsScope` to the shared `configForms` service
  (`configForms.get("session-status")` → `getSnapshot` / `subscribe` / `set`).
- **Hot toggle.** `iconMode` and `bridgeEnabled` are declared volatile: a
  settings write commits in place into the running entry (no remount) and the
  plugin reacts to `loader/volatile-update`.
- **Legacy values.** A pre-0.2.0 global `settings.yaml` `session-status:`
  section is migrated automatically on first boot (`importLegacyDocument` —
  the old section id matches the entry id); otherwise the defaults
  (`replace` / bridge on) apply.
- **Loading.** A *first install* of the bundle is picked up by the running
  web server **without a restart** (`patchReload: live` watches the profile
  manifest; a changed `dsh.profile.bundles` list triggers a live entry-tree
  reconcile — verified against a running DSH 0.2.0-rc.2). *Upgrading* an
  already-listed bundle to a new version, and *host-side code changes* to an
  already-active entry, do need a `dsh web` restart (the bundle list is
  unchanged, and the host module is cached in the ESM loader).

## Data source (zero extra dependencies)

Reads only two standard client stores (no RPC, no added deps):

- `sessions.list` (`SnapshotStore<SessionListState>`) →
  `byId[sessionId].running` (the host agent-running bit, kept live by
  `api-session/status` frames). The sidebar dot reads it through the
  `useSessions` hook; the tab favicon subscribes to the same store directly.
- `uiSession.sessionStatus` (a `{getSnapshot, subscribe}` store — the 0.2.0
  *unified* per-session status map `{running, pendingInteraction,
  completionUnread}`, published by `dsh-client-ui-approval` /
  `dsh-client-ui-user-questions` via `registerPendingInteraction`) → any entry
  carrying a `pendingInteraction` means blocked.

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

- The choice takes effect immediately and **persists** to the profile's
  settings document (the `session-status` section of the profile patch — the
  pre-0.2.0 global `settings.yaml` section is migrated automatically on first
  boot) — it survives across tabs and restarts.
- It rides DSH's native settings chain (0.2.0 model): the host half exports a
  bundle plugin `Config` schema — a hand-rolled, dependency-free
  schemastery-compatible node (a `~standard.validate` that resolves volatile
  fields to live references, flat `type`/`dict`/`meta` walk shape, and a frozen
  `toJSON()` envelope byte-identical to schemastery 3.18.4 serialization, which
  the browser rehydrates with its own vendored copy). The settings service
  *projects the form automatically* from that schema (no manual namespace
  registration — the pre-0.2.0 `settings.register` is gone; the namespace id IS
  the Loader entry id). The browser half reads the form through the shared
  `ctx.configForms.get("session-status")` service (`getSnapshot()` /
  `subscribe()` / `set("iconMode", …)`, the same external-store face as the old
  scope), tracking it with `useSyncExternalStore`.
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
`configForms` through `ctx.get` (soft access), so a composition without them
simply has no page. Both rows live in the same `session-status` entry config;
the bridge field is a top-level `bridgeEnabled` boolean so the client form can
write it with its single-level `set()`.

Implementation note: the favicon logic subscribes to the **same** two standard
stores the sidebar dot reads (no React, no polling), so the two never disagree;
the `ctx.effect` disposer unsubscribes and **restores the original favicon** on
plugin disposal / HMR swap; each browser tab updates its own favicon
independently. The shell's `index.html` registers **one icon `<link>` per color
scheme** (`media="(prefers-color-scheme: …)"`) — the browser honors only the
scheme-matching one — so the writer updates **all** icon links and restores
each element's own original href.

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
nested-plugin wiring. The settings **page policy**
(`settings.configure({auto: false})` — suppresses the auto-generated form page,
since the dedicated section owns the UI) is registered inside the same fiber
(single owner; the settings service rejects duplicate policies).

**Enable / disable.** Toggle it from **Settings → 状态监控 → 桌面状态桥**
(persisted as the volatile `bridgeEnabled` config field). Because the field is
declared **volatile**, a settings write is committed *in place* into the running
entry's config references and the Loader dispatches `loader/volatile-update` to
the owning fiber — the route installs/uninstalls **immediately, with no remount
of the entry** (this is the 0.2.0 replacement for the old settings watcher).

**The tray tool** lives **outside** this plugin, at the repo's
[`../desktop/`](../desktop/) (a home for all desktop versions; the Python one
is [`../desktop/desktop-python/`](../desktop/desktop-python/)) — a single
`status_tray.py` (Python + pystray) that streams the SSE endpoint and recolors
a 🔴/🟡/🟢 tray icon (⚪ gray when the bridge is unreachable). See
[`../desktop/desktop-python/README.md`](../desktop/desktop-python/README.md) to
run it. The Node side of the bridge has **zero dependencies** (built-ins only);
the Python side needs only pystray + Pillow.

## Layout

```
dsh-session-status/
├── package.json          # dsh.bundle.patch + dsh.client{platform:web}
├── cordis.patch.yml      # host Loader row (- insert: {id, name})
└── lib/
    ├── index.js          # host half: plugin Config (settings) + the desktop status bridge
    ├── bridge.js         # the bridge: StatusBridge state machine + the HTTP/SSE route
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

## Activation (live — verified on DSH 0.2.0-rc.2)

A **first install needs no restart.** With `patchReload: live` the running web
server watches the profile manifest (`package.json`): the changed
`dsh.profile.bundles` list triggers a live Loader entry-tree reconcile, which
activates the host half (bridge route + settings policy) and re-scans the client
graph — the sidebar dot, the tab favicon, and the `/session-status` endpoint all
appear in the already-running instance seconds after the install.

What still needs a **`dsh web` restart** (`dsh --profile web`):

- **upgrading** an already-listed bundle to a new version (the bundle list is
  unchanged, so the manifest watcher stays quiet), and
- **host-side code changes** to an already-active entry — the host module is
  cached in the ESM loader (the HMR module-root watch is opt-in and off in the
  shipped web profile).

Client-side bundle changes are different: the `client-hmr` host transport
stat-polls every client bundle in the graph (~500 ms), rebuilds the combo on
change, and pushes a `graph` frame over `/plugins/events`, which the browser
half hot-swaps **in the open page**.

> Note: restarting ends any session currently running inside that web process.

## Uninstall

```sh
dsh plugin --profile web remove dsh-session-status
```
