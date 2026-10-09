# dsh-session-status — desktop companions

Home for the **desktop** companions of the [`dsh-session-status`](../dsh-session-status/)
web plugin. Each subfolder is one **implementation** of the same little system-tray
light (🔴 blocked / 🟡 running / 🟢 idle, ⚪ when the bridge is unreachable) that
mirrors the browser indicator — kept here, outside the plugin, so new versions
(Electron, Tauri, Go, …) can live side by side.

Every version reads the same **read-only HTTP bridge** the plugin's host half
mounts on the already-running web server (no new port):

```
GET /session-status         → one JSON snapshot
GET /session-status/stream  → SSE: a frame per change, 15 s keepalive
```

The bridge itself — its data sources, safety gates, and the
**Settings → 状态监控 → 桌面状态桥** toggle — is documented in the plugin:
[`../dsh-session-status/README.md`](../dsh-session-status/README.md#desktop-status-bridge-v050)
(中文: [`README.zh.md`](../dsh-session-status/README.zh.md#桌面状态桥v050)).

## Versions

| Folder | Stack | Status |
| --- | --- | --- |
| [`desktop-python/`](desktop-python/) | Python 3.9+ · pystray + Pillow | ✅ current — single `status_tray.py`, streams the SSE endpoint |

> Adding a new version: drop a `desktop-<name>/` folder with its own
> `README` (how to build & run) and a one-row entry in the table above. The
> only contract is the two read-only endpoints above.
