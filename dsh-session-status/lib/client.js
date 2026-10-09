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

    // Derive the traffic-light state from the two standard Session hooks:
    //   useSessions                      -> byId[sessionId].running (live agent bit)
    //   useSessionPendingInteraction     -> Map<sessionId, interaction> (needs a human)
    // blocked   = any session awaiting human input (approval / question / plan-review)
    // running   = some session's agent is actively running
    //   state = blocked>0 ? red : running ? yellow : green
    function toState(blocked, running) {
      if (blocked > 0) return "blocked";
      if (running) return "running";
      return "idle";
    }
    function titleFor(state, blocked, running) {
      if (state === "blocked") return "DSH 状态：需人工处理（" + blocked + " 个会话等待审批/回答）";
      if (state === "running") return "DSH 状态：有会话正在运行" + (running ? "（" + running + " 个）" : "");
      return "DSH 状态：空闲（无运行中，无待处理）";
    }
    function StatusIndicator(props) {
      var useSessions = props.useSessions;
      var useSessionPendingInteraction = props.useSessionPendingInteraction;
      var list = typeof useSessions === "function" ? useSessions(function (state) { return state; }) : void 0;
      var pending = typeof useSessionPendingInteraction === "function"
        ? useSessionPendingInteraction(function (snapshot) { return snapshot; })
        : void 0;
      var blocked = pending ? pending.size : 0;
      var running = 0;
      var ids = list && list.ids ? list.ids : [];
      var byId = list ? list.byId : void 0;
      for (var i = 0; i < ids.length; i++) {
        var row = byId ? byId[ids[i]] : void 0;
        if (row && row.running) running++;
      }
      var state = toState(blocked, running);
      var title = titleFor(state, blocked, running);
      return react.createElement("span", {
        "className": "dss_root",
        "role": "status",
        "aria-label": title,
        "title": title,
        "data-dss-state": state,
        "children": react.createElement("span", { "className": "dss_dot", "data-state": state })
      });
    }

    // Client plugin body: register the indicator into the sidebar footer
    // (a root-scoped, always-visible list slot that receives both hooks).
    var inject = ["slots"];
    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register(
          { name: "sidebar.footer.action", id: "session-status", order: 100 },
          StatusIndicator
        );
      });
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

//# sourceMappingURL=client.js.map
