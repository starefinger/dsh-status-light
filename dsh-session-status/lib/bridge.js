/**
 * dsh-session-status — session-status bridge core.
 *
 * One small state machine + one read-only HTTP endpoint, shared by the host
 * half (`lib/index.js`, which mounts it on the running Web server) and the
 * test harness (`test-status-server.cjs`, which drives it with fake data).
 *
 * The bridge owns NO data source of its own. Everything is pushed in through
 * two pure-observation taps the host wires up:
 *
 *   - human requests in flight: `onHumanRequest()` (+1) /
 *     `onHumanSettled()` (−1, clamped at 0, self-balancing even when a
 *     request is rejected or aborted before it settles)
 *   - running agents: `setRunning(n)` (recomputed by the host from the live
 *     agent registry on every agent lifecycle event)
 *
 * State precedence mirrors the browser indicator exactly:
 *
 *   blocked (red)    — at least one human request is unanswered
 *   running (yellow) — no human request, but at least one agent is running
 *   idle (green)     — neither
 *
 * (A blocked agent is still "running" underneath; `running` in a payload
 * always reports the raw running count, and `state` reports the precedence.)
 *
 * Transport: the endpoint is a plain read-only route on the ALREADY RUNNING
 * web server (no new port). Two clients, one path:
 *
 *   GET /session-status              → one JSON snapshot and close
 *   GET /session-status/stream       → SSE: an immediate snapshot frame, then
 *                                      a frame per state change, a 15 s
 *                                      comment keep-alive, and a retry hint
 *
 * A tray client that loses the stream simply re-polls; the snapshot answer is
 * always current. The module depends on nothing outside `node:events`.
 */

const STATUS_PATH = "/session-status";
const STREAM_PATH = "/session-status/stream";
/** SSE keep-alive period: keeps intermediate proxies from dropping idle streams. */
const KEEPALIVE_MS = 15000;
/** Snapshot fields (also the push frame shape). */
const FIELDS = Object.freeze([
  "state",
  "blocked",
  "running",
  "runningIds",
  "ts",
]);

/**
 * Compute the precedence state from the two raw counts.
 * @param blocked - human requests currently unanswered.
 * @param running - agents currently running.
 * @returns "blocked" | "running" | "idle".
 */
function deriveState(blocked, running) {
  if (blocked > 0) return "blocked";
  if (running > 0) return "running";
  return "idle";
}

/**
 * Build one wire snapshot from the raw counts.
 * @param blocked - human requests currently unanswered.
 * @param runningIds - ids of agents currently running (may be empty).
 * @param runningCount - authoritative running count (overrides ids length).
 * @returns `{ state, blocked, running, runningIds, ts }`.
 */
function buildSnapshot(blocked, runningIds, runningCount) {
  const ids = Array.isArray(runningIds) ? runningIds : [];
  const running = runningCount === undefined ? ids.length : runningCount;
  return {
    state: deriveState(blocked, running),
    blocked,
    running,
    runningIds: ids,
    ts: Date.now(),
  };
}

/**
 * The shared bridge.
 *
 * Not an `EventEmitter` subclass on purpose: the whole surface is two
 * count inputs, a snapshot getter, and one subscriber set, which is easier
 * to test in plain objects.
 */
class StatusBridge {
  constructor() {
    this.blocked = 0;
    this.runningCount = 0;
    this.runningIds = [];
    this.lastPushed = null;
    this.subscribers = new Set();
    this.timer = null;
  }
  /** Current snapshot (fresh `ts` per call). */
  snapshot() {
    return buildSnapshot(this.blocked, this.runningIds, this.runningCount);
  }
  /**
   * One human request entered the in-flight set (approval asked / question /
   * plan-review issued). @returns the new snapshot.
   */
  onHumanRequest() {
    this.blocked += 1;
    return this._changed();
  }
  /**
   * One human request left the in-flight set (answered, rejected, or
   * aborted). Clamped at 0: a stray settle must never manufacture a
   * negative blocked count. @returns the new snapshot.
   */
  onHumanSettled() {
    this.blocked = Math.max(0, this.blocked - 1);
    return this._changed();
  }
  /**
   * Host recomputed the running set from the live agent registry.
   * @param value - the running count, or an array of agent ids currently
   *   running (registry order; the count is derived from its length).
   * @returns the new snapshot.
   */
  setRunning(value) {
    if (Array.isArray(value)) {
      this.runningIds = value.map(String);
      this.runningCount = this.runningIds.length;
    } else {
      this.runningCount = Math.max(0, Number(value) || 0);
      this.runningIds = [];
    }
    return this._changed();
  }
  /** Whether two payloads compare equal on the pushed fields. */
  static same(a, b) {
    if (!a || !b) return false;
    if (a.state !== b.state || a.blocked !== b.blocked || a.running !== b.running) return false;
    if (a.runningIds.length !== b.runningIds.length) return false;
    for (let i = 0; i < a.runningIds.length; i++) if (a.runningIds[i] !== b.runningIds[i]) return false;
    return true;
  }
  /** Push a changed snapshot to subscribers. @returns the snapshot. */
  _changed() {
    const snap = this.snapshot();
    if (!StatusBridge.same(snap, this.lastPushed)) {
      this.lastPushed = snap;
      this._emitFrame(snap);
    }
    return snap;
  }
  /**
   * Subscribe to state-change frames. `onSnapshot` receives the CURRENT
   * snapshot immediately (the connection-time answer), then `onFrame`
   * receives every change, and `onKeepalive` the idle heartbeat.
   * @returns disposer.
   */
  subscribe(onSnapshot, onFrame, onKeepalive) {
    const sub = { onSnapshot, onFrame, onKeepalive };
    this.subscribers.add(sub);
    this._startKeepalive();
    onSnapshot(this.snapshot());
    return () => {
      this.subscribers.delete(sub);
      this._stopKeepalive();
    };
  }
  _emitFrame(snap) {
    for (const sub of this.subscribers) {
      try {
        sub.onFrame(snap);
      } catch {
        /* subscriber sink errors must never break the bridge */
      }
    }
  }
  _startKeepalive() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const sub of this.subscribers) {
        try {
          if (sub.onKeepalive) sub.onKeepalive();
        } catch {
          /* ignored, as above */
        }
      }
    }, KEEPALIVE_MS);
    if (this.timer.unref) this.timer.unref();
  }
  _stopKeepalive() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  /** Drop every subscriber (plugin dispose). */
  close() {
    this._stopKeepalive();
    this.subscribers.clear();
    this.lastPushed = null;
  }
}

/**
 * Build the prefix-route handler the host registers on the web server.
 *
 * @param bridge - the shared {@link StatusBridge}.
 * @param opts - `{ maxStreamClients }` cap (default 8) for stream clients,
 *   and `{ isAllowed }` an optional `(req) => boolean` source gate (the host
 *   installs it when the web server binds beyond loopback, so a LAN bind
 *   cannot expose the state to non-local peers).
 * @returns `(req, res) => void` handling both the snapshot and the stream.
 */
function makeRouteHandler(bridge, opts = {}) {
  const maxStreamClients = opts.maxStreamClients ?? 8;
  const isAllowed = typeof opts.isAllowed === "function" ? opts.isAllowed : null;
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }
    const url = (() => {
      try {
        return new URL(req.url ?? "/", "http://x").pathname;
      } catch {
        return req.url ?? "/";
      }
    })();
    if (isAllowed !== null && !isAllowed(req)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    if (url === STREAM_PATH) return streamClient(bridge, res, maxStreamClients);
    if (url !== STATUS_PATH) {
      // Exact routes should never be handed other paths; answer 404 defensively.
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    // Snapshot answer: current state, one frame, close.
    const body = JSON.stringify(bridge.snapshot());
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  };
}

/** Attach one SSE stream client, enforcing the client cap. */
function streamClient(bridge, res, maxStreamClients) {
  if (bridge.subscribers.size >= maxStreamClients) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("too many status stream clients");
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 2000\n\n");
  const writeFrame = (snap) => res.write(`data: ${JSON.stringify(snap)}\n\n`);
  const dispose = bridge.subscribe(
    (snap) => writeFrame(snap),
    (snap) => writeFrame(snap),
    () => res.write(`: keepalive ${Date.now()}\n\n`)
  );
  res.on("close", dispose);
  res.on("error", dispose);
}

export {
  KEEPALIVE_MS,
  StatusBridge,
  STREAM_PATH,
  STATUS_PATH,
  buildSnapshot,
  deriveState,
  makeRouteHandler,
};
export default StatusBridge;
