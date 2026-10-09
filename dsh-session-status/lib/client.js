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
      ".dss_dot[data-state=idle]{background:var(--dsw-alias-state-success-primary,#22c55e);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 18%,transparent)}"
    ].join("");
    var tagId = "dsh-session-status/StatusIndicator.css";
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-session-status";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ── shared state core (sidebar dot + tab title/favicon) ───────────────
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

    // ── browser tab status: emoji-prefixed title + colored favicon ─────────
    // The web shell never writes document.title (index.html's <title> is
    // static), so the plugin owns it exclusively. Each browser tab updates its
    // own title independently; the disposer restores the original title and
    // icon link on plugin disposal / HMR swap.
    var TAB_MARK = {
      blocked: "🔴 ",
      running: "🟡 ",
      idle: "🟢 "
    };
    var TAB_HUE = {
      blocked: "#ef4444",
      running: "#f59e0b",
      idle: "#22c55e"
    };
    function faviconFor(state) {
      // Solid colored dot as an inline SVG data URI — no network, no build.
      var c = TAB_HUE[state] || TAB_HUE.idle;
      var svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\">" +
        "<circle cx=\"16\" cy=\"16\" r=\"12\" fill=\"" + c + "\"/></svg>";
      return "data:image/svg+xml," + encodeURIComponent(svg);
    }
    function installTabStatus(doc) {
      var link = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
      var originalHref = link ? link.getAttribute("href") : null;
      var originalTitle = doc.title || "DeepSeek Harness";
      var applied = null;
      var apply = function (state) {
        if (applied === state) return;
        applied = state;
        doc.title = (TAB_MARK[state] || TAB_MARK.idle) + originalTitle;
        if (link) link.href = faviconFor(state);
      };
      var dispose = function () {
        if (applied === null) return;
        applied = null;
        doc.title = originalTitle;
        if (link) link.href = originalHref == null ? "" : originalHref;
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

    // Client plugin body: register the sidebar dot and the tab status.
    var inject = ["slots", "sessions", "uiSession"];
    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register(
          { name: "sidebar.footer.action", id: "session-status", order: 100 },
          StatusIndicator
        );
      });
      // Tab status: subscribe to the SAME two standard stores the sidebar dot
      // reads, so both stay in lockstep. The effect cleans up the
      // subscriptions and restores the original title/favicon on plugin
      // disposal or an HMR swap.
      ctx.effect(function () {
        var tab = installTabStatus(document);
        var read = function () {
          return deriveState(
            ctx.sessions.list.getSnapshot(),
            ctx.uiSession.pendingInteractions.getSnapshot()
          ).state;
        };
        var disposeList = ctx.sessions.list.subscribe(function () {
          tab.apply(read());
        });
        var disposePending = ctx.uiSession.pendingInteractions.subscribe(function () {
          tab.apply(read());
        });
        tab.apply(read());
        return function () {
          disposeList();
          disposePending();
          tab.dispose();
        };
      }, "dsh-session-status: browser tab status");
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

//# sourceMappingURL=client.js.map
