/**
 * dsh-session-status — host bridge tests (plain node, zero deps).
 *
 * Three layers:
 *   A. StatusBridge state machine (unit)
 *   B. Route handler over a REAL node:http server (snapshot + SSE + caps + gate)
 *   C. Full apply() integration with a fake host ctx (event bus, agents
 *      registry, web server, settings watch) — the exact wiring the real
 *      composition runs at boot.
 *
 * Run: node test-status-server.cjs   (exits non-zero on first failure)
 */

import { createServer } from "node:http";
import assert from "node:assert/strict";
import {
  StatusBridge,
  STATUS_PATH,
  STREAM_PATH,
  deriveState,
  buildSnapshot,
  makeRouteHandler,
} from "./dsh-session-status/lib/bridge.js";
import { apply, StatusSchema, SETTINGS_NAMESPACE } from "./dsh-session-status/lib/index.js";

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok ${String(passed).padStart(2)}  ${name}`);
    })
    .catch((err) => {
      console.error(`  FAIL ${name}\n    ${err && err.stack ? err.stack : err}`);
      process.exit(1);
    });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A. StatusBridge unit
// ---------------------------------------------------------------------------
async function sectionA() {
  console.log("A. StatusBridge state machine");

  await check("starts idle", () => {
    const b = new StatusBridge();
    const s = b.snapshot();
    assert.equal(s.state, "idle");
    assert.equal(s.blocked, 0);
    assert.equal(s.running, 0);
    assert.deepEqual(s.runningIds, []);
    assert.equal(typeof s.ts, "number");
  });

  await check("running: setRunning(1) -> running", () => {
    const b = new StatusBridge();
    assert.equal(b.setRunning(1).state, "running");
  });

  await check("precedence: blocked wins over running", () => {
    const b = new StatusBridge();
    b.setRunning(2);
    assert.equal(b.onHumanRequest().state, "blocked");
    assert.equal(b.snapshot().running, 2, "raw running count preserved under blocked");
  });

  await check("settled returns to running then idle", () => {
    const b = new StatusBridge();
    b.setRunning(1);
    b.onHumanRequest();
    assert.equal(b.onHumanSettled().state, "running");
    assert.equal(b.setRunning(0).state, "idle");
  });

  await check("stray settle clamps at 0 (no negative blocked)", () => {
    const b = new StatusBridge();
    b.onHumanSettled();
    assert.equal(b.snapshot().blocked, 0);
    assert.equal(b.snapshot().state, "idle");
  });

  await check("setRunning with id array derives count", () => {
    const b = new StatusBridge();
    const s = b.setRunning(["a", "b"]);
    assert.equal(s.running, 2);
    assert.deepEqual(s.runningIds, ["a", "b"]);
  });

  await check("deriveState / buildSnapshot helpers", () => {
    assert.equal(deriveState(0, 0), "idle");
    assert.equal(deriveState(0, 3), "running");
    assert.equal(deriveState(5, 0), "blocked");
    const s = buildSnapshot(1, ["x"], 1);
    assert.deepEqual(
      [s.state, s.blocked, s.running, s.runningIds],
      ["blocked", 1, 1, ["x"]]
    );
  });

  await check("subscribe: immediate snapshot + change frames, no dupes", () => {
    const b = new StatusBridge();
    const frames = [];
    let snap = null;
    const off = b.subscribe(
      (s) => (snap = s),
      (s) => frames.push(s)
    );
    assert.equal(snap.state, "idle", "immediate snapshot on subscribe");
    b.setRunning(1);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].state, "running");
    b.setRunning(1);
    assert.equal(frames.length, 1, "unchanged state emits no frame");
    b.onHumanRequest();
    assert.equal(frames[1].state, "blocked");
    off();
    b.setRunning(0);
    assert.equal(frames.length, 2, "disposer stops frames");
  });

  await check("subscriber sink errors do not break the bridge", () => {
    const b = new StatusBridge();
    const off1 = b.subscribe(() => {}, () => {
      throw new Error("boom");
    });
    const frames = [];
    const off2 = b.subscribe(() => {}, (s) => frames.push(s));
    b.setRunning(1);
    assert.equal(frames.length, 1, "other subscribers still receive");
    off1();
    off2();
  });

  await check("close() drops subscribers and resets", () => {
    const b = new StatusBridge();
    const frames = [];
    const off = b.subscribe(() => {}, (s) => frames.push(s));
    off();
    b.close();
    assert.equal(b.subscribers.size, 0);
  });
}

// ---------------------------------------------------------------------------
// B. Route handler over a real HTTP server
// ---------------------------------------------------------------------------
/** Mount the handler on a real server, mimicking the webServer's matcher. */
function mountServer(bridge, { bindHost = "127.0.0.1", gate = null, maxStreamClients = 8 } = {}) {
  const routes = [];
  const webServer = {
    host: bindHost,
    register(route) {
      routes.push(route);
      return () => {
        const i = routes.indexOf(route);
        if (i >= 0) routes.splice(i, 1);
      };
    },
  };
  // Mirror startBridge: the route is registered on the web server, and the
  // handler comes from the same makeRouteHandler the host uses.
  webServer.register({
    kind: "prefix",
    path: STATUS_PATH,
    handler: makeRouteHandler(bridge, { isAllowed: gate, maxStreamClients }),
  });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    let best;
    for (const r of routes) {
      if (r.kind === "prefix" && (pathname === r.path || pathname.startsWith(`${r.path}/`))) {
        best = r;
      }
    }
    if (best) return best.handler(req, res);
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, webServer, port: server.address().port })
    );
  });
}

async function httpGet(port, path, { headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function sectionB() {
  console.log("B. Route handler (real node:http)");

  const bridge = new StatusBridge();
  const { server, port } = await mountServer(bridge);

  await check("GET /session-status returns 200 JSON snapshot", async () => {
    bridge.setRunning(1);
    const r = await httpGet(port, STATUS_PATH);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /application\/json/);
    const body = JSON.parse(r.text);
    assert.equal(body.state, "running");
    assert.equal(body.running, 1);
    assert.equal(body.blocked, 0);
    assert.ok(Array.isArray(body.runningIds));
    assert.equal(typeof body.ts, "number");
  });

  await check("blocked state reflected in snapshot", async () => {
    bridge.onHumanRequest();
    const body = JSON.parse((await httpGet(port, STATUS_PATH)).text);
    assert.equal(body.state, "blocked");
    assert.equal(body.blocked, 1);
    assert.equal(body.running, 1);
    bridge.onHumanSettled();
  });

  await check("non-GET method rejected with 405", async () => {
    const res = await fetch(`http://127.0.0.1:${port}${STATUS_PATH}`, { method: "POST" });
    assert.equal(res.status, 405);
    await res.text();
  });

  await check("SSE stream: retry hint + immediate snapshot frame", async () => {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}${STREAM_PATH}`, {
      signal: ac.signal,
      headers: { accept: "text/event-stream" },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (needle, timeoutMs) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const { value, done } = await Promise.race([
          reader.read(),
          delay(timeoutMs).then(() => ({ done: false, value: undefined })),
        ]);
        if (done) break;
        if (value) buf += dec.decode(value, { stream: true });
        if (buf.includes(needle)) return buf;
      }
      throw new Error(`timeout waiting for "${needle}"; got: ${buf}`);
    };
    await readUntil("retry: 2000", 2000);
    await readUntil(`"state":"running"`, 2000);
    ac.abort();
    try {
      await reader.cancel();
    } catch {}
  });

  await check("SSE stream: change frames pushed on state change", async () => {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}${STREAM_PATH}`, { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readChunk = async (timeoutMs) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buf += dec.decode(value, { stream: true });
          return;
        }
      }
      throw new Error("timeout waiting for stream chunk");
    };
    await readChunk(2000); // initial snapshot
    bridge.onHumanRequest();
    await readChunk(2000);
    assert.match(buf, /"state":"blocked"/);
    bridge.onHumanSettled();
    await readChunk(2000);
    assert.match(buf, /"state":"running"/);
    ac.abort();
    try {
      await reader.cancel();
    } catch {}
  });

  await check("stream client cap enforced (503 over the limit)", async () => {
    const bridge2 = new StatusBridge();
    const m2 = await mountServer(bridge2, { maxStreamClients: 2 });
    try {
      const acs = [];
      const opens = [];
      for (let i = 0; i < 2; i++) {
        const ac = new AbortController();
        acs.push(ac);
        opens.push(fetch(`http://127.0.0.1:${m2.port}${STREAM_PATH}`, { signal: ac.signal }));
      }
      const [a, b] = await Promise.all(opens);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      const c = await fetch(`http://127.0.0.1:${m2.port}${STREAM_PATH}`);
      assert.equal(c.status, 503);
      await c.text();
      for (const ac of acs) ac.abort();
    } finally {
      m2.server.close();
    }
  });

  await check("source gate: loopback allowed, LAN peers refused", async () => {
    const { makeSourceGate } = await import("./dsh-session-status/lib/index.js");
    const gate = makeSourceGate("0.0.0.0");
    assert.equal(gate({ socket: { remoteAddress: "127.0.0.1" } }), true);
    assert.equal(gate({ socket: { remoteAddress: "::1" } }), true);
    assert.equal(gate({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
    assert.equal(gate({ socket: { remoteAddress: "10.0.0.5" } }), false);
    assert.equal(gate({}), false);
    // Loopback bind needs no gate at all.
    assert.equal(makeSourceGate("127.0.0.1"), null);
    assert.equal(makeSourceGate("localhost"), null);
  });

  server.close();
}

// ---------------------------------------------------------------------------
// C. Full apply() integration with a fake host ctx
// ---------------------------------------------------------------------------
/** A minimal fake of the pieces apply() touches. */
function makeFakeCtx({ withAgents = true, withWebServer = true, withSettings = true } = {}) {
  const agents = withAgents
    ? {
        list: () => agentsState.agents,
      }
    : undefined;
  const agentsState = { agents: [] };

  const listeners = new Map(); // name -> [{fn, prepend}]
  const effects = [];
  const webServerRoutes = [];
  const webServer = withWebServer
    ? {
        host: "127.0.0.1",
        register(route) {
          webServerRoutes.push(route);
          return () => {
            const i = webServerRoutes.indexOf(route);
            if (i >= 0) webServerRoutes.splice(i, 1);
          };
        },
      }
    : undefined;

  const settings = withSettings
    ? {
        registered: {},
        register(ns, schema) {
          assert.equal(ns, SETTINGS_NAMESPACE);
          const resolved = schema();
          const watchers = new Set();
          const scope = {
            ns,
            resolved,
            get: () => scope.resolved,
            watch(cb) {
              watchers.add(cb);
              return () => watchers.delete(cb);
            },
            setEnabled(patch) {
              scope.resolved = schema({ ...scope.resolved, ...patch });
              for (const cb of watchers) cb();
            },
          };
          settings.registered[ns] = scope;
          return scope;
        },
      }
    : undefined;

  const ctx = {
    get: (name) => {
      if (name === "agents") return agents;
      if (name === "webServer") return webServer;
      return undefined;
    },
    on: (name, fn, options) => {
      const arr = listeners.get(name) ?? [];
      arr.push({ fn, prepend: options && options.prepend });
      listeners.set(name, arr);
      return () => {
        const i = arr.findIndex((l) => l.fn === fn);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    /** Fire an emit-mode event to all listeners (registration order). */
    fireEmit(name, payload) {
      const arr = listeners.get(name) ?? [];
      for (const l of [...arr]) l.fn(payload);
    },
    /**
     * Run a waterfall: prepend-listeners first (outermost), then the given
     * inner default. Mirrors cordis' dispatch("waterfall") ordering.
     */
    runWaterfall(name, payload, inner) {
      const arr = (listeners.get(name) ?? []).slice().sort((a, b) => {
        if (a.prepend === b.prepend) return 0;
        return a.prepend ? -1 : 1;
      });
      const next = async (i = 0) => {
        if (i >= arr.length) return inner ? inner(payload) : Promise.resolve(undefined);
        return arr[i].fn(payload, () => next(i + 1));
      };
      return next(0);
    },
    // Cordis semantics: an injected plugin ACTIVATES only when every
    // injected service is present; the callback's context then carries the
    // services as properties. Missing any one => the thunk never runs.
    inject: (names, cb) => {
      const resolved = Object.create(null);
      for (const n of names) {
        if (n === "settings") {
          if (settings === undefined) return;
          resolved[n] = settings;
          continue;
        }
        const svc = ctx.get(n);
        if (svc === undefined) return;
        resolved[n] = svc;
      }
      const child = Object.create(ctx);
      for (const [k, v] of Object.entries(resolved)) {
        Object.defineProperty(child, k, { value: v, enumerable: false });
      }
      return cb(child);
    },
    effect: (fn, label) => {
      const cleanup = fn();
      effects.push({ label, cleanup });
    },
    logger: { warn: () => {}, error: () => {} },
    dispose: () => {
      for (const e of effects) e.cleanup && e.cleanup();
      effects.length = 0;
      listeners.clear();
    },
  };
  return { ctx, agentsState, webServerRoutes, settings };
}

async function sectionC() {
  console.log("C. apply() integration (fake host ctx)");

  await check("settings namespace registered with new envelope shape", () => {
    const { ctx, settings } = makeFakeCtx();
    apply(ctx);
    const scope = settings.registered[SETTINGS_NAMESPACE];
    assert.ok(scope, "namespace registered");
    const value = scope.get();
    assert.deepEqual(value, { iconMode: "replace", bridgeEnabled: true });
    // Envelope wire shape (uid 6, top-level boolean default true).
    const env = StatusSchema.toJSON();
    assert.equal(env.uid, 6);
    assert.equal(env.refs[5].type, "boolean");
    assert.equal(env.refs[5].meta.default, true);
    assert.deepEqual(env.refs[6].dict, { iconMode: 3, bridgeEnabled: 5 });
    // Rejection semantics.
    assert.throws(() => StatusSchema({ iconMode: "bogus" }), TypeError);
    assert.throws(() => StatusSchema({ bridgeEnabled: "yes" }), TypeError);
    assert.deepEqual(StatusSchema({}), { iconMode: "replace", bridgeEnabled: true });
    ctx.dispose();
  });

  await check("bridge route registered; snapshot answers through the route", async () => {
    const { ctx, agentsState, webServerRoutes } = makeFakeCtx();
    apply(ctx);
    assert.equal(webServerRoutes.length, 1);
    assert.equal(webServerRoutes[0].kind, "prefix");
    assert.equal(webServerRoutes[0].path, "/session-status");
    // Drive a real request through the registered handler.
    const route = webServerRoutes[0];
    const req = { method: "GET", url: "/session-status", socket: {} };
    let code, body;
    const res = {
      writeHead(c, h) {
        code = c;
      },
      end(b) {
        body = b;
      },
      write() {},
      on() {},
      once() {},
      destroy() {},
    };
    route.handler(req, res);
    assert.equal(code, 200);
    assert.equal(JSON.parse(body).state, "idle");
    // An agent starts running via the registry + events.
    agentsState.agents = [{ status: "running" }];
    ctx.fireEmit("agent/created", {});
    code = body = null;
    route.handler(req, res);
    assert.equal(JSON.parse(body).state, "running");
    ctx.dispose();
    assert.equal(webServerRoutes.length, 0, "dispose removes the route");
  });

  await check("approval waterfall tap: in-flight -> blocked -> settled", async () => {
    const { ctx, webServerRoutes } = makeFakeCtx();
    apply(ctx);
    const route = webServerRoutes[0];
    const snap = () => {
      let body;
      const res = {
        writeHead() {},
        end(b) {
          body = b;
        },
        write() {},
        on() {},
        destroy() {},
      };
      route.handler({ method: "GET", url: "/session-status", socket: {} }, res);
      return JSON.parse(body);
    };
    assert.equal(snap().state, "idle");
    // A request enters the waterfall; the tap counts it while pending.
    const pending = ctx.runWaterfall("approval/request", { agent: "a" }, async () => {
      await delay(30); // the human hasn't answered yet
      return "allowed-once";
    });
    await delay(5); // tap has entered, inner still pending
    assert.equal(snap().state, "blocked", "in-flight request is red");
    const outcome = await pending;
    assert.equal(outcome, "allowed-once", "tap preserves the chain outcome");
    assert.equal(snap().state, "idle", "settled request no longer red");
    ctx.dispose();
  });

  await check("user-questions waterfall tap: question -> blocked -> settled", async () => {
    const { ctx, webServerRoutes } = makeFakeCtx();
    apply(ctx);
    const route = webServerRoutes[0];
    const snap = () => {
      let body;
      const res = {
        writeHead() {},
        end(b) {
          body = b;
        },
        write() {},
        on() {},
        destroy() {},
      };
      route.handler({ method: "GET", url: "/session-status", socket: {} }, res);
      return JSON.parse(body);
    };
    const pending = ctx.runWaterfall(
      "user-questions/request",
      { questions: [] },
      async () => {
        await delay(30);
        return { answers: [] };
      }
    );
    await delay(5);
    assert.equal(snap().state, "blocked");
    await pending;
    assert.equal(snap().state, "idle");
    ctx.dispose();
  });

  await check("tap is prepend: an earlier-registered answerer cannot hide it", async () => {
    const { ctx, webServerRoutes } = makeFakeCtx();
    // Register a rival answerer BEFORE apply() (with a plain push-order tap
    // it would sit OUTERMOST and claim the request — the tap would never
    // see it). The claim is async so the in-flight window is observable.
    ctx.on("approval/request", async (req, next) => {
      await delay(30); // simulate the answerer holding the request
      return "rejected"; // claims the request, never calls next()
    });
    apply(ctx);
    const route = webServerRoutes[0];
    const snap = () => {
      let body;
      const res = {
        writeHead() {},
        end(b) {
          body = b;
        },
        write() {},
        on() {},
        destroy() {},
      };
      route.handler({ method: "GET", url: "/session-status", socket: {} }, res);
      return JSON.parse(body);
    };
    const pending = ctx.runWaterfall("approval/request", {}, async () => "unavailable");
    await delay(5);
    assert.equal(snap().state, "blocked", "prepend tap sees the request even with a claimant");
    const outcome = await pending;
    assert.equal(outcome, "rejected", "rival answerer's outcome preserved");
    assert.equal(snap().state, "idle");
    ctx.dispose();
  });

  await check("agent/status + disposed events keep the running count honest", async () => {
    const { ctx, agentsState, webServerRoutes } = makeFakeCtx();
    apply(ctx);
    const route = webServerRoutes[0];
    const snap = () => {
      let body;
      const res = {
        writeHead() {},
        end(b) {
          body = b;
        },
        write() {},
        on() {},
        destroy() {},
      };
      route.handler({ method: "GET", url: "/session-status", socket: {} }, res);
      return JSON.parse(body);
    };
    agentsState.agents = [{ status: "running" }, { status: "idle" }];
    ctx.fireEmit("agent/created", {});
    assert.equal(snap().running, 1);
    agentsState.agents = [{ status: "idle" }, { status: "idle" }];
    ctx.fireEmit("agent/status", {});
    assert.equal(snap().state, "idle");
    ctx.fireEmit("agent/disposed", {});
    assert.equal(snap().running, 0);
    ctx.dispose();
  });

  await check("settings watch: disabling removes the route, enabling restores it", async () => {
    const { ctx, webServerRoutes, settings } = makeFakeCtx();
    apply(ctx);
    assert.equal(webServerRoutes.length, 1);
    settings.registered[SETTINGS_NAMESPACE].setEnabled({ bridgeEnabled: false });
    assert.equal(webServerRoutes.length, 0, "disabled: route unregistered");
    settings.registered[SETTINGS_NAMESPACE].setEnabled({ bridgeEnabled: true });
    assert.equal(webServerRoutes.length, 1, "re-enabled: route restored");
    ctx.dispose();
  });

  await check("non-web composition (no agents/webServer): bridge thunk never runs", () => {
    const { ctx, webServerRoutes, settings } = makeFakeCtx({
      withAgents: false,
      withWebServer: false,
    });
    apply(ctx);
    assert.equal(webServerRoutes.length, 0, "no route without webServer");
    assert.ok(
      !webServerRoutes.some((r) => r.path === "/session-status"),
      "bridge thunk never ran (service gate)"
    );
    assert.equal(
      settings.registered[SETTINGS_NAMESPACE],
      undefined,
      "namespace is owned by the bridge fiber; absent where the bridge is"
    );
    ctx.dispose();
  });

  await check("web services without settings provider: bridge still mounts", () => {
    const { ctx, webServerRoutes, settings } = makeFakeCtx({
      withAgents: true,
      withWebServer: true,
      withSettings: false,
    });
    apply(ctx);
    assert.ok(
      webServerRoutes.some((r) => r.path === "/session-status"),
      "bridge mounts without the settings provider"
    );
    ctx.dispose();
  });
}

// ---------------------------------------------------------------------------
await sectionA();
await sectionB();
await sectionC();
console.log(`\nall ${passed} checks passed`);
