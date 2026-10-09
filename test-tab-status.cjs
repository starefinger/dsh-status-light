// Simulation test for dsh-session-status v0.2.0 (sidebar dot + tab title/favicon).
// Runs the real lib/client.js bundle in a VM with fake document/window/react/stores.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const PLUGIN_DIR = __dirname;
const code = fs.readFileSync(path.join(PLUGIN_DIR, "dsh-session-status", "lib", "client.js"), "utf8");

// ── fake DOM ──────────────────────────────────────────────────────────────
const styles = [];
const iconLink = { getAttribute: (n) => (n === "href" ? "/favicon.ico" : null), href: "/favicon.ico" };
const fakeDoc = {
  title: "DeepSeek Harness",
  _links: [iconLink],
  querySelector(sel) {
    if (sel.startsWith("style[data-plugin-css")) return styles.find((s) => s.dataset && sel.includes(s.dataset.pluginCss)) || null;
    if (sel.startsWith("link[rel")) return this._links[0];
    return null;
  },
  createElement(tag) {
    const el = { tagName: tag, dataset: {}, textContent: "", appendChild(c) { if (c.tagName === "style") styles.push(c); } };
    return el;
  },
  head: { appendChild(c) { if (c.tagName === "style") styles.push(c); } },
};
const windowObj = { document: fakeDoc };
windowObj.window = windowObj;
windowObj.__ModuleLoader__ = { load(e) { (this.entries = this.entries || []).push(e); } };

const sandbox = {
  window: windowObj,
  document: fakeDoc,
  console, Symbol, Object, Array, JSON, Error, Math, encodeURIComponent,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const entry = windowObj.__ModuleLoader__.entries[0];
assert.strictEqual(entry.id, "dsh-session-status");

// ── materialize with stub react ──────────────────────────────────────────
function h(type, props) { props.children = props.children; return { type, props }; }
const stubReact = { createElement: h };
const exported = entry.factory((name) => (name === "react" ? stubReact : (() => { throw new Error("unexpected require " + name); })));
assert.strictEqual(JSON.stringify(exported.inject), JSON.stringify(["slots", "sessions", "uiSession"]));

// ── fake stores ──────────────────────────────────────────────────────────
function makeStore(initial) {
  const listeners = new Set();
  let value = initial;
  return {
    get value() { return value; },
    set(v) { value = v; for (const l of [...listeners]) l(); },
    getSnapshot: () => value,
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    _listeners: listeners,
  };
}
const listStore = makeStore({ ids: ["s1", "s2"], byId: { s1: { running: false }, s2: { running: false } } });
const pendingStore = makeStore(new Map());
let effectCleanups = [];
const fakeCtx = {
  slots: { inject: (s, f) => { fakeCtx._thunk = f; }, register: (o, c) => { fakeCtx._opts = o; fakeCtx._comp = c; return c; } },
  sessions: { list: listStore },
  uiSession: { pendingInteractions: pendingStore },
  logger: { warn: () => {} },
  effect(fn, label) { const cleanup = fn(); effectCleanups.push(() => cleanup && cleanup()); },
};

exported.apply(fakeCtx);
const comp = fakeCtx._thunk(); // owner resolves the slot
assert.strictEqual(fakeCtx._opts.id, "session-status");
assert.strictEqual(typeof comp, "function");

const dot = (out) => out.props.children.props["data-state"];
const state = (out) => out.props["data-dss-state"];
const EMPTY = () => new Map();

// ── 1. initial prime: idle → green favicon, title untouched ──────────────
assert.strictEqual(fakeDoc.title, "DeepSeek Harness", "title must stay untouched");
assert.ok(iconLink.href.startsWith("data:image/svg+xml,"), "favicon should be a data URI");
assert.ok(iconLink.href.includes(encodeURIComponent("#22c55e")), "initial favicon should be green");
assert.strictEqual(state(comp({ useSessions: (s) => s(listStore.value), useSessionPendingInteraction: (s) => s(pendingStore.value) })), "idle");

// ── 2. list store change → running → yellow favicon, title still untouched ─
listStore.set({ ids: ["s1", "s2"], byId: { s1: { running: true }, s2: { running: false } } });
assert.strictEqual(fakeDoc.title, "DeepSeek Harness", "title still untouched while running");
assert.ok(iconLink.href.includes(encodeURIComponent("#f59e0b")), "favicon should be yellow");
const runOut = comp({ useSessions: (s) => s(listStore.value), useSessionPendingInteraction: (s) => s(pendingStore.value) });
assert.strictEqual(state(runOut), "running");
assert.strictEqual(dot(runOut), "running");

// ── 3. pending store change → blocked → red favicon (overrides running) ───
const pending = new Map([["s1", { kind: "question" }], ["s2", { kind: "approval" }]]);
pendingStore.set(pending);
assert.strictEqual(fakeDoc.title, "DeepSeek Harness", "title still untouched while blocked");
assert.ok(iconLink.href.includes(encodeURIComponent("#ef4444")), "favicon should be red");
const blkOut = comp({ useSessions: (s) => s(listStore.value), useSessionPendingInteraction: (s) => s(pendingStore.value) });
assert.strictEqual(state(blkOut), "blocked");
assert.strictEqual(dot(blkOut), "blocked");

// ── 4. back to idle → green favicon again ─────────────────────────────────
pendingStore.set(new Map());
listStore.set({ ids: ["s1", "s2"], byId: { s1: { running: false }, s2: { running: false } } });
assert.strictEqual(fakeDoc.title, "DeepSeek Harness", "title still untouched back at idle");
assert.ok(iconLink.href.includes(encodeURIComponent("#22c55e")), "favicon should be green again");

// ── 5. no duplicate favicon writes on no-op state ─────────────────────────
let writes = 0;
iconLink._href = iconLink.href; // capture current value before installing accessor
Object.defineProperty(iconLink, "href", {
  get() { return iconLink._href; },
  set(v) { writes++; iconLink._href = v; },
  configurable: true,
});
const hrefBefore = iconLink._href;
listStore.set({ ids: ["s1"], byId: { s1: { running: false } } }); // still idle
assert.strictEqual(writes, 0, "no favicon rewrite when state is unchanged");
assert.strictEqual(iconLink._href, hrefBefore);

// ── 6. disposal restores original favicon, unsubscribes, title untouched ──
for (const c of effectCleanups.reverse()) c();
assert.strictEqual(fakeDoc.title, "DeepSeek Harness", "title was never modified");
assert.strictEqual(iconLink._href, "/favicon.ico", "original favicon restored on dispose");
assert.strictEqual(listStore._listeners.size, 0, "list subscription removed on dispose");
assert.strictEqual(pendingStore._listeners.size, 0, "pending subscription removed on dispose");

// ── 7. absent hooks edge (sidebar component) ──────────────────────────────
const absent = comp({});
assert.strictEqual(state(absent), "idle");

console.log("PASS 1/7 initial prime: green favicon, title untouched");
console.log("PASS 2/7 list change → yellow favicon, title untouched");
console.log("PASS 3/7 pending change → red favicon (overrides running), title untouched");
console.log("PASS 4/7 back to idle → green favicon restored");
console.log("PASS 5/7 no-op state changes do not re-write favicon");
console.log("PASS 6/7 dispose restores favicon, removes subscriptions, title intact");
console.log("PASS 7/7 sidebar component tolerates absent hooks");
console.log("ALL TAB-STATUS CHECKS PASSED");
