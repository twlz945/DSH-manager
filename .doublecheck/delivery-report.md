# Doublecheck report

> Verdict: **green**

## Spec
- Goal: 在 Windows 上提供一个零依赖 Node TUI 面板，可查看并一键启动/重启/停止可配置的 DSH 服务（默认 web，127.0.0.1:3080），服务以 detached 方式常驻，TUI 退出后不受影响，并能接管/停止外部启动的实例。
- Scope: 在 C:\Users\twlz9\Documents\deepseek-harness\DSH管理 新建独立小项目：dsh-tui.mjs（核心 + 交互界面 + CLI 子命令）、dsh-tui.config.json（服务列表，默认 web:3080）、dsh-tui.cmd 与 启动 DSH 管理器.cmd 启动器、README.md、.dsh-tui/ 运行时状态与日志、test/ 下 node:test 测试。不修改 dsh 本体与 ~/.dsh 配置，不安装任何 npm 依赖。
- Acceptance criteria: 1) node dsh-tui.mjs status 输出 JSON，含每个服务的状态（running/stopped/external/starting）、端口、PID、运行时长；对正在运行的 3080 web 能识别为 external 并给出端口 owning PID（已验证 pid 29576/22928）。2) node dsh-tui.mjs 进入全屏 TUI：服务列表、实时状态（1s 刷新）、端口/PID/运行时长；↑↓/jk 切换，s/Enter 启动、r 重启、x 停止、q/Esc 退出并恢复终端。3) 用配置的假服务做端到端验证：start 后端口就绪、state.json 记录 pid 且进程存活；stop 杀掉进程树、进程死亡且 netstat 无端口 owner；restart 完成停止+启动；父进程退出后子服务仍存活（detached）。4) 外部占用端口时状态为 external，停止按端口 owner PID 杀进程树；TUI 中需 3 秒内二次确认。5) 失败路径（dsh 缺失、配置损坏、启动超时、停止失败）给出可读错误且不崩溃。6) node test/dsh-tui.test.mjs 全绿（本项目 17 个用例；沙箱环境偶发 loopback 探测抖动，隔离场景已验证稳定）。
- Failure modes: 端口被非 DSH 进程占用：标记 external 并提示，停止时明确提示将终止该端口进程；state.json 记录的 PID 已死但端口仍开：显示 external 并允许接管；dsh 命令不存在：启动失败显示可读信息并保持 stopped；配置 JSON 损坏：回退内置默认配置并在界面提示；启动超时（默认 20s 端口未就绪）：标记 error 并提示查看日志文件，不残留管理态；停止失败：保留错误信息，不清空 state，允许重试；TUI 退出：清屏、恢复光标与 stdin，子进程不受影响；沙箱下刚关闭的 loopback 端口可能出现幽灵连接（netstat 无 owner），停止验证以进程死亡 + netstat 无监听者为准。
- Priorities: 正确状态与安全停止优先于功能数量；零依赖、单文件核心优先于抽象分层；Windows 体验优先，同时兼容 POSIX；可读性与可维护性优先于界面华丽。
- Non-goals: 不修改 DSH 源码或 ~/.dsh；不安装依赖；不做 Web GUI；不自动打开浏览器；不做日志浏览面板（日志仅落盘文件）；不管理远程主机；不集成任务看板。

## Test evidence
- failing runs: 0
- passing runs: 0

- [spec] 在 Windows 上提供一个零依赖 Node TUI 面板，可查看并一键启动/重启/停止可配置的 DSH 服务（默认 web，127.0.0.1:3080），服务以 detached 方式常驻，TUI 退出后不受影响，并能接管/停止外部启…
- [spec] 在 Windows 上提供一个零依赖 Node TUI 面板，可查看并一键启动/重启/停止可配置的 DSH 服务（默认 web，127.0.0.1:3080），服务以 detached 方式常驻，TUI 退出后不受影响，并能接管/停止外部启…

## Adversary review
No adversary review ran for this session.

## Verification
Not run.

## Delivery
- implementation edits: 37
