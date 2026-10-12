/**
 * dsh-session-status — host bridge tests (plain node, zero deps).
 *
 * Four layers:
 *   A. StatusBridge state machine (unit)
 *   B. Route handler over a REAL node:http server (snapshot + SSE + caps + gate)
 *   C. Full apply() integration with a fake host ctx (event bus, agents
 *      registry, web server, settings page policy) — the 0.2.0 wiring the
 *      real composition runs at boot: `apply(ctx, config)` with a validated
 *      volatile-reference config, and the volatile hot-toggle committed the
 *      way the Loader commits it (in-place reference write +
 *      `loader/volatile-update` on the entry context).
 *   D. End-to-end against the REAL cordis Context + cordis-plugin-loader
 *      (installed with DSH): boot the actual plugin module as a Loader entry,
 *      drive settings writes through the real entry.update() path, and
 *      verify the volatile-only commits land in place without remounting.
 *      Skipped (not failed) when no DSH install is resolvable.
 *
 * Run: node test-status-server.mjs   (exits non-zero on first failure)
 */

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  StatusBridge,
  STATUS_PATH,
  STREAM_PATH,
  deriveState,
  buildSnapshot,
  makeRouteHandler,
} from "./dsh-session-status/lib/bridge.js";
import { apply, Config, SETTINGS_NAMESPACE } from "./dsh-session-status/lib/index.js";

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
    const off = b.subscribe(() => {}, (s) => s && s.state);
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
// C. Full apply() integration with a fake host ctx (0.2.0 contract)
// ---------------------------------------------------------------------------
/** The cosmokit volatile write key (same Symbol.for as the plugin). */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/**
 * Read a validated config field that is a volatile reference.
 */
function refValue(field, fallback) {
  if (field !== null && typeof field === "object" && typeof field.get === "function") {
    return field.get();
  }
  return field === undefined ? fallback : field;
}

/**
 * Commit a volatile-only raw config change the way the Loader does
 * (`_commitVolatile`): validate the raw candidate, write the changed values
 * INTO the running references (in place), then emit `loader/volatile-update`
 * on the entry context with the changed paths.
 * @param fake - `{ ctx, config }` from makeFakeCtx.
 * @param raw - the new raw entry config (as dsh-settings persists it).
 * @returns the changed paths.
 */
function commitVolatile(fake, raw) {
  const candidate = Config["~standard"].validate(raw);
  assert.ok(!candidate.issues, "candidate must validate: " + JSON.stringify(candidate.issues));
  const paths = [];
  for (const key of Object.keys(fake.config)) {
    const ref = fake.config[key];
    const source = candidate.value[key];
    if (refValue(ref) !== refValue(source)) {
      ref[VOLATILE_WRITE](refValue(source));
      paths.push([key]);
    }
  }
  fake.ctx.fireEmit("loader/volatile-update", paths);
  return paths;
}

/**
 * A minimal fake of the pieces apply() touches in the 0.2.0 model:
 * the entry context (with `fiber`), the agents registry, the web server,
 * and the settings page-policy service (`configure`, not `register`).
 */
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

  // 0.2.0 settings service face the plugin uses: `configure(presentation,
  // owner)` returns a disposer; the settings service rejects a second policy
  // for the same owner fiber (the real one throws).
  const settings = withSettings
    ? {
        policies: new Map(), // owner fiber -> presentation
        configureCalls: 0,
        configure(presentation, owner) {
          assert.ok(owner, "page policy must carry an owner fiber");
          assert.equal(
            this.policies.has(owner),
            false,
            "duplicate page policy for the same fiber (the real service throws)"
          );
          this.policies.set(owner, presentation);
          this.configureCalls += 1;
          return () => {
            if (this.policies.get(owner) === presentation) this.policies.delete(owner);
          };
        },
      }
    : undefined;

  // The entry fiber object (identity only: the settings policy is keyed by it).
  const fiber = { uid: 1, name: SETTINGS_NAMESPACE };

  const ctx = {
    fiber,
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

/** Boot apply() the way the Loader boots it: validate the raw config, then apply(ctx, config). */
function bootApply(fake, rawConfig = {}) {
  const validated = Config["~standard"].validate(rawConfig);
  assert.ok(!validated.issues, "raw config must validate: " + JSON.stringify(validated.issues));
  fake.config = validated.value;
  apply(fake.ctx, fake.config);
  return fake.config;
}

/** Drive a GET /session-status through the registered route handler. */
function snapshotOf(webServerRoutes) {
  if (!webServerRoutes.length) return null;
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
  webServerRoutes[0].handler({ method: "GET", url: "/session-status", socket: {} }, res);
  return JSON.parse(body);
}

async function sectionC() {
  console.log("C. apply() integration (fake host ctx, 0.2.0 contract)");

  await check("Config ~standard: sync validate, {value}/{issues}, live volatile refs", () => {
    assert.equal(Config["~standard"].version, 1, "standard schema version");
    assert.equal(
      Config["~standard"].vendor,
      "schemastery",
      "vendor tag — the Loader's equalExceptVolatile only runs the schema-aware volatile diff for vendor 'schemastery'"
    );
    const ok = Config["~standard"].validate({});
    assert.ok(ok.value, "valid input yields {value}");
    assert.ok(!("then" in ok), "validation is synchronous (no promise)");
    // Volatile fields resolve to live references in the cosmokit protocol.
    for (const [key, ref] of Object.entries(ok.value)) {
      assert.equal(typeof ref.get, "function", `${key} is a live reference`);
      assert.ok(VOLATILE_WRITE in ref, `${key} carries the volatile write key`);
      assert.ok(Object.isFrozen(ref), `${key} reference is frozen`);
    }
    assert.equal(ok.value.iconMode.get(), "replace", "default iconMode");
    assert.equal(ok.value.bridgeEnabled.get(), true, "default bridgeEnabled");
    // Explicit values pass through.
    const set = Config["~standard"].validate({ iconMode: "combined", bridgeEnabled: false });
    assert.equal(set.value.iconMode.get(), "combined");
    assert.equal(set.value.bridgeEnabled.get(), false);
    // Rejections report {issues} with a path (cordis wraps them in ValidationError).
    const badMode = Config["~standard"].validate({ iconMode: "bogus" });
    assert.ok(badMode.issues && badMode.issues.length === 1, "invalid iconMode -> issues");
    assert.deepEqual(badMode.issues[0].path, ["iconMode"]);
    assert.match(badMode.issues[0].message, /iconMode/);
    const badBool = Config["~standard"].validate({ bridgeEnabled: "yes" });
    assert.ok(badBool.issues, "invalid bridgeEnabled -> issues");
    assert.deepEqual(badBool.issues[0].path, ["bridgeEnabled"]);
    // Non-object candidates fall back to defaults.
    assert.equal(Config["~standard"].validate(undefined).value.iconMode.get(), "replace");
  });

  await check("Config form-projection face: type/dict/meta walk + per-leaf volatile + leaf toJSON", () => {
    // dsh-settings projects the form by walking `type` / `dict` / `meta`
    // (volatility read from `meta.volatile`) and rehydrates each volatile
    // leaf from its own `toJSON()` — every surface must be present.
    assert.equal(Config.type, "object");
    assert.equal(Config.meta.volatile, undefined, "root is NOT volatile (only the leaves are)");
    const icon = Config.dict.iconMode;
    const bridge = Config.dict.bridgeEnabled;
    assert.equal(icon.type, "union");
    assert.equal(bridge.type, "boolean");
    assert.equal(icon.meta.volatile, true);
    assert.equal(bridge.meta.volatile, true);
    assert.equal(icon.meta.default, "replace");
    assert.equal(bridge.meta.default, true);
    // Root meta.default carries the plain defaults (the form's base view).
    assert.deepEqual(Config.meta.default, { iconMode: "replace", bridgeEnabled: true });
    // Leaf envelopes are SELF-CONTAINED ({uid, refs}), never bare nodes —
    // plainSchema rehydrates each one standalone.
    for (const [key, leaf] of Object.entries(Config.dict)) {
      const env = leaf.toJSON();
      assert.equal(typeof env.uid, "number", `${key} leaf envelope has a uid`);
      assert.ok(env.refs && typeof env.refs === "object", `${key} leaf envelope has refs`);
      assert.ok(env.refs[env.uid], `${key} leaf envelope root ref present`);
      // No dangling indices: every list/dict reference resolves.
      const visit = (node) => {
        for (const uid of node.list ?? []) visit(env.refs[uid]);
        for (const uid of Object.values(node.dict ?? {})) visit(env.refs[uid]);
        if (node.inner !== undefined) visit(env.refs[node.inner]);
      };
      visit(env.refs[env.uid]);
    }
  });

  await check("Config root toJSON: frozen wire envelope (schemastery 3.18.4 shape)", () => {
    const env = Config.toJSON();
    assert.equal(env.uid, 8);
    assert.deepEqual(Object.keys(env.refs).sort(), ["0", "1", "4", "7", "8"]);
    assert.equal(env.refs[0].type, "const");
    assert.equal(env.refs[0].value, "replace");
    assert.equal(env.refs[1].value, "combined");
    assert.equal(env.refs[4].type, "union");
    assert.deepEqual(env.refs[4].list, [0, 1]);
    assert.equal(env.refs[4].meta.default, "replace");
    assert.equal(env.refs[4].meta.volatile, true);
    assert.equal(env.refs[7].type, "boolean");
    assert.equal(env.refs[7].meta.default, true);
    assert.equal(env.refs[7].meta.volatile, true);
    assert.equal(env.refs[8].type, "object");
    assert.deepEqual(env.refs[8].dict, { iconMode: 4, bridgeEnabled: 7 });
    // toJSON returns a fresh copy every call (the wire layer may mutate).
    assert.notEqual(env, Config.toJSON());
  });

  await check("bridge route registered; snapshot answers through the route", () => {
    const fake = makeFakeCtx();
    bootApply(fake);
    assert.equal(fake.webServerRoutes.length, 1);
    assert.equal(fake.webServerRoutes[0].kind, "prefix");
    assert.equal(fake.webServerRoutes[0].path, "/session-status");
    // Drive a real request through the registered handler.
    assert.equal(snapshotOf(fake.webServerRoutes).state, "idle");
    // An agent starts running via the registry + events.
    fake.agentsState.agents = [{ id: "agent-1", status: "running" }];
    fake.ctx.fireEmit("agent/created", {});
    assert.equal(snapshotOf(fake.webServerRoutes).state, "running");
    assert.deepEqual(
      snapshotOf(fake.webServerRoutes).runningIds,
      ["agent-1"],
      "runningIds carries the agent id"
    );
    fake.ctx.dispose();
    assert.equal(fake.webServerRoutes.length, 0, "dispose removes the route");
  });

  await check("settings page policy registered in the bridge fiber ({auto:false}, entry fiber)", () => {
    const fake = makeFakeCtx();
    bootApply(fake);
    assert.equal(fake.settings.configureCalls, 1, "policy registered exactly once at boot");
    assert.deepEqual(fake.settings.policies.get(fake.ctx.fiber), { auto: false });
    fake.ctx.dispose();
    assert.equal(fake.settings.policies.size, 0, "dispose unwinds the policy");
    // Re-applying (a remount) may register again — the effect, not the
    // service, owns the lifetime.
    bootApply(fake);
    assert.equal(fake.settings.configureCalls, 2);
    fake.ctx.dispose();
  });

  await check("approval waterfall tap: in-flight -> blocked -> settled", async () => {
    const fake = makeFakeCtx();
    bootApply(fake);
    assert.equal(snapshotOf(fake.webServerRoutes).state, "idle");
    // A request enters the waterfall; the tap counts it while pending.
    const pending = fake.ctx.runWaterfall("approval/request", { agent: "a" }, async () => {
      await delay(30); // the human hasn't answered yet
      return "allowed-once";
    });
    await delay(5); // tap has entered, inner still pending
    assert.equal(snapshotOf(fake.webServerRoutes).state, "blocked", "in-flight request is red");
    const outcome = await pending;
    assert.equal(outcome, "allowed-once", "tap preserves the chain outcome");
    assert.equal(snapshotOf(fake.webServerRoutes).state, "idle", "settled request no longer red");
    fake.ctx.dispose();
  });

  await check("user-questions waterfall tap: question -> blocked -> settled", async () => {
    const fake = makeFakeCtx();
    bootApply(fake);
    const pending = fake.ctx.runWaterfall(
      "user-questions/request",
      { questions: [] },
      async () => {
        await delay(30);
        return { answers: [] };
      }
    );
    await delay(5);
    assert.equal(snapshotOf(fake.webServerRoutes).state, "blocked");
    await pending;
    assert.equal(snapshotOf(fake.webServerRoutes).state, "idle");
    fake.ctx.dispose();
  });

  await check("tap is prepend: an earlier-registered answerer cannot hide it", async () => {
    const fake = makeFakeCtx();
    // Register a rival answerer BEFORE apply() (with a plain push-order tap
    // it would sit OUTERMOST and claim the request — the tap would never
    // see it). The claim is async so the in-flight window is observable.
    fake.ctx.on("approval/request", async (req, next) => {
      await delay(30); // simulate the answerer holding the request
      return "rejected"; // claims the request, never calls next()
    });
    bootApply(fake);
    const pending = fake.ctx.runWaterfall("approval/request", {}, async () => "unavailable");
    await delay(5);
    assert.equal(
      snapshotOf(fake.webServerRoutes).state,
      "blocked",
      "prepend tap sees the request even with a claimant"
    );
    const outcome = await pending;
    assert.equal(outcome, "rejected", "rival answerer's outcome preserved");
    assert.equal(snapshotOf(fake.webServerRoutes).state, "idle");
    fake.ctx.dispose();
  });

  await check("agent/status + disposed events keep the running count honest", () => {
    const fake = makeFakeCtx();
    bootApply(fake);
    fake.agentsState.agents = [
      { id: "agent-1", status: "running" },
      { id: "agent-2", status: "idle" },
    ];
    fake.ctx.fireEmit("agent/created", {});
    assert.equal(snapshotOf(fake.webServerRoutes).running, 1);
    assert.deepEqual(snapshotOf(fake.webServerRoutes).runningIds, [
      "agent-1",
    ]);
    fake.agentsState.agents = [
      { id: "agent-1", status: "idle" },
      { id: "agent-2", status: "idle" },
    ];
    fake.ctx.fireEmit("agent/status", {});
    assert.equal(snapshotOf(fake.webServerRoutes).state, "idle");
    fake.ctx.fireEmit("agent/disposed", {});
    assert.equal(snapshotOf(fake.webServerRoutes).running, 0);
    assert.deepEqual(snapshotOf(fake.webServerRoutes).runningIds, []);
    fake.ctx.dispose();
  });

  await check("volatile hot-toggle: disabling removes the route, enabling restores it", () => {
    const fake = makeFakeCtx();
    const config = bootApply(fake);
    assert.equal(fake.webServerRoutes.length, 1);
    // dsh-settings persisted bridgeEnabled=false; the Loader commits it in
    // place and dispatches loader/volatile-update to the entry fiber.
    const paths = commitVolatile(fake, { bridgeEnabled: false });
    assert.deepEqual(paths, [["bridgeEnabled"]], "only the changed path is reported");
    assert.equal(fake.webServerRoutes.length, 0, "disabled: route unregistered");
    assert.equal(snapshotOf(fake.webServerRoutes), null);
    // No remount: the settings page policy was NOT re-registered (a remount
    // would dispose + re-register it, i.e. configureCalls would grow).
    assert.equal(fake.settings.configureCalls, 1, "hot-toggle does not remount the entry");
    // The reference object is stable — the listener reads the live value.
    assert.equal(config.bridgeEnabled.get(), false, "committed value is live in the reference");
    // Re-enable.
    commitVolatile(fake, { bridgeEnabled: true });
    assert.equal(fake.webServerRoutes.length, 1, "re-enabled: route restored");
    assert.equal(fake.settings.configureCalls, 1, "still no remount");
    // A no-op commit (same value) changes nothing and reports no paths.
    assert.deepEqual(commitVolatile(fake, { bridgeEnabled: true }), []);
    assert.equal(fake.webServerRoutes.length, 1);
    fake.ctx.dispose();
  });

  await check("volatile hot-toggle: an iconMode-only change leaves the bridge untouched", () => {
    const fake = makeFakeCtx();
    const config = bootApply(fake);
    const paths = commitVolatile(fake, { iconMode: "combined" });
    assert.deepEqual(paths, [["iconMode"]]);
    assert.equal(fake.webServerRoutes.length, 1, "bridge stays up on iconMode change");
    assert.equal(config.iconMode.get(), "combined", "iconMode committed in place");
    assert.equal(config.bridgeEnabled.get(), true, "bridgeEnabled untouched");
    fake.ctx.dispose();
  });

  await check("boot with bridgeEnabled=false: no route until a volatile commit enables it", () => {
    const fake = makeFakeCtx();
    const config = bootApply(fake, { bridgeEnabled: false });
    assert.equal(config.bridgeEnabled.get(), false);
    assert.equal(fake.webServerRoutes.length, 0, "disabled at boot: route never installed");
    commitVolatile(fake, { bridgeEnabled: true });
    assert.equal(fake.webServerRoutes.length, 1, "volatile commit installs the route");
    assert.equal(snapshotOf(fake.webServerRoutes).state, "idle");
    fake.ctx.dispose();
    assert.equal(fake.webServerRoutes.length, 0, "dispose removes the route");
  });

  await check("non-web composition (no agents/webServer): bridge + policy never registered", () => {
    const fake = makeFakeCtx({
      withAgents: false,
      withWebServer: false,
    });
    bootApply(fake);
    assert.equal(fake.webServerRoutes.length, 0, "no route without webServer");
    assert.equal(
      fake.settings.configureCalls,
      0,
      "page policy is owned by the bridge fiber; absent where the bridge is absent"
    );
    fake.ctx.dispose();
  });

  await check("web services without settings provider: bridge still mounts, no policy", () => {
    const fake = makeFakeCtx({
      withAgents: true,
      withWebServer: true,
      withSettings: false,
    });
    bootApply(fake);
    assert.equal(
      fake.webServerRoutes.length,
      1,
      "bridge mounts without the settings provider"
    );
    fake.ctx.dispose();
  });
}

// ---------------------------------------------------------------------------
// D. End-to-end against the REAL cordis + cordis-plugin-loader (installed DSH)
// ---------------------------------------------------------------------------
/**
 * Locate the DSH install's cordis / cordis-plugin-loader. Returns a
 * createRequire rooted at that node_modules, or null when no DSH install is
 * resolvable (the section is then skipped, not failed).
 */
function findDshModules() {
  const candidates = [];
  // $DSH_HOME is not needed; probe the standard global locations + PATH.
  const homedir = process.env.HOME || process.env.USERPROFILE || "";
  const roots = [
    "/usr/lib/node_modules",
    "/usr/local/lib/node_modules",
  ];
  if (homedir) roots.push(join(homedir, ".nvm/versions/node"));
  // Also try resolving from the current process (works when DSH is a dep).
  try {
    const localReq = createRequire(import.meta.url);
    roots.push(localReq.resolve.paths("@deepseek-ai/cordis")?.[0] || "");
  } catch {}
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    const probe = join(root, "@deepseek-ai/dsh/node_modules");
    if (existsSync(join(probe, "@deepseek-ai/cordis")) &&
        existsSync(join(probe, "@deepseek-ai/cordis-plugin-loader"))) {
      return { probe, req: createRequire(join(probe, "x.js")) };
    }
    // nvm: root is the versions dir — walk each node version.
    try {
      for (const v of readdirSync(root, { withFileTypes: true })) {
        if (!v.isDirectory()) continue;
        const p = join(root, v.name, "lib/node_modules/@deepseek-ai/dsh/node_modules");
        if (existsSync(join(p, "@deepseek-ai/cordis")) &&
            existsSync(join(p, "@deepseek-ai/cordis-plugin-loader"))) {
          return { probe: p, req: createRequire(join(p, "x.js")) };
        }
      }
    } catch {}
  }
  return null;
}

async function sectionD() {
  console.log("D. End-to-end (real cordis Context + cordis-plugin-loader)");
  const dsh = await findDshModules();
  if (!dsh) {
    console.log("  -- no DSH install found; section D skipped (install DSH to enable it)");
    return;
  }
  const { Context } = dsh.req("@deepseek-ai/cordis");
  const { Loader } = dsh.req("@deepseek-ai/cordis-plugin-loader");
  const PLUGIN = "./dsh-session-status/lib/index.js";

  /** Boot the REAL plugin module as a Loader entry with stub services. */
  async function boot(initialConfig) {
    const ctx = new Context();
    const errors = [];
    ctx.logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (...a) => errors.push(a),
    };
    const loader = new Loader(ctx, {});
    await delay(0); // let the loader's internal plugin settle before entries
    const webServerRoutes = [];
    const agentsList = [];
    const settingsStub = { calls: 0, configure() { this.calls += 1; return () => {}; } };
    ctx.reflect.provide("agents", { list: () => agentsList });
    ctx.reflect.provide("webServer", {
      host: "127.0.0.1",
      register(route) {
        webServerRoutes.push(route);
        return () => {
          const i = webServerRoutes.indexOf(route);
          if (i >= 0) webServerRoutes.splice(i, 1);
        };
      },
    });
    ctx.reflect.provide("settings", settingsStub);
    const volatileUpdates = [];
    ctx.on("loader/volatile-update", (paths) => volatileUpdates.push(paths), { global: true });
    // Pre-resolve the plugin so the Loader imports the same module instance
    // (relative entry names resolve against the test file's location).
    await import(PLUGIN);
    const id = await loader.root.create({
      id: SETTINGS_NAMESPACE,
      name: PLUGIN,
      config: initialConfig ?? {},
    });
    const entry = loader.resolve(id);
    await delay(30);
    return { ctx, entry, webServerRoutes, agentsList, errors, volatileUpdates, settingsStub };
  }

  await check("boot: entry activates, route mounts, page policy registered", async () => {
    const { webServerRoutes, settingsStub, volatileUpdates } = await boot();
    assert.equal(webServerRoutes.length, 1, "route mounted");
    assert.equal(webServerRoutes[0].path, STATUS_PATH);
    assert.equal(settingsStub.calls, 1, "page policy registered once");
    assert.deepEqual(volatileUpdates, [], "no volatile updates at boot");
    const snap = snapshotOf(webServerRoutes);
    assert.equal(snap.state, "idle");
  });

  await check("volatile-only write commits in place (no remount) and toggles the route", async () => {
    const { entry, webServerRoutes, volatileUpdates, settingsStub } = await boot();
    // dsh-settings persists the change into the entry's raw config; the
    // Loader's entry.update is exactly what the profile patch triggers.
    await entry.update({ config: { bridgeEnabled: false } });
    await delay(30);
    assert.equal(webServerRoutes.length, 0, "route uninstalled");
    assert.deepEqual(volatileUpdates, [[["bridgeEnabled"]]], "emitted as a volatile update");
    assert.equal(settingsStub.calls, 1, "NO remount (policy registered exactly once)");
    await entry.update({ config: { bridgeEnabled: true } });
    await delay(30);
    assert.equal(webServerRoutes.length, 1, "route reinstalled");
    assert.deepEqual(volatileUpdates, [[["bridgeEnabled"]], [["bridgeEnabled"]]]);
    assert.equal(settingsStub.calls, 1, "still no remount");
  });

  await check("boot disabled + iconMode-only change keeps it off; enabling brings it up", async () => {
    const { entry, webServerRoutes, volatileUpdates } = await boot({ bridgeEnabled: false });
    assert.equal(webServerRoutes.length, 0, "no route when disabled at boot");
    await entry.update({ config: { bridgeEnabled: false, iconMode: "combined" } });
    await delay(30);
    assert.equal(webServerRoutes.length, 0, "iconMode-only change keeps bridge off");
    await entry.update({ config: { iconMode: "combined", bridgeEnabled: true } });
    await delay(30);
    assert.equal(webServerRoutes.length, 1, "enable brings the route up");
    assert.deepEqual(
      volatileUpdates.flatMap((p) => p).flat().sort(),
      ["bridgeEnabled", "iconMode"],
      "both fields committed volatile-only"
    );
  });

  await check("invalid config at boot: entry stays inactive, error logged, no crash", async () => {
    const { webServerRoutes, errors } = await boot({ iconMode: "bogus" });
    assert.equal(webServerRoutes.length, 0, "bridge never starts");
    assert.ok(errors.length >= 1, "validation error was logged to the host logger");
  });

  await check("agent events + waterfall taps through the real cordis dispatch", async () => {
    const { entry, webServerRoutes, agentsList } = await boot();
    // running count
    agentsList.push({ id: "agent-1", status: "running" }, { id: "agent-2", status: "idle" });
    entry.fiber.ctx.emit("agent/created", {});
    assert.equal(snapshotOf(webServerRoutes).running, 1);
    assert.deepEqual(snapshotOf(webServerRoutes).runningIds, ["agent-1"]);
    agentsList.length = 0;
    entry.fiber.ctx.emit("agent/disposed", {});
    assert.equal(snapshotOf(webServerRoutes).running, 0);
    assert.deepEqual(snapshotOf(webServerRoutes).runningIds, []);
    // blocked count (real waterfall, incl. a claimant that never calls next)
    const pending = entry.fiber.ctx.waterfall(
      entry.fiber.ctx,
      "approval/request",
      { agent: "a" },
      () => new Promise((r) => setTimeout(() => r("allowed-once"), 30))
    );
    await delay(10);
    assert.equal(snapshotOf(webServerRoutes).state, "blocked");
    assert.equal(await pending, "allowed-once");
    assert.equal(snapshotOf(webServerRoutes).state, "idle");
    entry.fiber.ctx.on(
      "user-questions/request",
      async (q, next) => {
        await delay(30);
        return { claimed: true };
      }
    );
    const pending2 = entry.fiber.ctx.waterfall(
      entry.fiber.ctx,
      "user-questions/request",
      { questions: [] },
      () => "unavailable"
    );
    await delay(10);
    assert.equal(snapshotOf(webServerRoutes).state, "blocked", "prepend tap sees claimant-held request");
    assert.deepEqual(await pending2, { claimed: true });
    assert.equal(snapshotOf(webServerRoutes).state, "idle");
  });

  await check("entry dispose removes the route", async () => {
    const { entry, webServerRoutes } = await boot();
    assert.equal(webServerRoutes.length, 1);
    entry.fiber.dispose();
    await delay(50);
    assert.equal(webServerRoutes.length, 0, "dispose removes the route");
  });
}

// ---------------------------------------------------------------------------
await sectionA();
await sectionB();
await sectionC();
await sectionD();
console.log(`\nall ${passed} checks passed`);
