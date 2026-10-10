# DSH Session Status Light

[English](README.md) | [中文](README.zh.md)

A global **red / yellow / green** status light for your DSH sessions — see at a
glance whether some session is waiting on you, an agent is working, or
everything is idle, without opening any session.

It answers the question that haunts everyone running DSH: *"can I step away
right now?"* — is a session stuck on an approval, a question, or a plan
review? Is an agent still running? Or has it all stopped?

## How it looks

| Light | Meaning | When |
| :---: | --- | --- |
| 🔴 | **Blocked — waiting on you** | any session has a pending human interaction (approval / question / plan review) |
| 🟡 | **Running** | nothing blocked, but at least one session's agent is running |
| 🟢 | **Idle** | nothing blocked, nothing running |
| ⚪ | **Unreachable** | the desktop tool can't read DSH (server down / bridge disabled) |

Precedence is **red > yellow > green**: a session that is running *and* waiting
on you shows red — "needs a human" always beats "just moving". The state is
**global** across all sessions, not just the one currently open.

## Features

- 🌐 **Browser sidebar** — persistent status dot in the Web GUI sidebar footer;
  expanded view adds a text label ("Needs human (2)", "Running (1)", "Idle")
  and a hover tooltip
- 🏷️ **Browser tab** — the tab favicon follows the state color, visible when
  switching tabs or glancing at the taskbar / Dock
- 🖥️ **Desktop** — an always-on-top pill in a screen corner + system tray
  icon, visible without a browser; the pill is draggable, resizable, and
  hideable, and the tray icon is the only way back after hiding
- 🔌 **Single source of truth** — all surfaces read the same read-only bridge
  endpoint mounted on the web server you already run: **no new port, no extra
  resources**; the color always matches across surfaces
- ⚙️ **Configurable** — tab-icon mode (replace favicon vs. overlay) and the
  desktop bridge are toggled in **Settings → 状态监控** and persisted

## Requirements

- A running DSH web server (the plugin's host; the bridge is mounted by it)
- Python 3.9+ for the desktop tool (`--once` / `--widget` modes are stdlib-only;
  tray mode adds `pystray` + `Pillow`)

## Quick start

### 1. Browser sidebar + tab (DSH plugin)

```sh
# from npm (published):
dsh plugin --profile web add dsh-status-light
# or from a local checkout (dev):
dsh plugin --profile web add /path/to/dsh-session-status
dsh --profile web           # effective after restart
```

### 2. Desktop pill + tray (Python tool)

```powershell
cd desktop/desktop-python
pip install -r requirements.txt      # only pystray + Pillow
python status_tray.py                # default: pill + tray
```

If the tool can't reach the server or the bridge is disabled, it degrades
to grey automatically.

## How it works

The plugin mounts a **read-only "status bridge"** on the web server that boils
"blocked / running" across all sessions down into one red-yellow-green
snapshot. The browser lights and the desktop tool both read from this single
place, so every surface always agrees.

```
              DSH web server
              ┌─────────────────────────┐
  sessions / ─▶  status bridge (read-   │
  agents        only, R/Y/G snapshot)   │
              └───────────┬─────────────┘
                 ┌────────┼─────────┐
          sidebar light   tab icon   desktop pill + tray
```

## Repository structure

```
dsh-session-status/     browser plugin (npm: dsh-status-light): sidebar light + tab favicon + settings page + status bridge
desktop/                unified home for desktop companions (may hold several implementations)
  desktop-python/       Python edition: always-on-top pill + system tray (current edition)
test-*.mjs / .cjs       plugin tests
```

## Documentation

- **Browser plugin** — status rules, install, settings, bridge API & security:
  [`dsh-session-status/README.md`](dsh-session-status/README.md) ·
  [中文](dsh-session-status/README.zh.md)
- **Desktop tool** — how to run, pill interactions, connection behavior:
  [`desktop/desktop-python/README.md`](desktop/desktop-python/README.md)
- **Desktop editions overview** — how to add a new implementation:
  [`desktop/README.md`](desktop/README.md)

## License

[MIT](LICENSE) © dsh-agent
