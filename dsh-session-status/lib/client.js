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
      ".dss_root{position:relative;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:none}",
      ".dss_dot{width:10px;height:10px;border-radius:50%;flex:none;box-shadow:0 0 0 2px rgba(127,127,127,0.12);transition:background-color .18s ease-out,box-shadow .18s ease-out}",
      ".dss_dot[data-state=blocked]{background:var(--dsw-alias-state-error-primary,#ef4444);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 22%,transparent)}",
      ".dss_dot[data-state=running]{background:var(--dsw-alias-state-warn-primary,#f59e0b);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 22%,transparent)}",
      ".dss_dot[data-state=idle]{background:var(--dsw-alias-state-success-primary,#22c55e);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 18%,transparent)}",
      ".dss_row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}",
      ".dss_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}",
      ".dss_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}",
      ".dss_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}",
      ".dss_opts{align-items:center;gap:8px;display:inline-flex;flex:none}",
      ".dss_opt{box-sizing:border-box;background:0 0;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;line-height:20px;border-radius:20px;align-items:center;gap:8px;padding:8px 14px;display:inline-flex;transition:background-color .15s ease-out,border-color .15s ease-out}",
      ".dss_opt:hover:not(.dss_optOn){background:var(--dsw-alias-interactive-bg-hover)}",
      ".dss_optOn{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400,#93c5fd)}",
      ".dss_opt[disabled]{opacity:.5;cursor:default}",
      ".dss_prev{width:22px;height:22px;flex:none;display:inline-block}"
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
    // Derive the traffic-light state from the two standard Session stores:
    //   sessions.list                    -> byId[sessionId].running (live agent bit)
    //   uiSession.pendingInteractions    -> Map<sessionId, interaction> (needs a human)
    // blocked   = any session awaiting human input (approval / question / plan-review)
    // running   = some session's agent is actively running
    //   state = blocked>0 ? red : running ? yellow : green
    function toState(blocked, running) {
      if (blocked > 0) return "blocked";
      if (running) return "running";
      return "idle";
    }
    function deriveState(list, pending) {
      var blocked = pending ? pending.size : 0;
      var running = 0;
      var ids = list && list.ids ? list.ids : [];
      var byId = list ? list.byId : void 0;
      for (var i = 0; i < ids.length; i++) {
        var row = byId ? byId[ids[i]] : void 0;
        if (row && row.running) running++;
      }
      return { state: toState(blocked, running), blocked: blocked, running: running };
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
      var link = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
      var originalHref = link ? link.getAttribute("href") : null;
      var applied = null;
      var apply = function (state, mode) {
        var key = state + "/" + (mode === "combined" ? "combined" : "replace");
        if (applied === key || !link) return;
        applied = key;
        link.href = faviconFor(state, mode === "combined" ? "combined" : "replace");
      };
      var dispose = function () {
        if (applied === null || !link) return;
        applied = null;
        link.href = originalHref == null ? "" : originalHref;
      };
      return { apply: apply, dispose: dispose };
    }

    // React component for the sidebar footer (root-scoped, always visible).
    function StatusIndicator(props) {
      var useSessions = props.useSessions;
      var useSessionPendingInteraction = props.useSessionPendingInteraction;
      var list = typeof useSessions === "function" ? useSessions(function (state) { return state; }) : void 0;
      var pending = typeof useSessionPendingInteraction === "function"
        ? useSessionPendingInteraction(function (snapshot) { return snapshot; })
        : void 0;
      var derived = deriveState(list, pending);
      var title = titleFor(derived.state, derived.blocked, derived.running);
      return react.createElement("span", {
        "className": "dss_root",
        "role": "status",
        "aria-label": title,
        "title": title,
        "data-dss-state": derived.state,
        "children": react.createElement("span", { "className": "dss_dot", "data-state": derived.state })
      });
    }

    // ── Settings → General: tab-icon mode row ──────────────────────────────
    // Registered into `settings.general.item` (the same seat as the shipped
    // Appearance / font-size rows). The value lives in the `session-status`
    // settings namespace (persisted by the host settings service); the row
    // reads the bound scope with useSyncExternalStore so the selection follows
    // the persisted document, never the click echo.
    var SETTINGS_NS = "session-status";
    var SETTINGS_ROW_NS = "session-status.tabIcon";
    var MODES = ["replace", "combined"];
    function modeValue(scope) {
      if (!scope) return "replace";
      var snap = scope.getSnapshot ? scope.getSnapshot() : void 0;
      var value = snap && snap.value && snap.value.iconMode;
      return MODES.indexOf(value) !== -1 ? value : "replace";
    }
    // One string key per scope generation: "<status>:<mode>". A primitive
    // keeps useSyncExternalStore's equality check stable while still
    // re-rendering on a status transition (loading → ready) that carries no
    // value change.
    function scopeKey(scope) {
      if (!scope || !scope.getSnapshot) return "none:replace";
      var snap = scope.getSnapshot();
      var status = snap && snap.status ? snap.status : "none";
      return status + ":" + modeValue(scope);
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
          react.createElement("div", { "className": "dss_title" }, t("title")),
          react.createElement("div", { "className": "dss_desc" }, t("description"))
        ),
        react.createElement("div", { "className": "dss_opts" },
          opt("replace", t("replace"), t("replaceHint")),
          opt("combined", t("combined"), t("combinedHint"))
        )
      );
    }

    // Client plugin body: register the sidebar dot, the tab status, and the
    // settings row.
    // Service gate: the three v0.2.x services keep the indicator alive in every
    // web composition. The settings surface is layered ON with soft access —
    // `ctx.get(...)` is the facade's optional lookup (no declaration required,
    // and — unlike a `ctx.name` property read — it returns undefined instead of
    // throwing for an undeclared service), so a composition without the settings
    // or locale base still gets the full dot + favicon, just without the row.
    // `bind()` on the traceable proxy returned by `ctx.get("settingsScope")`
    // still binds the scope's effects to THIS plugin's fiber (the proxy binds
    // `this.ctx` to the caller at call time), matching the shipped theme row.
    var inject = ["slots", "sessions", "uiSession"];
    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register(
          { name: "sidebar.footer.action", id: "session-status", order: 100 },
          StatusIndicator
        );
      });
      // Optional settings surface: bind the `session-status` namespace scope
      // when the settings base is mounted; the row + scope-following favicon
      // mode are registered only when BOTH the locale and settings services
      // are present.
      var scope = null;
      var locale = null;
      try {
        locale = ctx.get ? ctx.get("locale") : void 0;
        var settingsScope = ctx.get ? ctx.get("settingsScope") : void 0;
        if (settingsScope && settingsScope.bind) {
          scope = settingsScope.bind({ namespace: SETTINGS_NS });
        }
      } catch (error) {
        scope = null;
        locale = null;
      }
      function readMode() {
        return modeValue(scope);
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
            ctx.uiSession.pendingInteractions.getSnapshot()
          ).state;
        };
        var disposeList = ctx.sessions.list.subscribe(function () {
          tab.apply(read(), readMode());
        });
        var disposePending = ctx.uiSession.pendingInteractions.subscribe(function () {
          tab.apply(read(), readMode());
        });
        var disposeScope = scope && scope.subscribe
          ? scope.subscribe(function () {
            tab.apply(read(), readMode());
          })
          : null;
        tab.apply(read(), readMode());
        return function () {
          disposeList();
          disposePending();
          if (disposeScope) disposeScope();
          tab.dispose();
        };
      }, "dsh-session-status: browser tab status");
      // Settings → General row: dictionaries + slot entry. Registered only when
      // the settings scope is bound (the settings base is mounted); the entry's
      // `locale` seat hands the row a bound `t`, matching the shipped rows.
      if (scope && locale && locale.register) {
        ctx.effect(function () {
          return locale.register(SETTINGS_ROW_NS, {
            zh: {
              "title": "标签页图标",
              "description": "浏览器标签页 favicon 的显示方式（红＝需人工处理，黄＝运行中，绿＝空闲）",
              "replace": "代替原图标",
              "combined": "与原图标共存",
              "replaceHint": "仅显示状态圆点，隐藏原图标",
              "combinedHint": "保留原图标，右下角叠加状态圆点"
            },
            en: {
              "title": "Tab favicon",
              "description": "How the browser tab favicon shows the global state (red = human input needed, yellow = running, green = idle)",
              "replace": "Replace the original icon",
              "combined": "Keep the original icon",
              "replaceHint": "Show the status dot only and hide the original icon",
              "combinedHint": "Keep the original icon with the status dot overlaid"
            }
          });
        }, "dsh-session-status: settings row dictionaries");
        ctx.slots.inject("settings.general.item", function () {
          return ctx.slots.register(
            {
              name: "settings.general.item",
              id: "session-status",
              order: 20,
              locale: SETTINGS_ROW_NS,
              inject: function () {
                return { tabIconScope: scope };
              }
            },
            TabIconRow
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
