# DSH 会话状态灯

[English](README.md) | [中文](README.zh.md)

一个全局**红 / 黄 / 绿**状态灯，让你**一眼看清** DSH 会话的处境——哪个会话在等你
拍板、有 Agent 正在干活，还是全都闲着，不用点开会话翻。

它回答的是跑 DSH 时最折磨人的那个问题：*「我现在能不能走开？」*——有没有会话卡在
审批、提问或计划评审上？Agent 还在跑吗？还是全停了？

## 三个颜色，一句话

| 灯 | 意思 | 什么时候亮 |
| :---: | --- | --- |
| 🔴 | **在等你** | 任意会话有待处理的人工操作（审批 / 提问 / 计划评审） |
| 🟡 | **在干活** | 没卡住，但至少一个会话的 Agent 正在运行 |
| 🟢 | **闲着** | 既没卡住，也没人在跑 |
| ⚪ | **连不上** | 桌面工具读不到 DSH（服务器没起 / 桥被关掉） |

判定优先级 **红 > 黄 > 绿**：一个会话既在跑又在等你时，按红显示——「需要人」
永远优先于「只是在动」。状态是**全局**的，统计所有会话，不是只看当前打开的那个。

## 功能

- 🌐 **浏览器侧栏** —— Web GUI 侧栏底部常驻状态圆点；展开时旁边还有文字
  （「需人工处理（2）」「运行中（1）」「空闲」）和悬停提示
- 🏷️ **浏览器标签页** —— 标签页小图标（favicon）跟着状态换色，切标签、
  瞄任务栏 / Dock 都能看见
- 🖥️ **桌面** —— 屏幕角落的**置顶小药丸** + 系统托盘图标，没有浏览器也看得见；
  药丸可拖动、可缩放、可隐藏，托盘是它被隐藏后唯一的找回入口
- 🔌 **单一数据源** —— 所有界面都读同一个挂在 web 服务器上的**只读状态桥**：
  **不新开端口、不占额外资源**；各界面颜色永远一致
- ⚙️ **可配置** —— 标签页图标模式（替换 favicon / 叠加状态点）和桌面状态桥
  可在 **Settings → 状态监控** 中开关，设置自动持久化

## 环境要求

- 一个正在运行的 DSH web 服务器（插件宿主；状态桥由它挂载）
- 桌面工具需要 Python 3.9+（`--once` / `--widget` 模式纯标准库；
  托盘模式额外需要 `pystray` + `Pillow`）

### DSH 版本兼容性

> ⚠️ **已知问题（v0.5.1）：在 DSH 0.2.0 上无法工作。** DSH **0.2.0** 下插件
> 加载失败，并可能**导致 web GUI 无法启动**；DSH **0.1.5** 下运行正常。
> 在发布兼容版本之前，请继续使用 0.1.5，或先移除插件
> （`dsh plugin --profile web remove dsh-status-light`）再重启。

## 快速开始

### 1. 浏览器侧栏 + 标签页（DSH 插件）

```sh
# 从 npm（已发布）：
dsh plugin --profile web add dsh-status-light
# 或从本地 checkout（开发）：
dsh plugin --profile web add /path/to/dsh-session-status
dsh --profile web           # 重启后生效
```

### 2. 桌面药丸 + 托盘（Python 小工具）

```powershell
cd desktop/desktop-python
pip install -r requirements.txt      # 仅 pystray + Pillow
python status_tray.py                # 默认就是「药丸 + 托盘」
```

读不到服务器或桥被关掉时，桌面工具自动降级为灰色。

## 它怎么连起来的

插件在 web 服务器上挂一个**只读的「状态桥」**，把「有没有会话卡住 / 在跑」
汇成一个红黄绿快照；浏览器里的灯和桌面工具都从**这一个**地方取数，
所以无论你在哪个界面看，颜色永远对得上。

```
              DSH web 服务器
              ┌─────────────────────────┐
   会话/Agent ─▶  状态桥（只读，红黄绿）  │
              └───────────┬─────────────┘
                 ┌────────┼─────────┐
            浏览器侧栏灯  标签页图标  桌面药丸 + 托盘
```

## 目录结构

```
dsh-session-status/     浏览器插件（npm 包名：dsh-status-light）：侧栏状态灯 + 标签页图标 + 设置页 + 状态桥
desktop/                桌面伴侣的统一目录（可放多个实现版本）
  desktop-python/       Python 版：置顶药丸 + 系统托盘（当前唯一版本）
test-*.mjs / .cjs       插件的测试
```

## 细节文档

- **浏览器插件** —— 状态规则、安装、设置、桥的接口与安全：
  [`dsh-session-status/README.md`](dsh-session-status/README.md) ·
  [中文](dsh-session-status/README.zh.md)
- **桌面工具** —— 运行方式、药丸操作、连接行为：
  [`desktop/desktop-python/README.md`](desktop/desktop-python/README.md)
- **桌面版本总览** —— 如何加新版本：
  [`desktop/README.md`](desktop/README.md)

## License

[MIT](LICENSE) © dsh-agent
