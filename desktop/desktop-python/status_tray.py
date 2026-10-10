#!/usr/bin/env python3
"""dsh-session-status — desktop tray indicator (Option A: read-only HTTP).

A small Windows/Linux/macOS system-tray light that mirrors the browser
indicator's global red / yellow / green state. It talks to the DSH web
server you are ALREADY running — no new port, no socket:

    GET /session-status         → one JSON snapshot
    GET /session-status/stream  → SSE: a frame per state change, 15 s keepalive

States (precedence blocked > running > idle, plus a grey "unreachable"):

    red    blocked   需人工处理  — an approval / question / plan review is
                                    waiting on a human (in flight)
    yellow running   运行中      — at least one agent is working
    green  idle      空闲        — nothing pending, nothing running
    grey   unknown   无法连接    — the web server / bridge is unreachable

Dependencies (see requirements.txt): pystray + Pillow. The fetch/parse core
has ZERO third-party imports, so `--once` works for testing without them:

    python status_tray.py --once            # print one snapshot, exit
    python status_tray.py                   # desktop app: always-on-top
                                             # pill + tray icon (default)
    python status_tray.py --tray-only       # tray icon only, no pill window
    python status_tray.py --host 127.0.0.1 --port 3080 --poll   # polling only
"""

import argparse
import json
import os
import queue
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, "icons")

# ── states ────────────────────────────────────────────────────────────────
BLOCKED, RUNNING, IDLE, UNKNOWN = "blocked", "running", "idle", "unknown"

# human titles (the tray tool runs on a desktop, so it shows its own copy;
# it does not depend on the DSH locale service).
TITLE = {
    BLOCKED: "DSH · 需人工处理 (blocked)",
    RUNNING: "DSH · 运行中 (running)",
    IDLE: "DSH · 空闲 (idle)",
    UNKNOWN: "DSH · 无法连接 (unreachable)",
}
ICON_FILE = {
    BLOCKED: "red.png",
    RUNNING: "yellow.png",
    IDLE: "green.png",
    UNKNOWN: "gray.png",
}
# Hex colors for the widget pill (same hues as the PNG icons).
STATE_COLOR = {
    BLOCKED: "#ef4444",
    RUNNING: "#f59e0b",
    IDLE: "#22c55e",
    UNKNOWN: "#9ca3af",
}
PILL_BG = "#111827"
PILL_FG = "#f9fafb"

# ── widget geometry (user-adjustable, persisted) ─────────────────────────
WIDGET_MIN_W = 120
WIDGET_MIN_H = 30
WIDGET_MAX_W = 720
WIDGET_MAX_H = 240
WIDGET_HANDLE = 16  # bottom-right resize grip, px
WIDGET_COMPACT_H = 32  # default height: just tall enough for one text line
WIDGET_STATE_FILE = os.path.join(
    os.path.expanduser("~"), ".dsh_session_status_widget.json")


def _widget_load_state():
    """Persisted {x, y, w, h, topmost}; None when missing or corrupt."""
    try:
        with open(WIDGET_STATE_FILE, encoding="utf-8") as f:
            d = json.load(f)
        return {
            "x": int(d["x"]),
            "y": int(d["y"]),
            "w": int(d["w"]),
            "h": int(d["h"]),
            "topmost": bool(d.get("topmost", True)),
            "visible": bool(d.get("visible", True)),
        }
    except Exception:
        return None


def _widget_save_state(x, y, w, h, topmost, visible=True):
    """Best-effort atomic write; a failure never breaks the pill."""
    try:
        tmp = WIDGET_STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"x": int(x), "y": int(y), "w": int(w), "h": int(h),
                       "topmost": bool(topmost), "visible": bool(visible)}, f)
        os.replace(tmp, WIDGET_STATE_FILE)
    except Exception:
        pass


def _widget_default_geometry(root):
    """Fresh-install placement: bottom-right, offset clear of the tray
    (anchored at 0,0 when the screen is smaller than the pill).

    The default height is WIDGET_COMPACT_H — just tall enough for the
    one line of text — instead of the font-dependent reqheight, which
    leaves visible slack above and below the label on Windows.
    """
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    pw = root.winfo_reqwidth()
    ph = WIDGET_COMPACT_H
    return pw, ph, max(0, sw - pw - 24), max(0, sh - ph - 40)


def _widget_place(root, saved):
    """Apply the persisted geometry clamped to the current screen; re-dock
    when nothing is saved or it no longer fits (monitor removed, …)."""
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    dw, dh, dx, dy = _widget_default_geometry(root)
    if saved and not (saved["x"] > sw or saved["y"] > sh
                      or saved["x"] + saved["w"] < 0
                      or saved["y"] + saved["h"] < 0):
        w = max(WIDGET_MIN_W, min(WIDGET_MAX_W, saved["w"]))
        h = max(WIDGET_MIN_H, min(WIDGET_MAX_H, saved["h"]))
        x = max(0, min(saved["x"], sw - w))
        y = max(0, min(saved["y"], sh - h))
    else:
        w, h, x, y = dw, dh, dx, dy
    root.geometry("%dx%d+%d+%d" % (w, h, x, y))
# display order for the menu status line
STATE_LABEL = {
    BLOCKED: "需人工处理 (blocked)",
    RUNNING: "运行中 (running)",
    IDLE: "空闲 (idle)",
    UNKNOWN: "无法连接 (unreachable)",
}

VALID_STATES = (BLOCKED, RUNNING, IDLE, UNKNOWN)


def _state_of(snapshot):
    """Normalize a snapshot dict to one of the four local states."""
    if not isinstance(snapshot, dict):
        return UNKNOWN
    st = snapshot.get("state")
    if st in (BLOCKED, RUNNING, IDLE):
        return st
    # A missing/foreign `state` but a live `blocked`/`running` count still
    # tells us the server is answering: fall back to the counts.
    try:
        if int(snapshot.get("blocked", 0)) > 0:
            return BLOCKED
        if int(snapshot.get("running", 0)) > 0:
            return RUNNING
        return IDLE
    except (TypeError, ValueError):
        return UNKNOWN


class StatusClient:
    """Owns the connection to the DSH web server and the current state.

    Runs in a daemon thread. Default transport is the SSE stream (one frame
    per change, instant); if the stream is unavailable it degrades to polling
    the snapshot endpoint. After `fail_threshold` consecutive failures the
    state flips to UNKNOWN (grey) and it keeps retrying with backoff.
    """

    def __init__(self, host="127.0.0.1", port=3080, poll_only=False,
                 poll_interval=2.0, fail_threshold=2, on_state=None):
        self.host = host
        self.port = int(port)
        self.poll_only = poll_only
        self.poll_interval = poll_interval
        self.fail_threshold = fail_threshold
        self.on_state = on_state  # cb(state, snapshot)
        self.base = "http://%s:%d" % (host, port)
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._state = UNKNOWN
        self._snapshot = None

    # -- public face --------------------------------------------------------
    @property
    def state(self):
        with self._lock:
            return self._state

    @property
    def snapshot(self):
        with self._lock:
            return dict(self._snapshot) if self._snapshot else None

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name="dsh-status-client")
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()

    # -- one-shot snapshot (used by --once and the poll loop) ---------------
    def fetch_snapshot(self, timeout=4.0):
        url = self.base + "/session-status"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if getattr(resp, "status", 200) != 200:
                raise urllib.error.URLError("status %s" % getattr(resp, "status", "?"))
            body = resp.read()
        return json.loads(body.decode("utf-8"))

    # -- state bookkeeping --------------------------------------------------
    def _apply(self, snapshot, ok=True):
        state = _state_of(snapshot) if ok else UNKNOWN
        with self._lock:
            changed = (state != self._state) or (snapshot != self._snapshot)
            self._state = state
            if snapshot is not None:
                self._snapshot = snapshot
        if changed and self.on_state:
            try:
                self.on_state(state, snapshot if ok else None)
            except Exception:
                pass  # a UI callback must never kill the client thread

    # -- main loop ----------------------------------------------------------
    def _run(self):
        fails = 0
        while not self._stop.is_set():
            streamed = False
            if not self.poll_only:
                try:
                    self._stream_once()
                    streamed = True
                    # The server closed the stream cleanly (e.g. the bridge
                    # was disabled via the settings toggle): pause briefly,
                    # then reconnect — do not busy-loop.
                    self._stop.wait(0.5)
                except _Stop:
                    return
                except Exception:
                    streamed = False
            ok = streamed or self._poll_once()
            if ok:
                fails = 0
            else:
                fails += 1
                if fails >= self.fail_threshold:
                    self._apply(None, ok=False)
                # backoff a little so a downed server isn't hammered
                self._stop.wait(1.5 if fails < self.fail_threshold else 5.0)

    def _poll_once(self):
        try:
            snap = self.fetch_snapshot()
        except Exception:
            return False
        self._apply(snap, ok=True)
        return True

    # -- SSE stream (stdlib http.client, no third-party deps) ---------------
    def _stream_once(self):
        import http.client
        conn = http.client.HTTPConnection(self.host, self.port, timeout=40)
        try:
            conn.request("GET", "/session-status/stream",
                         headers={"Accept": "text/event-stream",
                                  "Cache-Control": "no-cache"})
            resp = conn.getresponse()
            if resp.status != 200:
                raise RuntimeError("stream status %s" % resp.status)
            data_lines = []
            for raw in resp:  # HTTPResponse is line-iterable, dechunks for us
                if self._stop.is_set():
                    raise _Stop()
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if line == "":
                    # event boundary: dispatch the accumulated data
                    if data_lines:
                        payload = "\n".join(data_lines)
                        data_lines = []
                        self._dispatch_frame(payload)
                    continue
                if line.startswith(":"):
                    continue  # comment (the 15 s keepalive)
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
                    continue
                # "retry:", "event:", "id:" — not used by the bridge; ignore.
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _dispatch_frame(self, payload):
        try:
            snap = json.loads(payload)
        except (ValueError, TypeError):
            return
        self._apply(snap, ok=True)


class _Stop(Exception):
    pass


# ── tray (pystray) — imported lazily so --once needs no GUI deps ----------
def _load_icon(state):
    from PIL import Image  # lazy: only needed to actually show the tray
    path = os.path.join(ICON_DIR, ICON_FILE[state])
    return Image.open(path).convert("RGBA")


def _icon_path(state):
    return os.path.join(ICON_DIR, ICON_FILE[state])


def _separator():
    """pystray's shared SEPARATOR sentinel.

    No pystray release exposes a top-level Separator() — the documented
    separator is the shared pystray.Menu.SEPARATOR sentinel (a disabled
    "- - - -" item) in both 0.18 and 0.19. Fall back to it defensively if a
    future build relocates it.
    """
    import pystray
    return getattr(pystray.Menu, "SEPARATOR", pystray.MenuItem("- - - -", None))


def status_line(client):
    """Dynamic status row shown at the top of the tray menu."""
    snap = client.snapshot or {}
    st = client.state
    try:
        b = int(snap.get("blocked", 0))
        r = int(snap.get("running", 0))
        ids = snap.get("runningIds") or []
    except (TypeError, ValueError):
        b = r = 0
        ids = []
    line = "状态: %s  ·  阻塞 %d  ·  运行 %d" % (STATE_LABEL[st], b, r)
    if st == RUNNING and ids:
        line += "\n正在运行: " + ", ".join(str(x) for x in ids)
    return line


def _tray_build_menu(client, on_quit, set_visible=None):
    """The standard tray menu. `on_quit(icon)` runs for the 退出 item.

    When `set_visible(v)` is given — i.e. the tray is a companion to a
    widget window — TWO fixed entries are inserted before 退出:
    显示窗口 and 隐藏窗口. Fixed labels are deliberate: the win32 backend
    only rebuilds its native menu on LEFT-click (Icon.__call__) and at
    startup — a right-click popup shows the last-built menu, so a single
    callable-titled "toggle" entry would display a stale direction. Two
    always-enabled buttons never lie, and the no-op one is harmless.
    """
    import pystray

    def _refresh(_icon, _item):
        try:
            snap = client.fetch_snapshot()
            client._apply(snap, ok=True)
        except Exception:
            client._apply(None, ok=False)

    def _quit(_icon, _item):
        # Runs on the win32 message-loop thread inside the WndProc — any
        # exception here drops the message; never let one escape.
        try:
            on_quit(_icon)
        except Exception:
            pass

    def _status_text(_it):
        # text position = callable(item) — 1 arg; evaluated each time the
        # backend rebuilds the native menu (on the win32 loop thread), so
        # it must never raise. (An action callable would take (icon, item)
        # and never fire here anyway: the item is disabled.)
        try:
            return status_line(client)
        except Exception:
            return ""

    items = (
        pystray.MenuItem(
            _status_text,
            None,
            default=True,
            enabled=False,
        ),
        pystray.MenuItem("刷新 / Refresh", _refresh),
        _separator(),
    )
    if set_visible is not None:
        # pystray invokes menu actions as action(icon, item) — two args.
        items = items + (
            pystray.MenuItem("显示窗口 / Show",
                             lambda ic, it: set_visible(True)),
            pystray.MenuItem("隐藏窗口 / Hide",
                             lambda ic, it: set_visible(False)),
        )
    items = items + (pystray.MenuItem("退出 / Quit", _quit),)
    return items


def _tray_apply_state(ensure_icon, state):
    """Recolor + retitle the tray icon for a state.

    Safe from the client thread: the win32/gtk backends route the icon
    update through their own message queue (NIM_MODIFY / property post).
    """
    try:
        ic = ensure_icon()
        ic.icon = _load_icon(state)
        ic.title = TITLE[state]
    except Exception:
        pass


def run_tray(args):
    try:
        import pystray  # noqa: F401
        from PIL import Image  # noqa: F401
    except Exception as exc:
        print("[tray] 缺少托盘依赖: %s\n请先执行:  pip install -r requirements.txt"
              % exc)
        return 1

    client = StatusClient(host=args.host, port=args.port, poll_only=args.poll)
    icon = None

    def _quit(_icon):
        # Runs on the message-loop thread inside the WndProc (with
        # ic.run() that is the main thread): keep it fast and
        # exception-proof, and backstop the exit — if the loop thread
        # is the thing that is wedged, no later cleanup runs, and a
        # dead process is the only guarantee the icon goes away.
        try:
            client.stop()
        except Exception:
            pass
        threading.Thread(
            target=lambda: (time.sleep(4.0), os._exit(0)),
            daemon=True, name="dsh-status-hard-exit").start()
        try:
            _icon.stop()
        except Exception:
            pass

    def ensure_icon():
        nonlocal icon
        if icon is None:
            icon = pystray.Icon(
                "dsh-session-status",
                _load_icon(UNKNOWN),
                TITLE[UNKNOWN],
                _tray_build_menu(client, _quit),
            )
        return icon

    client.on_state = lambda st, _snap: _tray_apply_state(ensure_icon, st)
    client.start()

    ic = ensure_icon()
    try:
        ic.run()
    except KeyboardInterrupt:
        pass
    finally:
        client.stop()
    return 0


def run_widget(args):
    """Always-on-top desktop pill (tkinter, stdlib only).

    A small frameless capsule that floats above every other window
    (WS_EX_TOPMOST via -topmost). The SAME StatusClient feeds it, so
    transport / SSE / keepalive logic is shared with the tray.

    User-adjustable — everything persists to
    ~/.dsh_session_status_widget.json and survives restarts:
      position  drag the pill body anywhere
      size      drag the bottom-right grip (the two diagonal lines;
                clamped to WIDGET_MIN..MAX, 120x30 … 720x240)
      topmost   double-click to pin/unpin, or click the right-click menu
                entry 固定在最前 / 取消置顶
    The right-click menu also resets position + size to the default
    bottom-right dock. This desktop version ALWAYS runs both views — the
    pill and a system-tray icon (pystray run_detached, own thread; needs
    pystray + Pillow) — sharing one client: the tray is the only way back
    after 隐藏窗口, so it is mandatory. The tray menu offers fixed
    显示窗口 / 隐藏窗口 buttons (two entries, not a toggle: the win32
    backend only rebuilds its menu on left-click, so a single dynamic
    entry would show a stale direction on a right-click-only session);
    the pill's own menu offers 隐藏窗口. The hidden state is persisted.
    Default window height is one compact line (WIDGET_COMPACT_H); quit
    via either menu.
    """
    try:
        import tkinter as tk
    except Exception as exc:
        print("[widget] 缺少 tkinter(Python 自带的图形库): %s\n"
              "Windows: 重新运行 Python 安装器,勾选 tcl/tk and IDLE 组件"
              % exc)
        return 1

    # Both views are mandatory (the tray is the way back from 隐藏窗口),
    # so their deps are too — fail fast with an actionable message instead
    # of starting half a UI.
    try:
        import pystray  # noqa: F401
        from PIL import Image  # noqa: F401
    except Exception as exc:
        print("[widget] 托盘图标是必备组件,缺少依赖: %s\n"
              "请先执行:  pip install -r requirements.txt" % exc)
        return 1

    client = StatusClient(host=args.host, port=args.port, poll_only=args.poll)
    root = tk.Tk()
    root.title("dsh-session-status")
    root.overrideredirect(True)            # no title bar / taskbar entry

    # UI marshalling: the SSE client thread and pystray's menu thread must
    # NOT call tkinter directly — even root.after() is only safe from the
    # main thread, and a cross-thread root.destroy() (the tray 退出 path)
    # silently no-ops, which is exactly the "quit never exits" bug. Worker
    # threads post callables to this thread-safe queue; the pump below runs
    # ON the main thread and executes them.
    ui_queue = queue.Queue()

    def _ui_poll():
        try:
            while True:
                fn = ui_queue.get_nowait()
                try:
                    fn()
                except Exception:
                    pass
        except queue.Empty:
            pass
        if root.winfo_exists():
            root.after(100, _ui_poll)

    root.after(100, _ui_poll)

    state_var = tk.StringVar(value=TITLE[UNKNOWN])
    # pill: colored dot (oval) + label, dark capsule background
    frame = tk.Frame(root, bg=PILL_BG, padx=12, pady=6, bd=0)
    frame.place(x=0, y=0, relwidth=1.0, relheight=1.0)
    dot = tk.Canvas(frame, width=14, height=14, bg=PILL_BG,
                    highlightthickness=0, bd=0)
    dot.place(x=8, y=6)
    oval = dot.create_oval(1, 1, 13, 13, fill=STATE_COLOR[UNKNOWN], outline="")
    label = tk.Label(frame, textvariable=state_var, bg=PILL_BG, fg=PILL_FG,
                     font=("Segoe UI", 9, "bold"), anchor="w")
    label.place(x=28, y=6)
    # bottom-right resize grip: a small canvas with two diagonal lines so
    # the user can actually SEE where to drag (the previous same-color 12px
    # box was invisible and could not be grabbed). It stacks above the
    # label, so long text runs under it — the grip stays the resize corner.
    handle = tk.Canvas(frame, width=WIDGET_HANDLE, height=WIDGET_HANDLE,
                       bg=PILL_BG, highlightthickness=0, bd=0,
                       cursor="sizing")
    _hc = "#9ca3af"
    handle.create_line(3, WIDGET_HANDLE - 3, WIDGET_HANDLE - 3, 3, fill=_hc)
    handle.create_line(8, WIDGET_HANDLE - 3, WIDGET_HANDLE - 3, 8, fill=_hc)
    handle.place(relx=1.0, rely=1.0, anchor="se")

    root.update_idletasks()
    saved = _widget_load_state()
    _widget_place(root, saved)
    pinned_box = [bool(saved["topmost"]) if saved else True]
    root.attributes("-topmost", pinned_box[0])
    visible_box = [bool(saved["visible"]) if saved else True]
    if not visible_box[0]:
        root.withdraw()  # start hidden; the tray icon keeps the status

    def paint(st, snap):
        # called from the client thread -> marshal onto the main thread via
        # the UI queue (never call tkinter from this thread)
        def _apply():
            state_var.set(TITLE[st])
            dot.itemconfig(oval, fill=STATE_COLOR[st])
            # Re-assert topmost (some windows steal it) — only while the
            # user has it pinned, so a deliberate unpin is never overridden.
            if root.winfo_exists() and pinned_box[0]:
                root.attributes("-topmost", True)
        ui_queue.put(_apply)

    def _persist():
        _widget_save_state(root.winfo_x(), root.winfo_y(),
                           root.winfo_width(), root.winfo_height(),
                           pinned_box[0], visible_box[0])

    # --- show / hide the pill (tray menu + persisted) ---
    def _set_visible(v):
        if v:
            root.deiconify()
            if pinned_box[0]:
                root.attributes("-topmost", True)
        else:
            root.withdraw()
        visible_box[0] = v

    def _toggle_visible():
        _set_visible(not visible_box[0])
        _persist()

    # Companion tray icon (pystray) — mandatory in this desktop version:
    # the tray is how a hidden pill gets shown again. Its message loop runs
    # via run_detached in its own thread; tkinter owns the main thread.
    # Both views are painted from the one client thread callback; the tray
    # is fully up BEFORE client.start() — exactly one start.
    tray_icon = None

    # "Quit is being requested" latch + hard-exit backstop. Arming it at
    # the MOMENT the user clicks 退出 (not after mainloop returns — which
    # may never happen if the tray's message loop is the thing that is
    # stuck) guarantees the process is gone within ~4s no matter what is
    # wedged; Windows removes the process's tray icons when it dies.
    _quitting = [False]

    def _arm_hard_exit():
        if _quitting[0]:
            return
        _quitting[0] = True
        threading.Thread(
            target=lambda: (time.sleep(4.0), os._exit(0)),
            daemon=True, name="dsh-status-hard-exit").start()

    def _request_quit():
        # Runs on the tk main thread (via the UI queue). Does the whole
        # teardown: persist, stop the client, stop the tray icon, destroy
        # the window. Icon.stop() from the main thread is safe: it only
        # posts WM_STOP (any thread may post) and joins the long-dead
        # setup thread, so it returns promptly; the tray's loop thread
        # (free, because the menu callback returned immediately) then
        # processes WM_STOP and cleans up the icon normally.
        _persist()
        _arm_hard_exit()
        try:
            client.stop()
        except Exception:
            pass
        if tray_icon is not None:
            try:
                tray_icon.stop()
            except Exception:
                pass
        try:
            if root.winfo_exists():
                root.destroy()
        except Exception:
            pass

    def _tray_set_visible(v):
        # pystray worker thread -> main thread via the UI queue
        ui_queue.put(lambda: (_set_visible(v), _persist()))

    def _tray_quit(_icon):
        # Runs INSIDE pystray's win32 WndProc on the tray message-loop
        # thread. It must return immediately: a blocking stop() there
        # freezes the icon pump, and an escaping exception drops the
        # message (WM_STOP included) in the WndProc — exactly the
        # "clicked 退出, icon stays, menu never opens again" zombie.
        ui_queue.put(_request_quit)

    try:
        tray_icon = pystray.Icon(
            "dsh-session-status",
            _load_icon(UNKNOWN),
            TITLE[UNKNOWN],
            _tray_build_menu(client, _tray_quit,
                             set_visible=_tray_set_visible),
        )
        tray_icon._dsh_started = time.monotonic()
        tray_icon.run_detached()
        _tray_apply_state(lambda: tray_icon, client.state)
        client.on_state = lambda st, snap: (
            paint(st, snap),
            _tray_apply_state(lambda: tray_icon, st),
        )
    except Exception as exc:
        # The deps imported fine above, so this is a runtime backend
        # failure (no tray in this session, etc.). Without the tray a
        # hidden pill has no way back — refuse to start half a UI.
        print("[widget] 托盘图标(必备组件)启动失败: %s" % exc)
        if tray_icon is not None:
            try:
                tray_icon.stop()
            except Exception:
                pass
        client.stop()
        root.destroy()
        return 1
    client.start()

    def _respawn_tray():
        # Rebuild the tray icon after its message-loop thread died.
        # pystray's run_detached spawns the loop thread with the
        # exception swallowed (threading.Thread(...).start()), so a
        # startup-phase failure (e.g. antivirus locking the temp icon
        # file, Shell failure) leaves a ZOMBIE: the tray icon stays
        # visible (no NIM_DELETE ever comes) but right-clicks are dead
        # because nothing pumps its hidden window's messages. The tray
        # is mandatory in this app, so a dead loop thread is a state
        # we must recover from, not wait out.
        nonlocal tray_icon
        old_ic = tray_icon
        tray_icon = None
        if old_ic is not None:
            # Do NOT call old_ic.stop() here: if the loop thread died
            # before _mark_ready, its setup thread blocks forever on the
            # ready-queue and stop() burns its full 5s join timeout. The
            # loop thread is dead by definition, so it will never clean
            # up — send NIM_DELETE directly (thread-safe shell call) to
            # make the zombie icon disappear right now.
            try:
                old_ic._message(0, 0)  # NIM_DELETE (win32: code 0)
            except Exception:
                pass
        try:
            tray_icon = pystray.Icon(
                "dsh-session-status",
                _load_icon(UNKNOWN),
                TITLE[UNKNOWN],
                _tray_build_menu(client, _tray_quit,
                                 set_visible=_tray_set_visible),
            )
            tray_icon._dsh_started = time.monotonic()
            tray_icon.run_detached()
            _tray_apply_state(lambda: tray_icon, client.state)
            print("[widget] 托盘图标已重建 / tray icon rebuilt")
        except Exception as exc2:
            print("[widget] 托盘图标重建失败 / rebuild failed: %s" % exc2)
            tray_icon = None

    def _tray_watchdog():
        # Watches the tray's message-loop thread (the thread pystray
        # swallows exceptions in) and rebuilds the icon if it dies.
        time.sleep(5.0)          # let startup settle
        rebuilds = 0
        while True:
            time.sleep(3.0)
            if _quitting[0]:
                return
            ic = tray_icon
            if ic is None:
                continue
            t = getattr(ic, "_thread", None)
            age = time.monotonic() - getattr(
                ic, "_dsh_started", time.monotonic())
            dead = (t is not None and not t.is_alive()) or (
                t is None and age > 10.0)  # died before _thread was set
            if not dead:
                continue
            rebuilds += 1
            print("[widget] 检测到托盘消息循环已死,重建中(第 %d 次)..."
                  % rebuilds)
            if rebuilds > 5:
                print("[widget] 托盘已重建 5 次仍死亡 — 请检查杀毒软件/系统资源")
                return
            _respawn_tray()

    threading.Thread(
        target=_tray_watchdog, daemon=True,
        name="dsh-status-tray-watchdog").start()

    def _reset_position(_e=None):
        w, h, x, y = _widget_default_geometry(root)
        root.geometry("%dx%d+%d+%d" % (w, h, x, y))
        _persist()

    # --- drag the body to move ---
    drag_box = [None]

    def _drag_start(e):
        drag_box[0] = (e.x_root - root.winfo_x(),
                       e.y_root - root.winfo_y())

    def _drag_move(e):
        if drag_box[0]:
            dx, dy = drag_box[0]
            root.geometry("+%d+%d" % (e.x_root - dx, e.y_root - dy))

    def _drag_end(_e=None):
        if drag_box[0]:
            drag_box[0] = None
            _persist()

    # --- drag the corner handle to resize ---
    resize_box = [None]

    def _resize_start(e):
        resize_box[0] = (root.winfo_width(), root.winfo_height(),
                         e.x_root, e.y_root)

    def _resize_move(e):
        if not resize_box[0]:
            return
        w0, h0, sx, sy = resize_box[0]
        w = max(WIDGET_MIN_W, min(WIDGET_MAX_W, w0 + (e.x_root - sx)))
        h = max(WIDGET_MIN_H, min(WIDGET_MAX_H, h0 + (e.y_root - sy)))
        root.geometry("%dx%d" % (w, h))

    def _resize_end(_e=None):
        if resize_box[0]:
            resize_box[0] = None
            _persist()

    handle.bind("<ButtonPress-1>", _resize_start)
    handle.bind("<B1-Motion>", _resize_move)
    handle.bind("<ButtonRelease-1>", _resize_end)

    # --- pin / reset / quit (defined BEFORE the menu references them) ---
    def _toggle_pin(_e=None):
        pinned_box[0] = not pinned_box[0]
        root.attributes("-topmost", pinned_box[0])
        menu.entryconfig(0, label=("取消置顶 / Unpin" if pinned_box[0]
                                   else "固定在最前 / Pin on top"))

    def _stop_tray(icon):
        try:
            icon.stop()
        except Exception:
            pass

    def _quit_all(_e=None):
        # Same hardened teardown as the tray 退出 (persist, hard-exit
        # backstop, client stop, tray stop, destroy on this main thread).
        _request_quit()

    # Entry 0 is the pin toggle (its label is refreshed by _toggle_pin via
    # entryconfig(0, …)); keep it first. The tray icon is always present,
    # so 隐藏窗口 is always safe to offer.
    menu = tk.Menu(root, tearoff=0)
    menu.add_command(
        label=("取消置顶 / Unpin" if pinned_box[0]
               else "固定在最前 / Pin on top"),
        command=_toggle_pin)
    menu.add_command(label="重置位置与大小 / Reset", command=_reset_position)
    menu.add_command(label="隐藏窗口 / Hide", command=_toggle_visible)
    menu.add_separator()
    menu.add_command(label="退出 / Quit", command=_quit_all)

    for w in (frame, label, dot):
        w.bind("<ButtonPress-1>", _drag_start)
        w.bind("<B1-Motion>", _drag_move)
        w.bind("<ButtonRelease-1>", _drag_end)
        w.bind("<Double-Button-1>", _toggle_pin)
        w.bind("<Button-3>", lambda e: menu.tk_popup(e.x_root, e.y_root))

    root.protocol("WM_DELETE_WINDOW", _quit_all)
    try:
        root.mainloop()
    finally:
        client.stop()
    # pystray's run_detached loop thread is non-daemon: if it lingers after
    # _icon.stop(), a normal process exit would block on it forever — which
    # is what made 退出 look like "it never exits". The watchdog lets a
    # clean exit win; otherwise it force-exits (code 0) after the grace.
    threading.Thread(
        target=lambda: (time.sleep(2.0), os._exit(0)),
        daemon=True, name="dsh-status-exit-watchdog").start()
    return 0


def cmd_once(args):
    """Print one snapshot (and the derived state) and exit. No GUI needed."""
    client = StatusClient(host=args.host, port=args.port)
    try:
        snap = client.fetch_snapshot(timeout=args.timeout)
    except Exception as exc:
        print(json.dumps({"state": UNKNOWN, "error": str(exc)}, ensure_ascii=False))
        return 1
    out = dict(snap)
    out["state"] = _state_of(snap)
    print(json.dumps(out, ensure_ascii=False))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description="DSH desktop session-status tray")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=3080)
    p.add_argument("--poll", action="store_true",
                   help="poll the snapshot endpoint instead of the SSE stream")
    p.add_argument("--once", action="store_true",
                   help="print one snapshot as JSON and exit (no tray)")
    p.add_argument("--widget", action="store_true",
                   help="default mode: always-on-top pill + tray icon")
    p.add_argument("--tray", action="store_true",
                   help="no longer needed: the pill always includes the "
                        "tray icon (accepted for compatibility)")
    p.add_argument("--tray-only", action="store_true",
                   help="tray icon only, no pill window (the pre-default "
                        "behavior)")
    p.add_argument("--timeout", type=float, default=4.0)
    args = p.parse_args(argv)

    if args.once:
        return cmd_once(args)
    if args.tray_only:
        return run_tray(args)
    # default (and explicit --widget): the desktop app — always-on-top
    # pill + tray icon, exactly what --widget --tray used to mean.
    return run_widget(args)


if __name__ == "__main__":
    sys.exit(main())
