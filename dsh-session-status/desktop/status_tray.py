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
    python status_tray.py                   # run the tray (default 127.0.0.1:3080)
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


def run_tray(args):
    import pystray
    from PIL import Image

    client = StatusClient(host=args.host, port=args.port, poll_only=args.poll)

    icon = None
    images = {}

    def ensure_icon():
        nonlocal icon
        if icon is None:
            icon = pystray.Icon(
                "dsh-session-status",
                _load_icon(UNKNOWN),
                TITLE[UNKNOWN],
                build_menu(client),
            )
        return icon

    def build_menu(client):
        def _refresh(_icon, _item):
            try:
                snap = client.fetch_snapshot()
                client._apply(snap, ok=True)
            except Exception:
                client._apply(None, ok=False)

        def _quit(_icon, _item):
            client.stop()
            _icon.stop()

        return (
            pystray.MenuItem(
                "status",
                lambda it: status_line(client),
                default=True,
                enabled=False,
            ),
            pystray.MenuItem("刷新 / Refresh", _refresh),
            pystray.Separator(),
            pystray.MenuItem("退出 / Quit", _quit),
        )

    def status_line(client):
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

    def on_state(state, snapshot):
        # Called from the client thread; pystray's update_* post to its own
        # UI thread, so this is safe to invoke off-main.
        try:
            ic = ensure_icon()
            ic.icon = _load_icon(state)
            ic.update_title(TITLE[state])
            ic.update_menu(build_menu(client))
        except Exception:
            pass

    client.on_state = on_state
    client.start()

    ic = ensure_icon()
    # paint the first real state as soon as it arrives (on_state), but give
    # the icon an initial title now.
    try:
        ic.run()
    except KeyboardInterrupt:
        pass
    finally:
        client.stop()


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
    p.add_argument("--timeout", type=float, default=4.0)
    args = p.parse_args(argv)

    if args.once:
        return cmd_once(args)
    run_tray(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
