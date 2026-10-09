# DSH Web Profile — Custom CLIENT UI Plugin: Full Investigation Report

Install examined: `/usr/lib/node_modules/@deepseek-ai/dsh/` (v0.1.5-rc.1, published).
Live web profile on this machine: **`/root/.dsh/profiles/web`** (`$DSH_HOME`=`/root/.dsh`, default is `~/.dsh`).
Repo reference: `github.com/deepseek-ai/deepseek-harness` (branch `master`), used only for `dev:web` (source-only, not in the published install).

---

## 1. How a CLIENT-side plugin is discovered and loaded into the browser

### The discriminating manifest field: `dsh.client`

A package becomes a **client plugin** if and only if:

1. It is mounted as a **live Loader entry** on the host (i.e. it appears as a plugin row in the composed tree — an ordinary row, no special kind), AND
2. The resolved package manifest declares `dsh.client` with `platform: "web"`, AND
3. It exports a `./client` subpath in `package.json` `exports`.

Host-side scan (`ClientModuleRegistry`, service name `clientModules`, in
`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js`):

- `constructor(ctx)` (line ~460): subscribes to the Cordis `internal/plugin` event (every fiber create/dispose marks the entry's package name dirty), seeds the dirty set with **all current loader entries**, and does a synchronous activation flush. "Scanning is incremental per package — there is no full-rescan code path."
- `resolveMeta(loaderName, baseUrl)` (line ~637) → `locatePkgJson(...)` resolves the Loader row's specifier through the same Loader resolution that imported the row's host half, then walks up to the nearest `package.json` declaring the package name. Then `parseDshClient` validates:

```js
// dsh-client-modules/lib/index.js, line ~140
if (typeof decl.platform !== "string") throw ...dsh.client.platform must be a string
const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw ...
```

- `decl.platform !== "web"` → recorded as null (a cached "not a client package" verdict).
- `clientExportOf(pkgName, pkg.exports)` (line ~156) **requires `exports["./client"]`** (string or `{default: string}`); `dsh.client` without a `./client` export throws:
  `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`.
- The bundle file must exist at startup; a missing one throws `MissingClientBundleError` →
  `client bundle not found; run 'pnpm run build' before launch` (grouped as `ClientPackageCompositionError`, FAILED fiber, boot audit reports it).

So: **client plugin = any host row whose package has `dsh.client.platform: "web"` + `exports["./client"]`.** The web roster rows in `dsh-web-app/cordis.patch.yml` are plain rows (`- id: ui-jobs / name: '@deepseek-ai/dsh-client-ui-jobs'`); there is no "client row" marker on the row itself. Host-only plugins (no `dsh.client`) are simply invisible to the browser.

The shared declaration type is `DshClientManifest` in
`node_modules/@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts`:

```ts
export interface DshClientManifest {
    platform: string;          // the Web consumer selects "web"
    inject?: string[];         // package-name dependency edges (factory arrival + client entry composition)
    immediately?: boolean;     // stage-one prefetch (rare)
    external?: string[];       // exact module-table requests beyond the baseline
}
```

### What the host does with it (boot graph + serving)

`ClientModuleRegistry` composes a `WebBootGraph` and injects it into the served index HTML:

- Rows: one `graphRow` per discovered package: `{ id: <packageName>, url: "/plugins/??<id>/client.js&rev=<rev>", rev, inject?, immediately?, external? }` (wire type `WebBootEntry`, `lib/types/client/manifest.d.ts`).
- Ordering: `orderByModuleGraph` — a row's `external` specifiers are module-graph edges; a requested package row must precede its consumers (cycles/self-requests throw).
- Batches: the `dsh-client-modules` package itself goes in a parser-blocking **"bootstrap"** combo; all other rows go into one or more **"application"** combo scripts, partitioned so each generated combo URL (`/plugins/??a/client.js,b/client.js&rev=...`) stays ≤ 3 KiB (`MAX_COMBO_URL_BYTES`).
- Serving: registers a `/plugins` prefix route on the `webServer` service (immutable responses, `cache-control: public, max-age=31536000, immutable`); also exposes `fetchBundle()` for shell-owned carriers.
- Index injection: on the `webserver/index-inject` event, `bootInjections(graph)` pushes, in order:
  1. an **inline `window.__ModuleLoader__` queue facade** (inline script; `load(reg)` queues, `create(options)` materializes the `dsh-client-modules` registration and calls its `createClientModuleSystem` export, then switches the facade to live mode);
  2. `<link rel=preload>` per application combo;
  3. parser-blocking `<script src>` for the bootstrap combo;
  4. `window.__DSH_BOOT__ = <graph>`.

The built shell (`@deepseek-ai/dsh-web-frontend` dist, served by the `web-runtime` row of `dsh-web-app`) reads `__DSH_BOOT__`, materializes the modules bundle, and constructs the `ClientModuleSystem` — from then on every client plugin bundle arrives through the module table.

### Browser-side loading (lazy CJS)

`window.__ModuleLoader__.load({ id, factory })` is the bundle contract (`ClientBundleRegistration`, manifest.d.ts line ~148): **executing a bundle only registers its factory; every module-body side effect (CSS injection included) runs at materialization** (`factory(require) → exports`, memoized in `loadCache`). The factory's `require` is synchronous and resolves in this order: platform seed table → memoized record → (import only) boot-graph row (async load of that combo) → registered factory → throw.

The vendored Cordis Loader's **only code-arrival point on the browser is `EntryTree.import` → `ctx.loader.internal.import`**; the shell mounts the module system as `ctx.modules` / `ctx.loader.internal` (`ClientModuleLoader` interface, manifest.d.ts line ~208, with `import / prefetch / invalidate / loadCache`). So a client plugin becomes a *client-side Cordis plugin entry* the moment the shell activates it — it runs `apply(ctx)` with the same service/inject machinery as the host side.

`dsh.client.inject` (the `inject` field on the row) names client-package edges: factories must arrive before the consumer materializes, and the same package edges are used to compose the client-side entries (Cordis inject-waiting on the browser). `dsh.client.external` adds exact non-baseline module requests; everything else is the seeded **platform baseline table** (React, Cordis, static UI libraries).

### The other named packages

- **`dsh-client-modules`** — the dual-face loader described above (node half: scan/compose/serve/index-inject; browser half: `ClientModuleSystem` + `ctx.modules`). Mounted by the `modules` row in `dsh-web-app/cordis.patch.yml`:
  ```yaml
  - id: modules
    name: '@deepseek-ai/dsh-client-modules'
  ```
  Comment there: "the node half scans this tree, composes window.__DSH_BOOT__, and serves /plugins/<id>/client.js; the browser half is the module table the shell kernel constructs before cordis exists".
- **`dsh-client-connection`** — dual-face transport: node half binds the gateway to the webserver under `/api`; browser half is the fetch/SSE client (`inject: [webRuntime]`, `trustedHosts` fence). Not part of plugin discovery; the RPC/SSE channel plugins talk over.
- **`dsh-cordis-client-runner`** — different mechanism: *dynamic* packages. Loads a plain-JS browser half **on demand** (in response to a host run request a person approves), seats it in the module table, mounts it via `loader.create`, and unloads on retract. Static client plugins like yours do not go through it.
- **`dsh-client-hmr`** — see §3.

---

## 2. `dsh.profile` / `bundles` / `cordis.patch.yml`, and where the profile lives

### Profile location (found on disk)

- Resolver: `resolveDshHome()` in `node_modules/@deepseek-ai/dsh-home-paths/lib/index.js` → `$DSH_HOME` env, else `~/.dsh`. `resolveProfileDir(name, home)` = `join(home, "profiles", name)` (`PROFILES_DIR = "profiles"`, `dsh-app-boot/lib/index.js` line ~312).
- **This machine's web profile: `/root/.dsh/profiles/web`** (env shows `DSH_HOME=/root/.dsh`). Contents:
  ```
  /root/.dsh/profiles/web/
    package.json          # profile manifest (dsh.profile)
    cordis.patch.yml      # the user's own patch layer (here: [])
    cordis.yml            # empty root entry list, rewritten on every boot: []
    pnpm-workspace.yaml   # packages: ['.'], nodeLinker: hoisted, autoInstallPeers: false
    pnpm-lock.yaml
    node_modules/         # pnpm-installed out-of-tree plugins (real files, hoisted)
    .dsh-module-fallback/node_modules   # dsh-owned symlinks to install-closure peers
  ```
  Actual manifest on disk:
  ```json
  {
    "name": "dsh-profile-web",
    "private": true,
    "dsh": { "profile": { "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "dsh-llm-qwen-local"
    ] } },
    "dependencies": { "dsh-llm-qwen-local": "^0.4.0" }
  }
  ```
  So this profile **already carries a real out-of-tree dual-face plugin** — `dsh-llm-qwen-local` (LLM adapter + a web settings-page client plugin). It is the best in-place reference for your use case.

### The machinery (source: `dsh-app-boot/lib/index.js`)

- Shipped templates (`PROFILE_TEMPLATES`, line ~328):
  ```js
  web: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], patchReload: "live" }
  ```
  (`acp`, `headless`, `sdk`, `sdk-minimal` analogous. `patchReload: "live"` for web means the profile's and home's `cordis.patch.yml` are watched and re-applied via Cordis HMR while the process runs; `startup` = apply only at boot.)
- A **bundle** is any npm package whose manifest declares
  ```json
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
  ```
  (that's exactly what `dsh-web-app/package.json` does; its patch = the web surface layer).
- Composition order (boot, `runProfile`/`composeProfile` in the dsh CLI chunk `lib/profile-boot-Dk-7KqJc.js`, `dsh-app-boot` for the rest), applied as ONE flattened patch list over an **empty root** (`cordis.yml` = `[]`):
  1. each bundle's patch list, in `dsh.profile.bundles` order (`bundlePatches`);
  2. the profile's own `cordis.patch.yml` (user layer);
  3. `$DSH_HOME/cordis.patch.yml` (home layer, applies to every profile);
  4. `--patch <file>` overlays (argv order);
  5. the `DSH_TELEMETRY_DISABLED` switch patch.
- Patch semantics (`applyEntryPatches`, dsh-app-boot line ~59): a patch with `id` **replaces the target row's whole `config`** (no deep merge — restate every key); `insert` (no id) appends rows at top level; `insert` with an id appends into a group's children; `disabled: true` disables a row; `name` mismatch on an id-targeted patch warns and skips; `!!js <expr>` scalars are evaluated at entry activation (`ctx`/`process` in scope).
- Bundle resolution is **two-anchor**: `resolveBundleDir` (line ~826) resolves each `dsh.profile.bundles` name first from the dsh **installation** (so `dsh-base`/`dsh-web-app` always come from the same install as the running dsh), then from the **profile directory** (pnpm-managed `node_modules` wins for out-of-tree packages).
- Module fallback: `healProfilesModuleFallback` mirrors the install's dependency closure into `$DSH_HOME/profiles/node_modules` (symlinks; ESM proxies for packaged executables), and per-profile `.dsh-module-fallback/node_modules` links packages carried only by selected bundles — so an out-of-tree plugin can import `@deepseek-ai/*` peers without declaring them.

### How out-of-tree plugins join a profile (`dsh plugin`)

`dsh plugin --profile <name> <args...>` (`lib/plugin-Ddi42qoW.js`) is **a thin pnpm forwarder**:

1. `resolveProfileDir(profile)`; if `package.json` is missing, `initProfile(dir, template?.bundles ?? DEFAULT_PROFILE_BUNDLES, ...)` (creates manifest + `cordis.patch.yml` template + `pnpm-workspace.yaml`).
2. Runs `pnpm <args...>` with `cwd = profile directory` (relative path specs like `.` / `file:../x` are re-anchored to the invoking cwd first, so `add .` from a plugin checkout doesn't self-link the profile).
3. On pnpm success, `reconcilePlugins(before, profileDir)`: for every installed dependency, if the resolved package **declares `dsh.bundle.patch`** it is appended to `dsh.profile.bundles` (dependency order); names that no longer resolve to a bundle are removed. "Reconciling by installed state, not by dependency diff, means `update` activates a package that gained its `dsh.bundle` declaration in a newer version."

So **one command does both halves**: `dsh plugin --profile web add my-plugin` installs into the profile's `node_modules` *and* registers the package as a bundle layer. At boot the layer's patch inserts its host row (host loads the `apply` export), and the client half needs **no further wiring** — `ClientModuleRegistry` discovers `dsh.client` by scanning that now-live row's manifest (§1).

The live example on this machine confirms the full shape of an out-of-tree dual-face plugin (`/root/.dsh/profiles/web/node_modules/dsh-llm-qwen-local/`):

```jsonc
// package.json
{
  "name": "dsh-llm-qwen-local",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":            { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client":     "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // ← makes it a profile bundle (host)
    "client": {                                       // ← makes it a client plugin (browser)
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-settings",
                 "@deepseek-ai/dsh-client-locale",
                 "@deepseek-ai/dsh-api-remotes"]
    }
  }
}
```
```yaml
# cordis.patch.yml
- insert:
    - id: llm-qwen-local
      name: dsh-llm-qwen-local
      config:
        baseURL: !!js "process.env.QWEN_LOCAL_BASE_URL ?? 'http://127.0.0.1:8000/v1'"
        ...
```
```js
// lib/client.js (top of file)
window.__ModuleLoader__.load({
  id: "dsh-llm-qwen-local",
  factory: (require) => { /* CJS closure; exports { apply, inject } */ }
});
```

Restart `dsh web` after adding a bundle (live patch-reload covers the two `cordis.patch.yml` files only, not `dsh.profile.bundles`/manifest changes).

---

## 3. The HMR path and `pnpm run dev:web`

### The always-on receiver chain

`dsh-web-app/cordis.patch.yml` mounts the chain **unconditionally**:

```yaml
# The client-plugin reload chain, always mounted: it is idle until a
# rebuild watcher (pnpm run dev:web) actually rewrites client bundles. It
# is a row rather than a child of web-runtime because its node half is a
# client-side package, which a host-side bundle cannot import.
- id: client-hmr
  name: '@deepseek-ai/dsh-client-hmr'
```

- **Node half** (`dsh-client-hmr/lib/index.js`, injects `["clientModules", "webServer"]`): one `setInterval` (default `pollIntervalMs: 500`) stat-polls (`mtimeMs` + `size`) every graph row's client bundle against the baseline client-modules captured before its first read ("polling by design: network mounts deliver no inotify events"). On change → `ctx.clientModules.rebuilt(id)`: re-reads bundle + `.map`, computes a 12-hex sha1 artifact revision, rewrites the row's `rev`, recomposes the graph, fires `onRebuilt` → broadcasts SSE `{type:"rebuilt", id, rev}` to all `/plugins/events` subscribers (the endpoint also sends the current `graph` frame on connect). Map-only writes don't reload.
- **Browser half** (`dsh-client-hmr/lib/client.js`; it is itself a client plugin, inject `["loader", "modules"]`): subscribes to the SSE; on a `rebuilt` frame it runs a serialized reload queue: `modules.invalidate(id, rev)` (drops the registered factory + materialized record, so the next load fetches the revisioned one-resource combo URL) → `modules.prefetch(id)` (loads + registers the new factory while the old fiber still serves) → registry-first teardown (`registry.delete` before the fiber's disposer emits `internal/plugin`) → drain the old fiber → `delete entry.fiber` → remove owned `<style data-plugin>` tags → `entry.refresh()` (re-import + remount) → `fiber.await()` (rethrows loud). React state inside the reloaded plugin is lost; the data layer (connection/runtime, Session objects) is untouched; dependents cascade through Cordis activation epochs. No rollback on failure.

**Why it's idle in a production install:** the poll only reacts when a *file changes on disk*. The published install ships no watcher; nothing rewrites `lib/client.js`.

### Where `dev:web` is defined and what it does

It is **not in the published install at all** — it is a script of the **monorepo root** `package.json`
(`github.com/deepseek-ai/deepseek-harness`, branch `master`; the published CLI chunk only *mentions* it in the web-surface prompt text, `dsh-web-app/lib/index.js` line 92):

```json
"dev:web": "tsx scripts/dev-web.ts --poll"
```

`scripts/dev-web.ts` stages (one terminal, in order):

1. `pnpm run build` (full repo build; `--skip-build` skips it),
2. `tsc -b tsconfig.client.json --watch` (emits `lib/types` for the client face; `--poll` maps to fixed-polling watch flags),
3. **tsdown watch** over a discovered workspace: `discoverPluginDirs()` globs **`packages/*/*/package.json` under the repo root** and keeps those declaring `dsh.client.platform === "web"`, plus `discoverLibraryDirs()` (client-preset packages without `dsh.client`) — this rewrites every `lib/index.js` / `lib/client.js`,
4. `pnpm --filter @deepseek-ai/dsh-web-frontend run watch` = `vite build --watch --no-emptyOutDir` (rewrites `apps/web/dist`, which `dsh web` serves),
5. launches the server **from source**: `node --import tsx/esm apps/cli/src/bin.ts web [args]` (unless `--no-serve`).

Any stage exiting stops the loop (exit 1). The script's own header comment: *"Reload signaling is not this script's business — the host webserver stat-polls the bundles it serves and broadcasts `rebuilt` frames itself, so any process that rewrites `lib/client.js` files triggers reloads."*

### Can it run from the published install?

**No — it requires a full monorepo source checkout** (pnpm workspaces: `vendor/*`, `packages/*/*`, `apps/*`, `website`; root deps `tsdown`, `tsx`, `execa`; `scripts/dev-web.ts` + `scripts/client-build-environment.ts` + `scripts/pnpm-invocation.ts`; `apps/web` = `@deepseek-ai/dsh-web-frontend` with its vite config; `tsconfig.client.json` at root). The published install has none of `scripts/`, `apps/`, or `packages/`.

**Important nuance for an out-of-tree plugin (separate checkout, like `/root/qwen3.8-LLM-plugin` here):** `dev-web.ts` only watches `packages/*/*` inside the *monorepo*, so it will never rebuild your plugin. For your plugin you instead run **any** watch process that rewrites the served `lib/client.js` — the host's 500 ms stat-poll picks up *any* process that rewrites the file (`dsh-client-hmr` README: "Run `pnpm run dev:web` (or any tsdown watch process that writes the plugin's `lib/client.js`) against the same host"). Concretely:

- With the profile's `nodeLinker: hoisted`, a registry install is a **real directory** under `/root/.dsh/profiles/web/node_modules/<pkg>/` — so the rewrite target is `lib/client.js` *inside the profile's node_modules*.
- Cleaner: `dsh plugin --profile web add <absolute path or file: spec>` (pnpm `link:`-style), so the profile's `node_modules/<pkg>` links directly at your checkout, and then a watcher in your checkout that writes `lib/client.js` (the qwen plugin uses esbuild via `scripts/build-client.mjs`; `tsc` for the host half) triggers the HMR chain with a running `dsh web` — no page refresh, no monorepo needed.

That is precisely the contract stated to the model in `dsh-web-app/lib/index.js`: "The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while `pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates."

---

## 4. MINIMAL manifest for a dual-face plugin (host no-op `apply` + `./client` with `window.__ModuleLoader__.load`)

### (a) Host loadable as a bundle entry — required

**`package.json`:**
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```
- `dsh.bundle.patch` → recognized by `dsh plugin`'s `exportsPatch()` (`readProfileManifest(...).dsh?.bundle?.patch !== void 0`, `lib/plugin-Ddi42qoW.js` line ~25) and by `loadProfileDirectory` (a listed bundle without `dsh.bundle` **fails loud**: "profile bundle … declares no dsh.bundle in its package.json"). This is what auto-registers the package into `dsh.profile.bundles`.

**`cordis.patch.yml`:**
```yaml
- insert:
    - id: my-plugin
      name: my-plugin
```
- A row with no `id`-targeted config is fine; `name` is the module specifier the Loader imports (resolves via the two-anchor resolution into the profile's `node_modules`). Without this row the package is installed but never mounted → nothing to scan.

**`lib/index.js`:**
```js
export function apply() {}   // no-op host body is legitimate
```
- The in-box `@deepseek-ai/dsh-client-ui-jobs` does exactly this; its `lib/index.js` says: "Pure UI plugin: the empty apply exists so the plugin appears in the host cordis.yml / Loader; the browser half ships via exports['./client'], discovered through the package.json dshClient declaration."

### (b) Client half injected into the web GUI — required

Add to the same `package.json`:
```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web" }
}
```
- `platform: "web"` is mandatory (scan skips anything else). `inject`/`external` are optional — omit them if the bundle only requires baseline platform modules.

`exports["./client"]` (already in the manifest above) — mandatory string or `{default: string}`; missing = hard failure at composition.

**`lib/client.js`** — a built browser bundle whose top level is exactly a factory registration:
```js
window.__ModuleLoader__.load({
  id: "my-plugin",           // MUST equal the package name (the graph row key)
  factory: (require) => {
    // CJS closure: `require` = synchronous module-table require.
    // Build as esbuild/tsdown format:"cjs", platform:"browser", with every
    // import EXTERNAL. Every specifier must resolve to the platform seed
    // table (react, react/jsx-runtime, react-dom, react-dom/client,
    // @deepseek-ai/cordis, @deepseek-ai/dsh-client-ui-slots,
    // @deepseek-ai/dsh-client-web-react, @deepseek-ai/dsh-client-ui-primitives,
    // @deepseek-ai/dsh-client-ui-attachment, @deepseek-ai/dsh-client-schema-form)
    // or a declared dynamic client package. Unknown require → throw at
    // materialization (the runtime mirror of a build-time purity gate).
    var module = { exports: {} };
    var exports = module.exports;
    // ... bundled plugin body ...
    exports.apply = function (ctx) {
      // runs when the shell activates this client plugin entry (Cordis
      // service/inject semantics on the browser side)
    };
    // optional: exports.inject = ["slots", "locale"];  // client-side services
    return module.exports;
  }
});
```

Optional, only if the bundle requires a non-baseline client package:
- `dsh.client.inject: ["<pkg-a>", ...]` — package-name edges; the named packages' factories arrive first and the same edges compose client-side entries (Cordis inject-waiting in the browser).
- `dsh.client.external: ["<pkg>/client", ...]` — exact module-table requests that also create module-graph ordering edges (must not self-request; cycles throw).

### Install + activate

```sh
dsh plugin --profile web add <pkg-spec>     # pnpm into /root/.dsh/profiles/web + auto-append to dsh.profile.bundles
dsh web                                     # (re)start; host mounts the row, client half appears in the GUI
```
No patch edits, no client-side registration anywhere: the browser graph is recomposed from the live Loader entries automatically (and incrementally — plugin mount/unmount re-scans via `internal/plugin`).

Failure modes to expect:
- no `./client` file at boot → `client bundle not found; run 'pnpm run build' before launch` (lists package + path);
- two live Loader sources resolving to the same package name → composition error "resolves from multiple active Loader sources";
- require of a non-table specifier → loud throw at materialization.

---

## 5. Slot props for `conversation.session.header.actions`

### Slot declaration

`node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` (line ~134):

```ts
interface SlotMap {
    /** Title-adjacent Session actions in ascending order. */
    'conversation.session.header.actions': {
        kind: 'list';
        scope: 'session';
        owner: ConversationHeaderActionOwnerProps;
    };
    // sibling: 'conversation.session.header.utilities' — same kind/scope/owner
}

/** Header actions derive their state from standard Session props. */
export interface ConversationHeaderActionOwnerProps {
    /** Marker field: entries receive no owner-specific values. */
    children?: never;
}
```

### Composed props (framework: `@deepseek-ai/dsh-client-ui-slots`)

`PropsRuntime<K> = OwnerOf<K> & KeyPropsOf<K,EntryKey> & SlotInjectFace<SlotInjectOf<K>> & ScopeStandardProps<ScopeOf<K>>`, where `ScopeStandardProps<'session'> = SessionStandardProps & GlobalStandardProps` (interfaces filled by declaration merging). For this slot: empty owner, no keyProps, no slot-level inject → **the props are exactly the session-scope standard kit + global kit**:

From `dsh-client-ui-session` (`lib/types/client/index.d.ts`, `declare module '@deepseek-ai/dsh-client-ui-slots'`):
```ts
interface GlobalStandardProps {
    useSessions: UseSessions;                       // SnapshotSelectorHook<SessionListState>
    useSessionPendingInteraction: UseSessionPendingInteraction;
}
interface SessionStandardProps {
    useSession: SessionSnapshotSelector;            // SnapshotSelectorHook<SessionSnapshot>
    sessionId: SessionId;                           // branded string
    useProjection: UseProjection;                   // host-computed projection values by key
}
```
From `dsh-client-ui-conversation` (same merge mechanism):
```ts
interface GlobalStandardProps {
    useWorkspaces: SnapshotSelectorHook<WorkspaceSnapshot>;
}
interface SessionStandardProps {
    useConversation: UseConversation;               // SnapshotSelectorHook<ConversationSnapshot>
    useInput: SnapshotSelectorHook<InputState>;
    inputActions: InputActions;
}
```
Plus, when the entry is registered with a `locale:` namespace, `PropsLocale<NS>` adds `t: TranslateNS<NS>` (the namespace's dictionary keys plus the shared `common` vocabulary).

### The concrete type, as shipped

`dsh-client-ui-jobs/lib/types/client/JobListAction.d.ts`:
```ts
export type JobListActionProps =
  PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS>;  // NS = 'job'

export declare function JobListAction({ sessionId, useSessions, t }: JobListActionProps): JSX.Element | null;
```
Expanded, a component registered in this slot receives:

| prop | type | source |
|---|---|---|
| `sessionId` | `SessionId` | SessionStandardProps (ui-session) |
| `useSession` | `SnapshotSelectorHook<SessionSnapshot>` | ui-session |
| `useProjection` | `UseProjection` | ui-session |
| `useSessions` | `SnapshotSelectorHook<SessionListState>` | GlobalStandardProps (ui-session) |
| **`useSessionPendingInteraction`** | `SnapshotSelectorHook<SessionPendingInteractionSnapshot>` = `ReadonlyMap<SessionId, SessionPendingInteraction>` | **GlobalStandardProps (ui-session) — it IS a standard prop** |
| `useConversation` | `SnapshotSelectorHook<ConversationSnapshot>` | conversation |
| `useInput` | `SnapshotSelectorHook<InputState>` | conversation |
| `inputActions` | `InputActions` | conversation |
| `useWorkspaces` | `SnapshotSelectorHook<WorkspaceSnapshot>` | GlobalStandardProps (conversation) |
| `t` | `TranslateNS<'job'>` | `PropsLocale` (only when registered with `locale: "job"`) |
| `children?` | `never` (marker) | owner share |

**`useSessionPendingInteraction`**: yes, it is delivered as a **standard render prop** — it lives in `GlobalStandardProps`, which is handed to *every* slot component regardless of scope. No alternative retrieval path is needed; in a component you just destructure it and call it like any selector hook, e.g. `const pending = useSessionPendingInteraction(map => map.get(sessionId))`. (It is also *separately* passed explicitly as owner props where a slot declares it — e.g. `ComposerChainProps.pendingInteraction` for the `conversation.composer` chain — but that is a different, owner-declared seat.)

### Registration pattern (from the built `dsh-client-ui-jobs/lib/client.js`)

```js
const inject = ["sessions", "slots", "locale"];     // client-side Cordis services

function apply(ctx) {
  ctx.effect(() => ctx.locale.register("job", { zh, en }), "ui-job: dictionaries");
  ctx.slots.inject("conversation.session.header.actions", () =>
    ctx.slots.register({
      name: "conversation.session.header.actions",
      id: "job-list",      // 'list' slots require options.id
      order: 20,           // list display order (ascending)
      locale: "job"        // puts the typed `t` seat on the component props
    }, JobListAction));
}
```
List-slot rules from the framework: entries sort by `priority` ascending (default 0), ties by `order`; a second registration with the same `id` at the same priority throws (shadowing requires a different priority); registering into an undeclared slot throws (the slot must be declared in the parent's `children` table — here declared by the `conversation.session.header` entry).

---

## Key file paths (all under `/usr/lib/node_modules/@deepseek-ai/`)

| role | path |
|---|---|
| CLI launcher / plugin forwarder | `dsh/lib/bin.js`, `dsh/lib/plugin-Ddi42qoW.js` |
| Profile boot (patch stack, live reload) | `dsh/lib/profile-boot-Dk-7KqJc.js` |
| Profile dir/manifest/bundle logic | `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` |
| Home path resolution | `dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js` |
| Web surface patch (roster, modules row, client-hmr row) | `dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml` |
| Client module registry (scan/compose/serve/inject) | `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js` |
| Boot wire types (`WebBootGraph`, `ClientBundleRegistration`) | `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/types/client/manifest.d.ts` |
| `dsh.client` / `dsh.bundle` / `dsh.profile` manifest types | `dsh/node_modules/@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts` |
| HMR node half (poll + SSE) | `dsh/node_modules/@deepseek-ai/dsh-client-hmr/lib/index.js` |
| HMR browser half (reload swap) | `dsh/node_modules/@deepseek-ai/dsh-client-hmr/lib/client.js` |
| Slot map for the header actions slot | `dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` |
| Standard session props (incl. `useSessionPendingInteraction`) | `dsh/node_modules/@deepseek-ai/dsh-client-ui-session/lib/types/client/index.d.ts` |
| JobListAction props + registration | `dsh/node_modules/@deepseek-ai/dsh-client-ui-jobs/lib/types/client/JobListAction.d.ts`, `lib/client.js`, `lib/index.js` |
| Live web profile (on-disk example) | `/root/.dsh/profiles/web/` (+ `node_modules/dsh-llm-qwen-local/`) |
| `dev:web` definition (source-only) | monorepo root `package.json` + `scripts/dev-web.ts` on GitHub `deepseek-ai/deepseek-harness@master` |
