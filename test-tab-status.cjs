// Simulation test for dsh-session-status v0.4.1 (sidebar dot + two-mode tab
// favicon + dedicated Settings → 状态监控 section backed by the session-status
// settings namespace). Runs the REAL lib/client.js bundle in a VM with a fake
// document/window/react/stores plus a fake settingsScope + locale + remote.
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
function h(type, props, ...children) {
  if (props === null || props === undefined) props = {};
  if (children.length === 1) props.children = children[0];
  else if (children.length > 1) props.children = children;
  return { type, props };
}
// useSyncExternalStore stub: read the current snapshot without subscribing
// (the row is re-rendered by re-invoking the component; the favicon follows
// the effect's REAL scope subscription, not this stub).
const stubReact = {
  createElement: h,
  useSyncExternalStore: (sub, getSnap) => getSnap(),
};
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

// ── fake settingsScope (bound controller) ─────────────────────────────────
// Mirrors the real SettingsScopeController face the bundle uses:
// getSnapshot() -> { status, value, writable, revision }, subscribe(l), set(field, value).
function makeFakeScope(initialMode) {
  const listeners = new Set();
  let value = { iconMode: initialMode };
  let revision = 0;
  return {
    _listeners: listeners,
    getSnapshot: () => ({ status: "ready", value: { ...value }, writable: true, revision }),
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    set(field, v) { value = { ...value, [field]: v }; revision += 1; for (const l of [...listeners]) l(); },
  };
}
const fakeScope = makeFakeScope("replace");
const fakeSettingsScope = {
  bound: null,
  bind(spec) { this.bound = spec; return fakeScope; },
};
const registeredDictionaries = {};
const fakeLocale = {
  register(ns, dict) { registeredDictionaries[ns] = dict; return () => { delete registeredDictionaries[ns]; }; },
  bind(ns) {
    return (key) =>
      (registeredDictionaries[ns] && registeredDictionaries[ns].zh && registeredDictionaries[ns].zh[key]) || key;
  },
};

let effectCleanups = [];
const fakeCtx = {
  _injections: {},
  _registers: {},
  slots: {
    inject: (key, f) => { fakeCtx._injections[key] = f; },
    register: (options, comp) => { fakeCtx._registers[options.name] = { options, comp }; return comp; },
  },
  sessions: { list: listStore },
  uiSession: { pendingInteractions: pendingStore },
  locale: fakeLocale,
  logger: { warn: () => {} },
  get(name) {
    if (name === "settingsScope") return fakeSettingsScope;
    if (name === "locale") return fakeLocale;
    return void 0;
  },
  effect(fn, label) { const cleanup = fn(); effectCleanups.push(() => cleanup && cleanup()); },
};

exported.apply(fakeCtx);

// Resolve the two registered slots.
const sidebarComp = fakeCtx._injections["sidebar.footer.action"]();
const sidebarReg = fakeCtx._registers["sidebar.footer.action"];
const sectionComp = fakeCtx._injections["settings.section"]();
const sectionReg = fakeCtx._registers["settings.section"];
assert.strictEqual(fakeCtx._injections["settings.general.item"], undefined, "no leftover general.item registration");

assert.strictEqual(typeof sidebarComp, "function", "sidebar slot resolves to a component");
assert.strictEqual(typeof sectionComp, "function", "settings section slot resolves to a component");
assert.strictEqual(sidebarReg.options.id, "session-status");
assert.strictEqual(sectionReg.options.id, "session-status", "section has the plugin id");
assert.strictEqual(sectionReg.options.order, 20, "section ordered after plugins (15)");
assert.strictEqual(sectionReg.options.locale, "session-status.section", "section declares a locale namespace");
assert.strictEqual(typeof sectionReg.options.label, "function", "section provides a nav-label thunk");
assert.strictEqual(sectionReg.options.label(), "状态监控", "nav label resolves to 状态监控 (zh)");

// ── helpers ───────────────────────────────────────────────────────────────
const dot = (out) => out.props.children.find((n) => n.props && n.props.className === "dss_dot").props["data-state"];
const label = (out) => { const l = out.props.children.filter(Boolean).find((n) => n.props && n.props.className === "dss_label"); return l ? l.props.children : null; };
const state = (out) => out.props["data-dss-state"];
const sidebarProps = (wide) => ({ wide, useSessions: (s) => s(listStore.value), useSessionPendingInteraction: (s) => s(pendingStore.value) });
function decodedSvg(href) { return decodeURIComponent(href.slice("data:image/svg+xml,".length)); }
const t = (key) => registeredDictionaries[sectionReg.options.locale].zh[key];
function sectionProps() {
  // The framework hands the section its bound `t` plus the inject face's output.
  return Object.assign({ t }, sectionReg.options.inject());
}
// Render function components (the stub react only createElement's them).
function render(node) {
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") return render(node.type(node.props));
  return node;
}
function buttonOf(out, id) {
  // Walk the created element tree (expanding function components) for the
  // button whose key matches.
  const found = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "function") { walk(render(node)); return; }
    if (node.type === "button") found.push(node);
    const kids = node.props && node.props.children;
    if (Array.isArray(kids)) kids.forEach(walk);
    else if (kids) walk(kids);
  })(out);
  return found.find((b) => b.props["key"] === id);
}
function classNameOf(out, cls) {
  const found = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "function") { walk(render(node)); return; }
    if (node.props && node.props.className === cls) found.push(node);
    const kids = node.props && node.props.children;
    if (Array.isArray(kids)) kids.forEach(walk);
    else if (kids) walk(kids);
  })(out);
  return found;
}

// ── 1. initial prime: idle + replace → plain green dot favicon ───────────
assert.strictEqual(fakeDoc.title, "DeepSeek Harness", "title must stay untouched");
let svg = decodedSvg(iconLink.href);
assert.ok(svg.includes("fill=\"#22c55e\""), "initial favicon should be green");
assert.ok(!svg.includes("<path"), "replace mode must NOT embed the logo path");
const idleOut = sidebarComp(sidebarProps(true));
assert.strictEqual(state(idleOut), "idle");
assert.strictEqual(label(idleOut), "空闲", "wide sidebar shows the idle text");
assert.strictEqual(dot(idleOut), "idle");

// ── 2. list store change → running → yellow dot (replace) ─────────────────
listStore.set({ ids: ["s1", "s2"], byId: { s1: { running: true }, s2: { running: false } } });
assert.strictEqual(fakeDoc.title, "DeepSeek Harness", "title still untouched while running");
svg = decodedSvg(iconLink.href);
assert.ok(svg.includes("fill=\"#f59e0b\""), "favicon should be yellow");
assert.ok(!svg.includes("<path"), "replace mode stays logo-free");
const runOut = sidebarComp(sidebarProps(true));
assert.strictEqual(state(runOut), "running");
assert.strictEqual(label(runOut), "运行中（1）", "wide sidebar shows the running text with count");

// ── 3. pending store change → blocked → red dot (overrides running) ───────
pendingStore.set(new Map([["s1", { kind: "question" }], ["s2", { kind: "approval" }]]));
svg = decodedSvg(iconLink.href);
assert.ok(svg.includes("fill=\"#ef4444\""), "favicon should be red");
const blockedOut = sidebarComp(sidebarProps(true));
assert.strictEqual(state(blockedOut), "blocked");
assert.strictEqual(label(blockedOut), "需人工处理（2）", "wide sidebar shows the blocked text with count");
assert.strictEqual(blockedOut.props.title.length > 0, true, "detailed tooltip still present");

// ── 4. back to idle → green again ─────────────────────────────────────────
pendingStore.set(new Map());
listStore.set({ ids: ["s1", "s2"], byId: { s1: { running: false }, s2: { running: false } } });
svg = decodedSvg(iconLink.href);
assert.ok(svg.includes("fill=\"#22c55e\""), "favicon should be green again");
assert.strictEqual(label(sidebarComp(sidebarProps(true))), "空闲", "text back to idle");

// ── 5. no duplicate favicon writes on no-op state (replace) ───────────────
let writes = 0;
iconLink._href = iconLink.href;
Object.defineProperty(iconLink, "href", {
  get() { return iconLink._href; },
  set(v) { writes++; iconLink._href = v; },
  configurable: true,
});
const hrefBefore = iconLink._href;
listStore.set({ ids: ["s1"], byId: { s1: { running: false } } }); // still idle
assert.strictEqual(writes, 0, "no favicon rewrite when state is unchanged");
assert.strictEqual(iconLink._href, hrefBefore);

// ── 6. settings section renders with the bound scope; replace preselected ──
assert.ok(sectionReg.options.inject().tabIconScope === fakeScope, "section inject face carries the bound scope");
assert.strictEqual(fakeSettingsScope.bound.namespace, "session-status", "scope bound to the session-status namespace");
let sectionOut = sectionComp(sectionProps());
assert.strictEqual(sectionOut.props.className, "dss_section", "section content column wrapper");
assert.ok(classNameOf(sectionOut, "dss_headTitle").length === 1, "section header title present");
assert.strictEqual(classNameOf(sectionOut, "dss_headTitle")[0].props.children, "状态监控", "header shows 状态监控");
const replaceBtn = buttonOf(sectionOut, "replace");
const combinedBtn = buttonOf(sectionOut, "combined");
assert.ok(replaceBtn, "row renders a replace option");
assert.ok(combinedBtn, "row renders a combined option");
assert.strictEqual(replaceBtn.props["aria-pressed"], true, "replace preselected in replace mode");
assert.strictEqual(combinedBtn.props["aria-pressed"], false, "combined not selected in replace mode");
assert.strictEqual(replaceBtn.props.disabled, false, "row enabled while scope is ready");
assert.ok(replaceBtn.props.title && replaceBtn.props.title.length > 0, "options carry a hint title");

// ── 7. click "combined" → persisted write → composite favicon (logo + dot) ─
combinedBtn.props.onClick();
// scope.set notifies the effect's subscription → favicon re-applies in combined mode.
svg = decodedSvg(iconLink.href);
assert.ok(svg.includes("<path"), "combined mode embeds the original logo path");
assert.ok(svg.includes("dssl"), "combined mode marks the logo for light/dark fill");
assert.ok(svg.includes('fill="#fff"'), "combined mode adds a white ring behind the dot");
assert.ok(svg.includes("fill=\"#22c55e\""), "combined mode dot keeps the state color (idle/green)");
// The section re-renders with combined now selected (scope snapshot advanced).
sectionOut = sectionComp(sectionProps());
assert.strictEqual(buttonOf(sectionOut, "combined").props["aria-pressed"], true, "combined selected after click");
assert.strictEqual(buttonOf(sectionOut, "replace").props["aria-pressed"], false, "replace deselected after click");
assert.strictEqual(fakeScope.getSnapshot().value.iconMode, "combined", "write persisted to the scope document");

// ── 8. state change while in combined mode recolors the overlaid dot ──────
listStore.set({ ids: ["s1", "s2"], byId: { s1: { running: true }, s2: { running: false } } });
svg = decodedSvg(iconLink.href);
assert.ok(svg.includes("<path"), "logo still present in combined mode");
assert.ok(svg.includes("fill=\"#f59e0b\""), "combined dot recolors to running/yellow");

// ── 9. click back to "replace" → plain dot favicon restored ───────────────
sectionOut = sectionComp(sectionProps());
buttonOf(sectionOut, "replace").props.onClick();
svg = decodedSvg(iconLink.href);
assert.ok(!svg.includes("<path"), "replace mode drops the logo path");
assert.ok(svg.includes("fill=\"#f59e0b\""), "replace mode keeps the running/yellow color");
assert.strictEqual(fakeScope.getSnapshot().value.iconMode, "replace", "mode persisted back to replace");

// ── 9b. collapsed rail: no text label, compact pill (bare dot as before) ──
const collapsedOut = sidebarComp(sidebarProps(false));
assert.strictEqual(label(collapsedOut), null, "collapsed rail shows no text");
assert.ok(collapsedOut.props.className.includes("dss_rootCompact"), "collapsed rail uses the compact (no-padding) pill");
assert.strictEqual(dot(collapsedOut), "running", "dot still present in the collapsed rail");

// ── 10. dispose: restore favicon, drop list/pending/scope subscriptions ───
for (const c of effectCleanups.reverse()) c();
assert.strictEqual(fakeDoc.title, "DeepSeek Harness", "title was never modified");
assert.strictEqual(iconLink._href, "/favicon.ico", "original favicon restored on dispose");
assert.strictEqual(listStore._listeners.size, 0, "list subscription removed on dispose");
assert.strictEqual(pendingStore._listeners.size, 0, "pending subscription removed on dispose");
assert.strictEqual(fakeScope._listeners.size, 0, "settings scope subscription removed on dispose");

// ── 11. absent settings base degrades: no row, but dot + favicon still work ─
const scopelessCtx = {
  _injections: {},
  _registers: {},
  slots: { inject: (k, f) => { scopelessCtx._injections[k] = f; }, register: (o, c) => { scopelessCtx._registers[o.name] = { options: o, comp: c }; return c; } },
  sessions: { list: listStore },
  uiSession: { pendingInteractions: pendingStore },
  locale: fakeLocale,
  logger: { warn: () => {} },
  get: (name) => (name === "locale" ? fakeLocale : void 0), // no settingsScope
  effect(fn) { const cleanup = fn(); effectCleanups.push(() => cleanup && cleanup()); },
};
exported.apply(scopelessCtx);
// Owner resolves each declared slot by invoking its thunk (which registers).
if (scopelessCtx._injections["sidebar.footer.action"]) scopelessCtx._injections["sidebar.footer.action"]();
if (scopelessCtx._injections["settings.section"]) scopelessCtx._injections["settings.section"]();
assert.strictEqual(scopelessCtx._registers["settings.section"], undefined, "no settings section registered when the settings base is absent");
// The core indicator (sidebar dot + favicon) is still registered and functional.
assert.ok(scopelessCtx._registers["sidebar.footer.action"], "sidebar dot still registered without settings base");
const scopelessSidebar = scopelessCtx._injections["sidebar.footer.action"]();
assert.strictEqual(state(scopelessSidebar({ wide: true, useSessions: (s) => s(listStore.value), useSessionPendingInteraction: (s) => s(pendingStore.value) })), "running");
assert.ok(decodedSvg(iconLink.href).includes("fill=\"#f59e0b\""), "favicon still tracks state without settings base (replace default)");
// dispose the extra effect
for (const c of effectCleanups.reverse()) c();

console.log("PASS 1/11 initial prime: green plain-dot favicon (replace), title untouched");
console.log("PASS 2/11 list change → yellow plain dot (replace), title untouched, text 运行中（1）");
console.log("PASS 3/11 pending change → red plain dot (overrides running), text 需人工处理（2）");
console.log("PASS 4/11 back to idle → green plain dot restored, text 空闲");
console.log("PASS 5/11 no-op state changes do not re-write favicon");
console.log("PASS 6/11 settings section (状态监控) renders; header + row; replace preselected");
console.log("PASS 7/11 click combined → persisted write → composite favicon (logo + state dot)");
console.log("PASS 8/11 state change in combined mode recolors the overlaid dot");
console.log("PASS 9/11 click replace → plain-dot favicon restored, mode persisted");
console.log("PASS 10/11 dispose restores favicon and removes all subscriptions (incl. scope)");
console.log("PASS 11/11 absent settings base: no section, but dot + favicon still work");
console.log("ALL TAB-STATUS CHECKS PASSED (v0.4.1)");
