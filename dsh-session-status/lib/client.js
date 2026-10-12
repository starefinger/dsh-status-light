// dsh-session-status client bundle — module-table consumer for the web shell.
// Hand-authored CJS bundle (no esbuild/tsdown build step).
// Required module-table entries (browser baseline seeds): react
window.__ModuleLoader__.load({
  id: "dsh-session-status",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";
    var react = require("react");

    // Inject the plugin's CSS once at materialization (same pattern as the
    // shipped client-ui plugins). Colors use the DSW theme tokens with literal
    // fallbacks so they stay readable in both light and dark themes.
    var css = [
      ".dss_root{position:relative;gap:6px;max-width:100%;display:inline-flex;align-items:center;justify-content:center;height:20px;padding:0 8px;border-radius:10px}",
      ".dss_dot{width:10px;height:10px;border-radius:50%;flex:none;box-shadow:0 0 0 2px rgba(127,127,127,0.12);transition:background-color .18s ease-out,box-shadow .18s ease-out}",
      ".dss_dot[data-state=blocked]{background:var(--dsw-alias-state-error-primary,#ef4444);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 22%,transparent)}",
      ".dss_dot[data-state=running]{background:var(--dsw-alias-state-warn-primary,#f59e0b);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 22%,transparent)}",
      ".dss_dot[data-state=idle]{background:var(--dsw-alias-state-success-primary,#22c55e);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 18%,transparent)}",
      ".dss_root:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dss_rootCompact{padding:0}",
      ".dss_label{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:18px;min-width:0}",
      ".dss_row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}",
      ".dss_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}",
      ".dss_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}",
      ".dss_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}",
      ".dss_opts{align-items:center;gap:8px;display:inline-flex;flex:none}",
      ".dss_section{flex-direction:column;width:100%;display:flex}",
      ".dss_head{flex-direction:column;gap:2px;margin-bottom:6px;display:flex}",
      ".dss_headTitle{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}",
      ".dss_headIntro{color:var(--dsw-alias-label-tertiary);font-size:14px;font-weight:400;line-height:22px}",
      ".dss_opt{box-sizing:border-box;background:0 0;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;line-height:20px;border-radius:20px;align-items:center;gap:8px;padding:8px 14px;display:inline-flex;transition:background-color .15s ease-out,border-color .15s ease-out}",
      ".dss_opt:hover:not(.dss_optOn){background:var(--dsw-alias-interactive-bg-hover)}",
      ".dss_optOn{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400,#93c5fd)}",
      ".dss_opt[disabled]{opacity:.5;cursor:default}",
      ".dss_prev{width:22px;height:22px;flex:none;display:inline-block}",
      ".dss_switch{box-sizing:border-box;background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l4);width:44px;height:24px;border-radius:12px;position:relative;cursor:pointer;padding:0;flex:none;transition:background-color .15s ease-out,border-color .15s ease-out}",
      ".dss_switchOn{background:var(--dsw-static-neutral-bluish-400,#93c5fd);border-color:var(--dsw-static-neutral-bluish-400,#93c5fd)}",
      ".dss_switchKnob{background:var(--dsw-alias-label-primary);border-radius:50%;width:18px;height:18px;position:absolute;top:2px;left:2px;transition:transform .15s ease-out,background-color .15s ease-out}",
      ".dss_switchOn .dss_switchKnob{transform:translateX(20px);background:#fff}",
      ".dss_switch[disabled]{opacity:.5;cursor:default}"
    ].join("");
    var tagId = "dsh-session-status/StatusIndicator.css";
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-status";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ── shared state core (sidebar dot + tab favicon) ──────────────────────
    // Derive the traffic-light state from the two standard Session stores
    // (0.2.0 contract):
    //   sessions.list                    -> byId[sessionId].running (live agent bit)
    //   uiSession.sessionStatus          -> Map<sessionId, {running, pendingInteraction,
    //                                                  completionUnread}> (unified status)
    // blocked   = any session carrying a pendingInteraction (approval / question / plan-review)
    // running   = some session's agent is actively running
    //   state = blocked>0 ? red : running ? yellow : green
    function toState(blocked, running) {
      if (blocked > 0) return "blocked";
      if (running) return "running";
      return "idle";
    }
    function deriveState(list, statusMap) {
      var blocked = 0;
      if (statusMap) {
        statusMap.forEach(function (st) {
          if (st && st.pendingInteraction !== undefined) blocked += 1;
        });
      }
      var running = 0;
      var ids = list && list.ids ? list.ids : [];
      var byId = list ? list.byId : void 0;
      for (var i = 0; i < ids.length; i++) {
        var row = byId ? byId[ids[i]] : void 0;
        if (row && row.running) running++;
      }
      return { state: toState(blocked, running), blocked: blocked, running: running };
    }
    // Short label for the sidebar chip (12px) and the detailed tooltip.
    function labelFor(state, blocked, running) {
      if (state === "blocked") return "需人工处理" + (blocked ? "（" + blocked + "）" : "");
      if (state === "running") return "运行中" + (running ? "（" + running + "）" : "");
      return "空闲";
    }
    function titleFor(state, blocked, running) {
      if (state === "blocked") return "DSH 状态：需人工处理（" + blocked + " 个会话等待审批/回答）";
      if (state === "running") return "DSH 状态：有会话正在运行" + (running ? "（" + running + " 个）" : "");
      return "DSH 状态：空闲（无运行中，无待处理）";
    }

    // ── browser tab status: colored favicon (two display modes) ────────────
    // The web shell never writes document.title (index.html's <title> is
    // static), so the title is left untouched; the favicon alone carries the
    // state. Two modes (persisted in the `session-status` settings namespace):
    //   replace  — a solid colored dot only (the original icon is hidden);
    //   combined — the original DSH logo with the state dot overlaid at its
    //              bottom-right corner, as one inline SVG (the logo keeps its
    //              light/dark adaptive fill via prefers-color-scheme).
    var TAB_HUE = {
      blocked: "#ef4444",
      running: "#f59e0b",
      idle: "#22c55e"
    };
    // Original DSH favicon path (viewBox 0 0 50 50), inlined so the combined
    // mode needs no network request. Kept in sync with dsh-web-frontend's
    // dist/favicon.svg.
    var LOGO_PATH = "M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.1041 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.952C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z";
    function faviconFor(state, mode) {
      var c = TAB_HUE[state] || TAB_HUE.idle;
      var svg;
      if (mode === "combined") {
        // Logo (scaled 50→26 into the 32 box) + white-ringed state dot at the
        // bottom-right corner. The style tag keeps the logo's light/dark fill.
        svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\">" +
          "<style>@media (prefers-color-scheme: dark){.dssl{fill:#fff}}</style>" +
          "<g transform=\"scale(0.52)\"><path class=\"dssl\" d=\"" + LOGO_PATH + "\" fill=\"#000\"/></g>" +
          "<circle cx=\"24.5\" cy=\"24.5\" r=\"6\" fill=\"#fff\"/>" +
          "<circle cx=\"24.5\" cy=\"24.5\" r=\"4.6\" fill=\"" + c + "\"/></svg>";
      } else {
        svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\">" +
          "<circle cx=\"16\" cy=\"16\" r=\"12\" fill=\"" + c + "\"/></svg>";
      }
      return "data:image/svg+xml," + encodeURIComponent(svg);
    }
    function installTabStatus(doc) {
      // The web shell registers one <link rel="icon"> PER COLOR SCHEME
      // (media="(prefers-color-scheme: dark|light)"); the browser only honors
      // the link whose media matches the active scheme, so EVERY icon link
      // must carry the state icon — updating just the first match leaves the
      // other scheme showing the original favicon. Links are re-queried per
      // write (a pass with no links is a retry-able no-op: `applied` stays
      // null, so a later pass still applies); each element's original href is
      // captured once for restoration on dispose.
      var originals = new Map(); // icon link element -> original href attribute
      var applied = null;
      var iconLinks = function () {
        return Array.prototype.slice.call(
          doc.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]')
        );
      };
      var apply = function (state, mode) {
        var key = state + "/" + (mode === "combined" ? "combined" : "replace");
        if (applied === key) return;
        var list = iconLinks();
        if (list.length === 0) return;
        applied = key;
        var href = faviconFor(state, mode === "combined" ? "combined" : "replace");
        for (var i = 0; i < list.length; i++) {
          if (!originals.has(list[i])) {
            originals.set(list[i], list[i].getAttribute("href"));
          }
          list[i].href = href;
        }
      };
      var dispose = function () {
        applied = null;
        originals.forEach(function (href, link) {
          link.href = href == null ? "" : href;
        });
        originals.clear();
      };
      return { apply: apply, dispose: dispose };
    }

    // React component for the sidebar footer (root-scoped, always visible).
    // The shell passes `wide` (sidebar expanded, or mid-transition) to every
    // footer entry: show the state text as a chip when wide; in the 56px
    // collapsed rail keep the bare dot (the title tooltip still carries the
    // full state).
    function StatusIndicator(props) {
      // 0.2.0 standard kit: useSessions + useSessionStatus (the per-session
      // status map). Absent either degrades that part of the state.
      var useSessions = props.useSessions;
      var useSessionStatus = props.useSessionStatus;
      var wide = props.wide;
      var list = typeof useSessions === "function" ? useSessions(function (state) { return state; }) : void 0;
      var statusMap = typeof useSessionStatus === "function"
        ? useSessionStatus(function (snapshot) { return snapshot; })
        : void 0;
      var derived = deriveState(list, statusMap);
      var title = titleFor(derived.state, derived.blocked, derived.running);
      return react.createElement("span", {
        "className": "dss_root" + (wide ? "" : " dss_rootCompact"),
        "role": "status",
        "aria-label": title,
        "title": title,
        "data-dss-state": derived.state,
        "children": [
          react.createElement("span", { "className": "dss_dot", "data-state": derived.state }),
          wide ? react.createElement("span", {
            "className": "dss_label",
            "children": labelFor(derived.state, derived.blocked, derived.running)
          }) : null
        ]
      });
    }

    // ── Settings → 状态监控: dedicated section (nav rail entry) ────────────
    // Registered into `settings.section` — the same seat the shipped Models /
    // Plugins pages use — so the shell's nav rail picks the page up with zero
    // shell changes (a section id without a dedicated glyph falls back to the
    // gear icon). The value lives in the `session-status` settings namespace
    // (persisted by the host settings service); the row reads the bound scope
    // with useSyncExternalStore so the selection follows the persisted
    // document, never the click echo.
    var SETTINGS_NS = "session-status";
    var SETTINGS_SECTION_NS = "session-status.section";
    var MODES = ["replace", "combined"];
    function modeValue(scope) {
      if (!scope) return "replace";
      var snap = scope.getSnapshot ? scope.getSnapshot() : void 0;
      var value = snap && snap.value && snap.value.iconMode;
      return MODES.indexOf(value) !== -1 ? value : "replace";
    }
    // `bridgeEnabled` is a top-level boolean in the same namespace (the
    // client scope writes single-level fields, so it is NOT nested).
    function bridgeValue(scope) {
      if (!scope || !scope.getSnapshot) return true;
      var snap = scope.getSnapshot();
      var v = snap && snap.value ? snap.value.bridgeEnabled : void 0;
      return v === false ? false : true;
    }
    // One string key per scope generation: "<status>:<mode>". A primitive
    // keeps useSyncExternalStore's equality check stable while still
    // re-rendering on a status transition (loading → ready) that carries no
    // value change.
    function scopeKey(scope) {
      if (!scope || !scope.getSnapshot) return "none:replace:on";
      var snap = scope.getSnapshot();
      var status = snap && snap.status ? snap.status : "none";
      return status + ":" + modeValue(scope) + ":" + (bridgeValue(scope) ? "on" : "off");
    }
    function TabIconRow(props) {
      var t = props.t;
      var scope = props.tabIconScope;
      var key = react.useSyncExternalStore(
        function (cb) { return scope && scope.subscribe ? scope.subscribe(cb) : function () {}; },
        function () { return scopeKey(scope); },
        function () { return "none:replace"; }
      );
      var parts = key.split(":");
      var available = parts[0] === "ready";
      var mode = parts[1];
      function opt(id, label, hint) {
        var on = mode === id;
        return react.createElement("button", {
          "key": id,
          "type": "button",
          "className": "dss_opt" + (on ? " dss_optOn" : ""),
          "aria-pressed": on,
          "disabled": !available,
          "title": hint,
          "onClick": function () {
            if (!available || mode === id) return;
            scope.set("iconMode", id);
          },
          "children": [
            react.createElement("img", {
              "className": "dss_prev",
              "alt": "",
              "src": faviconFor("running", id)
            }),
            label
          ]
        });
      }
      return react.createElement("div", { "className": "dss_row" },
        react.createElement("div", { "className": "dss_rowText" },
          react.createElement("div", { "className": "dss_title" }, t("label"))
        ),
        react.createElement("div", { "className": "dss_opts" },
          opt("replace", t("replace"), t("replaceHint")),
          opt("combined", t("combined"), t("combinedHint"))
        )
      );
    }

    // 桌面状态桥 toggle row: a single on/off switch on the top-level
    // `bridgeEnabled` field. The switch reflects the persisted value
    // (scope-driven, via the shared scopeKey), never the click echo.
    function BridgeRow(props) {
      var t = props.t;
      var scope = props.tabIconScope;
      var key = react.useSyncExternalStore(
        function (cb) { return scope && scope.subscribe ? scope.subscribe(cb) : function () {}; },
        function () { return scopeKey(scope); },
        function () { return "none:replace:on"; }
      );
      var parts = key.split(":");
      var available = parts[0] === "ready";
      var on = parts[2] === "on";
      return react.createElement("div", { "className": "dss_row" },
        react.createElement("div", { "className": "dss_rowText" },
          react.createElement("div", { "className": "dss_title" }, t("bridgeLabel")),
          react.createElement("div", { "className": "dss_desc" }, t("bridgeDesc"))
        ),
        react.createElement("button", {
          "type": "button",
          "role": "switch",
          "aria-checked": on,
          "aria-label": t("bridgeLabel"),
          "title": t("bridgeHint"),
          "className": "dss_switch" + (on ? " dss_switchOn" : ""),
          "disabled": !available,
          "onClick": function () {
            if (!available) return;
            scope.set("bridgeEnabled", !on);
          },
          "children": react.createElement("span", { "className": "dss_switchKnob" })
        })
      );
    }

    // The 状态监控 section content column: a header (page title + intro) plus
    // the tab-icon mode row. Mirrors the shipped General/Models sections — a
    // plain column div; the single row is rendered directly (no nested child
    // slot needed for one row).
    function StatusSection(props) {
      var t = props.t;
      var scope = props.tabIconScope;
      return react.createElement("div", { "className": "dss_section" },
        react.createElement("div", { "className": "dss_head" },
          react.createElement("div", { "className": "dss_headTitle" }, t("sectionTitle")),
          react.createElement("div", { "className": "dss_headIntro" }, t("sectionIntro"))
        ),
        react.createElement(TabIconRow, { t: t, tabIconScope: scope }),
        react.createElement(BridgeRow, { t: t, tabIconScope: scope })
      );
    }

    // Client plugin body: register the sidebar dot, the tab status, and the
    // settings section.
    // Service gate: the three 0.2.0 services (slots/sessions/uiSession) keep
    // the indicator alive in every web composition. The settings surface is
    // layered ON with soft access — `ctx.get(...)` is the facade's optional
    // lookup (no declaration required, and — unlike a `ctx.name` property read
    // — it returns undefined instead of throwing for an undeclared service),
    // so a composition without the settings or locale base still gets the full
    // dot + favicon, just without the row. `configForms.get(entryId)` returns
    // the owning plugin's projected Config form; its getSnapshot/subscribe/set
    // mirror the pre-0.2.0 settings-scope face 1:1.
    var inject = ["slots", "sessions", "uiSession"];
    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register(
          { name: "sidebar.footer.action", id: "session-status", order: 100 },
          StatusIndicator
        );
      });
      // Optional settings surface: the 0.2.0 preferences live in the OWNING
      // plugin's Config; the shared configForms service projects them into a
      // per-entry form (getSnapshot/subscribe/set — the same external-store
      // face the pre-0.2.0 settingsScope had). The row + form-following
      // favicon mode are registered only when BOTH the locale and
      // config-forms services are present.
      var form = null;
      var locale = null;
      try {
        locale = ctx.get ? ctx.get("locale") : void 0;
        var configForms = ctx.get ? ctx.get("configForms") : void 0;
        if (configForms && configForms.get) {
          form = configForms.get(SETTINGS_NS);
        }
      } catch (error) {
        form = null;
        locale = null;
      }
      function readMode() {
        return modeValue(form);
      }
      // Tab status: subscribe to the SAME two standard stores the sidebar dot
      // reads, plus the settings scope, so both stay in lockstep. The effect
      // cleans up the subscriptions and restores the original favicon on
      // plugin disposal or an HMR swap.
      ctx.effect(function () {
        var tab = installTabStatus(document);
        var read = function () {
          return deriveState(
            ctx.sessions.list.getSnapshot(),
            ctx.uiSession.sessionStatus.getSnapshot()
          ).state;
        };
        var disposeList = ctx.sessions.list.subscribe(function () {
          tab.apply(read(), readMode());
        });
        var disposeStatus = ctx.uiSession.sessionStatus.subscribe(function () {
          tab.apply(read(), readMode());
        });
        var disposeForm = form && form.subscribe
          ? form.subscribe(function () {
            tab.apply(read(), readMode());
          })
          : null;
        tab.apply(read(), readMode());
        return function () {
          disposeList();
          disposeStatus();
          if (disposeForm) disposeForm();
          tab.dispose();
        };
      }, "dsh-session-status: browser tab status");
      // Settings → 状态监控: dictionaries + the section entry. Registered
      // only when the config form is bound (the settings base is mounted);
      // the section's `locale` seat hands StatusSection a bound `t`, and its
      // `label` thunk feeds the nav rail (re-evaluated per read, so the nav
      // row follows the active locale without re-registration).
      if (form && locale && locale.register) {
        // One dictionary namespace feeds BOTH the nav label and the section
        // body (the section entry's `locale` seat hands the component a bound
        // `t`; the row reads the same keys), matching the shipped sections.
        ctx.effect(function () {
          return locale.register(SETTINGS_SECTION_NS, {
            zh: {
              "nav": "状态监控",
              "sectionTitle": "状态监控",
              "sectionIntro": "红/黄/绿全局状态在浏览器标签页 favicon 上的显示方式（红＝需人工处理，黄＝运行中，绿＝空闲）",
              "label": "标签页图标",
              "replace": "代替原图标",
              "combined": "与原图标共存",
              "replaceHint": "仅显示状态圆点，隐藏原图标",
              "combinedHint": "保留原图标，右下角叠加状态圆点",
              "bridgeLabel": "桌面状态桥",
              "bridgeDesc": "在正在运行的 web 服务器上挂载只读端点 /session-status，供桌面托盘工具读取红/黄/绿状态（不新增端口）",
              "bridgeHint": "关闭后移除该端点（需重启 dsh web 或热重载后生效）"
            },
            en: {
              "nav": "Status monitoring",
              "sectionTitle": "Status monitoring",
              "sectionIntro": "How the global red/yellow/green state shows in the browser tab favicon (red = human input needed, yellow = running, green = idle)",
              "label": "Tab favicon",
              "replace": "Replace the original icon",
              "combined": "Keep the original icon",
              "replaceHint": "Show the status dot only and hide the original icon",
              "combinedHint": "Keep the original icon with the status dot overlaid",
              "bridgeLabel": "Desktop status bridge",
              "bridgeDesc": "Mounts a read-only /session-status endpoint on the running web server so a desktop tray tool can read the red/yellow/green state (no new port)",
              "bridgeHint": "Turning this off removes the endpoint (applies on hot reload)"
            }
          });
        }, "dsh-session-status: settings section dictionaries");
        var tNav = locale.bind ? locale.bind(SETTINGS_SECTION_NS) : function (k) { return k; };
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register(
            {
              name: "settings.section",
              id: "session-status",
              order: 20,
              label: function () { return tNav("nav"); },
              locale: SETTINGS_SECTION_NS,
              inject: function () {
                return { tabIconScope: form };
              }
            },
            StatusSection
          );
        });
      }
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

//# sourceMappingURL=client.js.map
