/**
 * dsh-session-status — host half.
 *
 * Registers the `session-status` user-settings namespace so the browser
 * tab-icon preference persists in the DSH settings document
 * (`$DSH_HOME/settings.yaml`, hot-reloaded by the settings-file provider).
 * The browser half binds the same namespace through `ctx.settingsScope` and
 * renders a "Tab favicon" row in the Settings panel's General section.
 *
 * Schema strategy (zero dependencies): the settings service only ever
 * (a) CALLS `schema(data)` to resolve a candidate value, (b) publishes
 * `schema.toJSON()` as the serialized envelope the browser rehydrates with
 * ITS OWN bundled schemastery copy, and (c) walks `type` / `dict` /
 * `inner` / `meta.role` for secret redaction. So we keep a tiny hand-rolled
 * live node whose `toJSON()` returns a FROZEN envelope captured once from
 * the real schemastery (`object({ iconMode: union([const, const]).default()
 * }).toJSON()`) — the published qwen-local plugin freezes its envelope for
 * exactly this reason, which lets this plugin carry no schemastery import.
 */

const NS = "session-status";
const MODES = ["replace", "combined"];
const DEFAULT_MODE = "replace";

/**
 * Frozen schemastery wire envelope for the `session-status` namespace.
 * Generated from `Schema.object({ iconMode: Schema.union([
 *   Schema.const("replace"), Schema.const("combined")
 * ]).default("replace") }).toJSON()` — do not hand-edit the uids.
 * @type {Readonly<{uid: number, refs: Record<string, object>}>}
 */
const ENVELOPE = {
  uid: 4,
  refs: {
    0: { type: "const", meta: {}, value: "replace" },
    1: { type: "const", meta: {}, value: "combined" },
    3: { type: "union", meta: { default: DEFAULT_MODE }, list: [0, 1] },
    4: { type: "object", meta: { default: {} }, dict: { iconMode: 3 } },
  },
};

/**
 * Resolve one candidate section, mirroring the schemastery schema's semantics:
 * `iconMode` defaults to `"replace"` and must be one of `MODES`.
 * @param data - raw candidate (user layer merged over base by the service).
 * @returns resolved section, always `{ iconMode }`.
 */
function resolveSection(data) {
  const raw = data !== null && typeof data === "object" ? data.iconMode : void 0;
  if (raw !== undefined && MODES.indexOf(raw) === -1) {
    throw new TypeError(
      `settings namespace "${NS}": $.iconMode expected "replace" | "combined" but got ${JSON.stringify(raw)}`
    );
  }
  return { iconMode: raw === undefined ? DEFAULT_MODE : raw };
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
  },
  meta: { default: { iconMode: DEFAULT_MODE } },
  toJSON: () => JSON.parse(JSON.stringify(ENVELOPE)),
});

/**
 * Host registration. `settings` is an optional composition service (mounted by
 * `dsh-settings-file` in the web profile); when no settings provider is
 * composed the thunk never runs, the namespace stays unregistered, and the
 * browser falls back to the schema default (replace mode, non-persistent).
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx) {
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.register(NS, StatusSchema);
  });
}

export { DEFAULT_MODE, MODES, NS as SETTINGS_NAMESPACE, StatusSchema };
