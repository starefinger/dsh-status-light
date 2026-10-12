/**
 * dsh-session-status — host half (DSH 0.2.0 compatible).
 *
 * Two independent responsibilities:
 *
 * 1. Plugin Config `session-status`: `iconMode` (the browser tab-icon
 *    preference) and `bridgeEnabled` (whether the desktop status bridge
 *    answers), both declared VOLATILE so a settings write hot-commits the
 *    new value into the running fiber without remounting the entry. In the
 *    0.2.0 model the settings forms are projected AUTOMATICALLY from a
 *    bundle plugin's `Config` schema (the pre-0.2.0 `settings.register`
 *    namespace API is gone); the namespace id IS the Loader entry id.
 *
 *    Schema strategy (zero dependencies): DSH's settings + registry only
 *    ever touch the schema through four surfaces, all reproduced here by
 *    hand:
 *      (a) cordis validates the raw config with
 *          `Config["~standard"].validate(config)` (sync, `{value}` or
 *          `{issues}`) — for volatile fields the resolved value is a live
 *          reference (the cosmokit volatile protocol: frozen
 *          `{get(), [Symbol.for("cosmokit.volatile.write")]}`), so the
 *          loader can commit changes in place. `~standard` also carries
 *          `version: 1` and `vendor: "schemastery"` exactly like a real
 *          schemastery schema: the Loader's `equalExceptVolatile` only
 *          performs the schema-aware volatile diff when it sees that
 *          vendor tag — without it every settings write (even one that
 *          touches only volatile fields) is misclassified as an ordinary
 *          config change and remounts the whole entry;
 *      (b) dsh-settings projects forms by WALKING `type` / `dict` /
 *          `meta` on the schema object itself (volatility is read from
 *          `meta.volatile`);
 *      (c) dsh-settings rehydrates a REAL schemastery instance from
 *          `schema.toJSON()` for every volatile field — so each leaf node
 *          also carries `toJSON()`;
 *      (d) `settings.describe` publishes the root `toJSON()` envelope,
 *          which the browser rehydrates with its own bundled schemastery
 *          copy.
 *    The frozen envelopes below are the byte-exact serialization of
 *    schemastery 3.18.4 (the version DSH 0.2.0-rc.2 ships) — regenerate
 *    them if that version's serialization ever changes.
 *
 * 2. The desktop status bridge: a read-only HTTP endpoint mounted on the
 *    ALREADY RUNNING web server (no new port, no new listener) that a small
 *    desktop tool polls/streams for the same red/yellow/green state the
 *    browser indicator shows:
 *
 *      GET /session-status         → one JSON snapshot, connection closes
 *      GET /session-status/stream  → SSE: snapshot now, a frame per change,
 *                                    15 s comment keep-alive, retry hint
 *
 *    Snapshot fields: `{ state, blocked, running, runningIds, ts }`.
 *    `state` precedence: blocked > running > idle (a blocked agent still
 *    counts as running; `running` always reports the raw count).
 *
 *    Data sources (host-side, zero extra transport):
 *      - running: the live `agents` registry, recomputed on
 *        `agent/created` / `agent/disposed` / `agent/status`
 *        (agent-scoped events; this root-level listener is untagged, so the
 *        scope filter admits it for every agent scope)
 *      - blocked: human requests in flight, counted through two pure-
 *        observation waterfall taps — `approval/request` (tool approvals,
 *        which include plan-review gates) and `user-questions/request`
 *        (ask_user_question / plan-review questions). A tap increments on
 *        entry and decrements in a `finally`, so answers, rejections, and
 *        aborts all self-balance; a stray settle clamps at 0.
 *
 *    The bridge is a soft dependency: compositions without the `agents` or
 *    `webServer` services (non-web profiles) simply never start it.
 *
 * 0.2.0 hot-toggle wiring: the Loader commits a volatile-only config
 * change into the running fiber's config REFERENCES (in place) and emits
 * `loader/volatile-update` to the OWN entry fiber only — so the listener
 * lives on the context `apply` receives, not on the nested bridge fiber.
 * The bridge route installs/uninstalls on every change; a change that also
 * touched an ordinary field takes the normal entry-remount path instead
 * (this `apply` is re-entrant safe).
 */

import { STATUS_PATH, StatusBridge, makeRouteHandler } from "./bridge.js";

const NS = "session-status";
const MODES = ["replace", "combined"];
const DEFAULT_MODE = "replace";
const DEFAULT_BRIDGE_ENABLED = true;

/**
 * The cosmokit volatile-reference write key. `Symbol.for` makes it the same
 * symbol in every ESM/CJS copy of the shared library, so our hand-made
 * references are accepted by the Loader's `updateVolatile`/`isVolatile`
 * checks without importing cosmokit.
 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/**
 * Create a frozen live reference in the cosmokit volatile protocol
 * (`{get(), [VOLATILE_WRITE](next)}`); the Loader writes new values into it
 * in place when a volatile settings change is committed.
 * @param value - the initial plain value.
 * @returns a frozen reference object.
 */
function makeVolatile(value) {
  let current = value;
  return Object.freeze({
    get: () => current,
    [VOLATILE_WRITE]: (next) => {
      current = next;
    },
  });
}

/**
 * Read one config field that may be a volatile reference (or a plain value
 * in non-runtime contexts such as tests).
 * @param field - the field as it appears in the validated config.
 * @param fallback - used only when the field is absent.
 * @returns the plain value.
 */
function readField(field, fallback) {
  if (field !== null && typeof field === "object" && typeof field.get === "function") {
    return field.get();
  }
  return field === undefined ? fallback : field;
}

/**
 * Validate one raw config candidate (cordis contract: synchronous,
 * `{value}` on success, `{issues}` on failure). Volatile fields resolve to
 * live references.
 * @param data - raw candidate (profile layer; may be absent).
 * @returns `{value: {iconMode: ref, bridgeEnabled: ref}}` or `{issues}`.
 */
function validateSection(data) {
  const raw = data !== null && typeof data === "object" ? data : {};
  const issues = [];
  if (raw.iconMode !== undefined && MODES.indexOf(raw.iconMode) === -1) {
    issues.push({
      message: `iconMode expected "replace" | "combined" but got ${JSON.stringify(raw.iconMode)}`,
      path: ["iconMode"],
    });
  }
  if (raw.bridgeEnabled !== undefined && typeof raw.bridgeEnabled !== "boolean") {
    issues.push({
      message: "bridgeEnabled expected boolean",
      path: ["bridgeEnabled"],
    });
  }
  if (issues.length) return { issues };
  return {
    value: {
      iconMode: makeVolatile(
        raw.iconMode === undefined ? DEFAULT_MODE : raw.iconMode
      ),
      bridgeEnabled: makeVolatile(
        raw.bridgeEnabled === undefined ? DEFAULT_BRIDGE_ENABLED : raw.bridgeEnabled
      ),
    },
  };
}

/**
 * Frozen wire envelopes — the schemastery 3.18.4 serialization of
 *   z.object({
 *     iconMode: z.union([z.const("replace"), z.const("combined")])
 *       .default("replace").volatile(),
 *     bridgeEnabled: z.boolean().default(true).volatile(),
 *   }).toJSON()
 * Do not hand-edit the uids.
 * @type {Readonly<{uid: number, refs: Record<string, object>}>}
 */
const ENVELOPE = {
  uid: 8,
  refs: {
    0: { type: "const", meta: {}, value: "replace" },
    1: { type: "const", meta: {}, value: "combined" },
    4: {
      type: "union",
      meta: { default: DEFAULT_MODE, volatile: true },
      list: [0, 1],
    },
    7: { type: "boolean", meta: { default: DEFAULT_BRIDGE_ENABLED, volatile: true } },
    8: {
      type: "object",
      meta: { default: {} },
      dict: { iconMode: 4, bridgeEnabled: 7 },
    },
  },
};

/**
 * Self-contained leaf envelopes — the byte-exact schemastery 3.18.4
 * serialization of each leaf in isolation (real schemastery always
 * serializes a node as a complete `{uid, refs}` envelope, never a bare
 * node; `plainSchema` rehydrates `leaf.toJSON()` standalone, so a bare
 * node would carry dangling ref indices).
 * @type {Record<string, {uid: number, refs: Record<string, object>}>}
 */
const LEAF_ENVELOPES = {
  iconMode: {
    uid: 4,
    refs: {
      0: { type: "const", meta: {}, value: "replace" },
      1: { type: "const", meta: {}, value: "combined" },
      4: {
        type: "union",
        meta: { default: DEFAULT_MODE, volatile: true },
        list: [0, 1],
      },
    },
  },
  bridgeEnabled: {
    uid: 2,
    refs: {
      2: { type: "boolean", meta: { default: DEFAULT_BRIDGE_ENABLED, volatile: true } },
    },
  },
};

/**
 * One leaf of the form-projection walk: the flat shape dsh-settings reads
 * (`meta.volatile`, `type`) plus `toJSON()` so `plainSchema` can rehydrate a
 * real schemastery instance from the leaf's own envelope.
 */
const IconModeLeaf = {
  type: "union",
  list: [],
  meta: { default: DEFAULT_MODE, volatile: true },
  toJSON: () => JSON.parse(JSON.stringify(LEAF_ENVELOPES.iconMode)),
};
const BridgeEnabledLeaf = {
  type: "boolean",
  meta: { default: DEFAULT_BRIDGE_ENABLED, volatile: true },
  toJSON: () => JSON.parse(JSON.stringify(LEAF_ENVELOPES.bridgeEnabled)),
};

/**
 * The plugin's Config schema, attached to the bundle module as the
 * `Config` export. Consumed by:
 *   - the cordis registry: `Config["~standard"].validate(config)` before
 *     every activation (and on volatile commits);
 *   - dsh-settings: `settings.describe` projects the settings form from
 *     `type`/`dict`/`meta` and publishes `Config.toJSON()` on the wire;
 *     both fields are volatile, so a write hot-commits into the running
 *     fiber (no remount) and emits `loader/volatile-update`.
 * @type {{
 *   "~standard": {version: number, vendor: string, validate: (data: unknown) => object},
 *   type: string, dict: object, meta: object,
 *   toJSON: () => object,
 * }}
 */
export const Config = {
  "~standard": { version: 1, vendor: "schemastery", validate: validateSection },
  type: "object",
  dict: { iconMode: IconModeLeaf, bridgeEnabled: BridgeEnabledLeaf },
  meta: {
    default: {
      iconMode: DEFAULT_MODE,
      bridgeEnabled: DEFAULT_BRIDGE_ENABLED,
    },
  },
  toJSON: () => JSON.parse(JSON.stringify(ENVELOPE)),
};

/**
 * Build the source gate for the bridge route.
 *
 * When the web server binds to loopback (the shipped web deployment), the
 * socket itself already restricts access — no gate needed. When it binds
 * beyond loopback (`0.0.0.0`), only loopback sources may read the state.
 * @param bindHost - the web server's configured bind host.
 * @returns `(req) => boolean`, or `null` when no gate is required.
 */
function makeSourceGate(bindHost) {
  if (bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost") {
    return null;
  }
  return (req) => {
    const addr = (req && req.socket && req.socket.remoteAddress) || "";
    if (addr === "::1" || addr === "::ffff:127.0.0.1") return true;
    if (addr.startsWith("127.")) return true;
    return false;
  };
}

/**
 * Start the status bridge and wire its data taps.
 * @param ctx - root host context (untagged scope: receives every
 *   agent-scoped event).
 * @param agents - the live `agents` registry service.
 * @param webServer - the running web server service.
 * @param enabled - initial bridge toggle (from the entry Config).
 * @returns `{ setEnabled(enabled) }`.
 */
function startBridge(ctx, agents, webServer, enabled) {
  const bridge = new StatusBridge();

  // --- running set: recompute from the registry on any change -----------
  // Pass the id array (not just a count): the snapshot's `runningIds` is part
  // of the documented contract and the desktop tray lists which sessions are
  // busy. `setRunning(ids)` derives the count from the array length.
  const recomputeRunning = () => {
    const ids = [];
    for (const agent of agents.list()) {
      if (agent.status === "running") ids.push(agent.id);
    }
    bridge.setRunning(ids);
  };
  const offCreated = ctx.on("agent/created", recomputeRunning);
  const offDisposed = ctx.on("agent/disposed", recomputeRunning);
  const offStatus = ctx.on("agent/status", recomputeRunning);
  recomputeRunning();

  // --- blocked count: in-flight human requests ---------------------------
  // Order-robust taps: `{ prepend: true }` puts the observer FIRST in the
  // waterfall, so it measures the full in-flight window even when an
  // answerer registered earlier (client-connection relays the browser
  // answerers onto these chains dynamically) claims the request. The tap
  // increments on entry, decrements in `finally` (answers, rejections, and
  // aborts all balance), and RETURNS `next()` so the chain outcome is
  // preserved untouched.
  const tap = (name) =>
    ctx.on(
      name,
      async (request, next) => {
        bridge.onHumanRequest();
        try {
          return await next();
        } finally {
          bridge.onHumanSettled();
        }
      },
      { prepend: true }
    );
  const offApproval = tap("approval/request");
  const offQuestions = tap("user-questions/request");

  // --- route on the running web server -----------------------------------
  const gate = makeSourceGate(webServer.host);
  let disposeRoute = null;
  let live = Boolean(enabled);
  const installRoute = () => {
    disposeRoute = webServer.register({
      kind: "prefix",
      path: STATUS_PATH,
      handler: makeRouteHandler(bridge, { isAllowed: gate }),
    });
  };
  if (live) installRoute();

  ctx.effect(
    () => () => {
      offCreated();
      offDisposed();
      offStatus();
      offApproval();
      offQuestions();
      if (disposeRoute) disposeRoute();
      bridge.close();
    },
    "session-status: desktop status bridge"
  );

  function setEnabled(next) {
    if (next === live) return;
    live = next;
    if (live) installRoute();
    else if (disposeRoute) {
      disposeRoute();
      disposeRoute = null;
      bridge.close();
    }
  }

  return { setEnabled };
}

/**
 * Host registration.
 *
 * The bridge is a nested plugin that injects the `agents` + `webServer`
 * services: Cordis activates a plugin only when its injected services are
 * all present, so this fiber runs exactly in the web composition and is
 * simply skipped elsewhere.
 *
 * Config plumbing (0.2.0): the entry's Config values arrive as `apply`'s
 * second argument (validated references); the volatile hot-toggle arrives
 * as `loader/volatile-update` on this (entry) context, because the Loader
 * filters that event to the owning fiber. The settings page policy
 * (`configure({auto: false})`) suppresses the auto-generated form page —
 * the dedicated 状态监控 section owns the UI.
 * @param ctx - entry host context for the session-status plugin.
 * @param config - validated entry config (`iconMode`, `bridgeEnabled` as
 *   volatile references).
 */
export function apply(ctx, config) {
  // (1) Volatile hot-toggle. The reference object is stable (the Loader
  // updates it in place), so reading it at event time is always live. The
  // listener must sit on the ENTRY fiber's context — a nested fiber's
  // listener is filtered out of `loader/volatile-update`.
  let setBridgeEnabled = null;
  ctx.on("loader/volatile-update", () => {
    if (setBridgeEnabled) {
      setBridgeEnabled(
        readField(config && config.bridgeEnabled, DEFAULT_BRIDGE_ENABLED)
      );
    }
  });

  // (2) The bridge itself (soft: web compositions only).
  ctx.inject(["agents", "webServer"], (bridgeCtx) => {
    // Page policy: the dedicated 状态监控 section owns the UI; suppress the
    // generic auto-generated form page. Owned by the bridge fiber (absent
    // where the bridge is absent — mirroring the pre-0.2.0 namespace
    // ownership). `configure` returns a disposer, so it rides an effect —
    // when the fiber re-runs on a service change the old policy unwinds
    // before the new one registers (a double registration would throw).
    bridgeCtx.inject(["settings"], (settingsCtx) => {
      settingsCtx.effect(() =>
        settingsCtx.settings.configure({ auto: false }, ctx.fiber)
      );
    });
    const bridgeApi = startBridge(
      bridgeCtx,
      bridgeCtx.agents,
      bridgeCtx.webServer,
      readField(config && config.bridgeEnabled, DEFAULT_BRIDGE_ENABLED)
    );
    setBridgeEnabled = (value) => bridgeApi.setEnabled(value);
  });
}

/**
 * Service declaration (informational, matching the shipped plugins' shape —
 * dsh-goal-round-driver / dsh-client-hmr export the same way). The runtime
 * wiring is the `ctx.inject(["agents", "webServer"], …)` call inside `apply`.
 */
export const inject = ["agents", "webServer"];

export {
  DEFAULT_BRIDGE_ENABLED,
  DEFAULT_MODE,
  MODES,
  NS as SETTINGS_NAMESPACE,
  makeSourceGate,
};
