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
python status_tray.py                 # tray icon only (default)
python status_tray.py --widget        # always-on-top pill + tray icon (tkinter + pystray)
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

A small frameless **pill that floats above every other window**
(`-topmost` → `WS_EX_TOPMOST`). Built with **tkinter — part of the Python
standard library, zero extra dependencies**. It opens docked to the
bottom-right corner; everything else is user-adjustable:

| 调整 | 操作 |
| --- | --- |
| **位置** | 按住药丸任意处拖动 |
| **大小** | 拖动**右下角的两条斜线手柄**(范围 120×30 … 720×240) |
| **最前** | 双击切换,或**右键菜单 `固定在最前 / 取消置顶` 可直接点选切换** |
| **复位** | 右键菜单 `重置位置与大小 / Reset` |
| **退出** | 右键菜单 `退出 / Quit` |

**`--widget` 模式总是同时显示药丸 + 托盘图标**(同一个 SSE 客户端
喂两个视图,需要 pystray + Pillow;`--tray` 参数仅为兼容旧命令保留,
无实际作用)。状态、刷新、退出联动——药丸右键退出会一并停掉托盘,
托盘右键退出会关闭药丸。

**`隐藏窗口 / 显示窗口`**:两个菜单都有——药丸右键菜单提供
"隐藏窗口",托盘菜单提供"隐藏窗口 / 显示窗口"(文案随状态切换)。
隐藏后药丸消失,托盘图标继续显示状态;显示状态持久化,重启后保持。
托盘图标是本模式的必备组件(它是隐藏后唯一的找回入口),缺依赖时
启动会直接给出 `pip install -r requirements.txt` 提示而不是起半个界面。

**默认高度**为一行紧凑文字(`WIDGET_COMPACT_H` = 32px,宽度按文字
自适应);需要更大就拖右下角手柄。

位置、大小和置顶状态**自动记忆**到
`~/.dsh_session_status_widget.json`,重启后原样恢复;若保存的位置已不在
屏幕上(换显示器等),自动回到右下角默认位。药丸是常驻的(无隐藏模式),
状态永远可见;右键退出即可移除。两种模式共用同一个 SSE 客户端,传输、
keepalive 与灰色"无法连接"回退行为完全一致。

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
- `requirements.txt` — runtime dependencies: pystray, Pillow
  (required by both tray modes; `--once` works with the standard
  library alone).
