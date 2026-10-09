# dsh-session-status — desktop tray tool

A tiny system-tray light for Windows / Linux / macOS that mirrors the DSH
browser indicator's global **red / yellow / green** state. It talks to the
DSH web server you are **already** running — **no new port, no socket** — by
reading the read-only bridge endpoint the plugin mounts:

```
GET /session-status         → one JSON snapshot
GET /session-status/stream  → SSE: a frame per change, 15 s keepalive
```

## States

| tray color | state    | meaning                                          |
| ---------- | -------- | ------------------------------------------------ |
| 🔴 red     | `blocked`| 需人工处理 — an approval / question / plan review is waiting on a human |
| 🟡 yellow  | `running`| 运行中 — at least one agent is working          |
| 🟢 green   | `idle`   | 空闲 — nothing pending, nothing running          |
| ⚪ gray     | `unknown`| 无法连接 — the web server / bridge is unreachable |

Precedence is `blocked > running > idle`, the same rule the browser uses.
Gray is a transport-level fallback (server down, or the bridge disabled in
**Settings → 状态监控 → 桌面状态桥**).

## Install

```powershell
# from this folder (Python 3.9+)
pip install -r requirements.txt
```

`requirements.txt` is only **pystray** + **Pillow**. The fetch/parse core
uses the standard library, so `--once` works without them.

## Run

```powershell
python status_tray.py                 # tray icon (default)
python status_tray.py --widget        # always-on-top corner pill (tkinter)
python status_tray.py --host 127.0.0.1 --port 3080
python status_tray.py --poll          # poll the snapshot endpoint instead of SSE
python status_tray.py --once          # print one snapshot as JSON, then exit
```

### Tray mode (default)

Right-click the tray icon for **刷新 / Refresh** and **退出 / Quit**. The
status line under the icon shows the state plus the blocked / running
counts (and the running agent ids). On Windows the icon may start in the
hidden-icons overflow (the `^` chevron by the clock).

### Widget mode (`--widget`)

A small frameless **pill docked to the bottom-right corner that stays above
every other window** (`-topmost` → `WS_EX_TOPMOST`). Built with **tkinter —
part of the Python standard library, zero extra dependencies**. Double-click
toggles pin/unpin; right-click gives **固定在最前 / 退出**. The pill is
persistent (no hide mode) so the status is always visible; quit from the
right-click menu to remove it. Both modes share the same SSE client, so
transport, keepalive, and the gray-unreachable fallback behave identically.

## How it connects

The tool opens a single SSE connection to `/session-status/stream`. Each
`data:` frame is a JSON snapshot:

```json
{ "state": "running", "blocked": 0, "running": 2, "runningIds": ["a","b"], "ts": 1 }
```

The icon recolors on each frame. If the stream can't be opened (or the
bridge is off), it falls back to polling `/session-status` every
`--poll` interval; after two consecutive failures it goes gray and keeps
retrying with backoff.

> The bridge is served by the **host** half of the plugin, which loads once
> when `dsh web` starts. If you enable/disable the bridge in Settings, the
> change applies on the next web (re)start.

## Files

- `status_tray.py` — the tool (tray + stdlib HTTP/SSE client).
- `icons/{red,yellow,green,gray}.png` — the four 64×64 tray icons.
- `make_icons.py` — regenerates the icons (pure stdlib, no Pillow needed).
- `requirements.txt` — runtime dependencies (pystray, Pillow — tray mode
  only; `--widget` and `--once` work with the standard library alone).
