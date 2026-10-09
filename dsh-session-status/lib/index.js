/**
 * dsh-session-status — host half.
 *
 * Two independent responsibilities:
 *
 * 1. Settings namespace `session-status`: `iconMode` (the browser tab-icon
 *    preference) and `bridgeEnabled` (whether the desktop status bridge
 *    answers). Persisted in `$DSH_HOME/settings.yaml`, hot-reloaded by the
 *    settings-file provider. Both fields are TOP-LEVEL scalars so the client
 *    settings scope can write each with its single-level `set()`.
 *
 * 2. The desktop status bridge: a read-only HTTP endpoint mounted on the
 *    ALREADY RUNNING web server (no new port, no new listener) that a small
 *    Windows tray tool polls/streams for the same red/yellow/green state the
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
 * Schema strategy (zero dependencies): the settings service only ever
 * (a) CALLS `schema(data)` to resolve a candidate value, (b) publishes
 * `schema.toJSON()` as the serialized envelope the browser rehydrates with
 * ITS OWN bundled schemastery copy, and (c) walks `type` / `dict` /
 * `inner` / `meta.role` for secret redaction. So we keep a tiny hand-rolled
 * live node whose `toJSON()` returns a FROZEN envelope captured once from
 * the real schemastery (`object({ iconMode: union([const, const]).default(),
 * bridgeEnabled: boolean().default(true) }).toJSON()`) — the
 * published qwen-local plugin freezes its envelope for exactly this reason,
 * which lets this plugin carry no schemastery import.
 */

import { STATUS_PATH, StatusBridge, makeRouteHandler } from "./bridge.js";

const NS = "session-status";
const MODES = ["replace", "combined"];
const DEFAULT_MODE = "replace";
const DEFAULT_BRIDGE_ENABLED = true;

/**
 * Frozen schemastery wire envelope for the `session-status` namespace.
 * Generated from `Schema.object({ iconMode: Schema.union([
 *   Schema.const("replace"), Schema.const("combined")
 * ]).default("replace"), bridgeEnabled: Schema.boolean().default(true)
 * }) }).toJSON()` — do not hand-edit the uids.
 * @type {Readonly<{uid: number, refs: Record<string, object>}>}
 */
const ENVELOPE = {
  uid: 6,
  refs: {
    0: { type: "const", meta: {}, value: "replace" },
    1: { type: "const", meta: {}, value: "combined" },
    3: { type: "union", meta: { default: DEFAULT_MODE }, list: [0, 1] },
    5: { type: "boolean", meta: { default: DEFAULT_BRIDGE_ENABLED } },
    6: {
      type: "object",
      meta: { default: {} },
      dict: { iconMode: 3, bridgeEnabled: 5 },
    },
  },
};

/**
 * Resolve one candidate section, mirroring the schemastery schema's semantics:
 * `iconMode` defaults to `"replace"` and must be one of `MODES`;
 * `bridgeEnabled` defaults to `true` and must be a boolean.
 * @param data - raw candidate (user layer merged over base by the service).
 * @returns resolved section, always `{ iconMode, bridgeEnabled }`.
 */
function resolveSection(data) {
  const raw = data !== null && typeof data === "object" ? data : {};
  if (raw.iconMode !== undefined && MODES.indexOf(raw.iconMode) === -1) {
    throw new TypeError(
      `settings namespace "${NS}": $.iconMode expected "replace" | "combined" but got ${JSON.stringify(raw.iconMode)}`
    );
  }
  if (raw.bridgeEnabled !== undefined && typeof raw.bridgeEnabled !== "boolean") {
    throw new TypeError(
      `settings namespace "${NS}": $.bridgeEnabled expected boolean but got ${JSON.stringify(raw.bridgeEnabled)}`
    );
  }
  return {
    iconMode: raw.iconMode === undefined ? DEFAULT_MODE : raw.iconMode,
    bridgeEnabled:
      raw.bridgeEnabled === undefined ? DEFAULT_BRIDGE_ENABLED : raw.bridgeEnabled,
  };
}

/**
 * Live schema node handed to `ctx.settings.register`.
 * - Callable: the service resolves candidate values with `schema(data)`.
 * - `toJSON()`: returns a deep copy of the frozen envelope for the wire
 *   (`settings.describe`), which the browser rehydrates with its own copy.
 * - `type` / `dict`: redaction-walk shape (no secrets declared).
 * @type {Function & {type: string, dict: object, meta: object, toJSON: () => object}}
 */
const StatusSchema = Object.assign(resolveSection, {
  type: "object",
  dict: {
    iconMode: { type: "union", list: [], meta: { default: DEFAULT_MODE } },
    bridgeEnabled: { type: "boolean", meta: { default: DEFAULT_BRIDGE_ENABLED } },
  },
  meta: {
    default: {
      iconMode: DEFAULT_MODE,
      bridgeEnabled: DEFAULT_BRIDGE_ENABLED,
    },
  },
  toJSON: () => JSON.parse(JSON.stringify(ENVELOPE)),
});

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
 * Start the status bridge and wire its data taps. Starts ENABLED; the
 * settings watcher (see `apply`) applies the persisted value right after.
 * @param ctx - root host context (untagged scope: receives every
 *   agent-scoped event).
 * @param agents - the live `agents` registry service.
 * @param webServer - the running web server service.
 * @returns `{ setEnabled(enabled) }`.
 */
function startBridge(ctx, agents, webServer) {
  const bridge = new StatusBridge();

  // --- running count: recompute from the registry on any change ---------
  const recomputeRunning = () => {
    let n = 0;
    for (const agent of agents.list()) {
      if (agent.status === "running") n += 1;
    }
    bridge.setRunning(n);
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
  let enabled = true;
  const installRoute = () => {
    disposeRoute = webServer.register({
      kind: "prefix",
      path: STATUS_PATH,
      handler: makeRouteHandler(bridge, { isAllowed: gate }),
    });
  };
  installRoute();

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
    if (next === enabled) return;
    enabled = next;
    if (enabled) installRoute();
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
 * @param ctx - Host context for the session-status plugin.
 */
export function apply(ctx) {
  const agents = ctx.get("agents");
  const webServer = ctx.get("webServer");

  // (1) The bridge itself — web compositions only, independent of the
  // settings provider so a minimal profile still gets the endpoint.
  const bridgeApi =
    agents !== undefined && webServer !== undefined
      ? startBridge(ctx, agents, webServer)
      : null;

  // (2) Settings namespace (the browser binds the same namespace for the
  // tab-icon mode; `bridge.enabled` is consumed host-side, hot-reloaded).
  // When a settings provider is present, apply the persisted toggle on top
  // of the bridge's default-on start and watch it for hot changes.
  ctx.inject(["settings"], (settingsCtx) => {
    const scope = settingsCtx.settings.register(NS, StatusSchema);
    if (bridgeApi === null) return;
    const applyEnabled = () => {
      const value = scope.get();
      bridgeApi.setEnabled(Boolean(value.bridgeEnabled));
    };
    applyEnabled();
    scope.watch(applyEnabled);
  });
}

export {
  DEFAULT_BRIDGE_ENABLED,
  DEFAULT_MODE,
  MODES,
  NS as SETTINGS_NAMESPACE,
  StatusSchema,
  makeSourceGate,
};
