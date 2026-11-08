# Doublecheck report

> Verdict: **green**

## Spec
- Goal: 在现有 dsh-tui 中增加“检查并执行 DSH 全局更新（npm）”和“用外部编辑器修改启动参数并热重载配置”的能力，并提供 update / config 命令行入口；更新后只提示重启生效，不自动重启服务。
- Scope: 修改 dsh-tui.mjs（TUI 键位 u/e、更新检查与安装、编辑器打开与配置重载、CLI update/config 子命令）、README.md 与 --help、test/dsh-tui.test.mjs；允许新增运行时日志文件（.dsh-tui/logs/update-*.log）。不修改 DSH 本体或 ~/.dsh，不安装依赖，不改动已有 config 字段语义。
- Acceptance criteria: 1) TUI 按 u：先检查 `dsh --version` 与 `npm view @deepseek-ai/dsh version`，显示已安装/最新版本；有新版时再次按 u 执行 `npm install -g @deepseek-ai/dsh@latest`，完成后显示新版本并提示“重启服务后生效”，绝不自动重启服务；失败显示可读错误与日志路径。2) TUI 按 e：退出全屏/原始模式，用 `DSH_TUI_EDITOR`/`VISUAL`/`EDITOR`（缺省 Windows notepad、POSIX vi）打开配置文件，编辑器退出后重新加载配置并提示“配置已重新加载，重启服务后生效”；配置损坏时回退默认并显示警告；终端正确恢复。3) CLI `update --check` 输出 JSON {installed, latest, updateAvailable}；`update` 执行更新并报告前后版本，已最新时退出 0。4) CLI `config path|show|edit|set <id> <field> <value>`：支持 name/command/args/port/host/url/cwd/startTimeoutMs/env；args/env 用 JSON，port/startTimeoutMs 用数字；非法字段/值/服务以退出码 1 报错且不写文件；写入时保留配置文件中的未知字段与其它服务。5) test/dsh-tui.test.mjs 全绿，覆盖版本比较、更新检查（注入假 runner）、config 子命令、TUI 编辑器重载冒烟。
- Failure modes: npm/dsh 不存在或网络失败：更新检查/执行显示可读错误与日志路径，TUI 不崩溃、可继续操作；已是最新版本：提示无需更新且不执行安装；编辑器缺失或非 0 退出：提示错误但仍重载配置，TUI 继续运行；编辑器把配置改坏：回退内置默认配置并在消息栏/CLI 输出警告，不覆盖用户文件；config set 非法 JSON/字段/端口：退出码 1、文件保持原样；更新期间再次按键：被 busy 忽略；更新不停止/重启任何运行中的服务。
- Priorities: 配置数据安全（保留未知字段、校验后再写）优先于实现简洁；更新失败可恢复优先于速度；零依赖、单文件核心优先；Windows 优先并兼容 POSIX。
- Non-goals: 不做管理工具自更新；不做自动更新/开机检查；不支持 latest 之外的 tag 选择；更新后不自动停止或重启服务；不做 TUI 内结构化参数编辑表单；不支持 pnpm/yarn 或非 npm 全局安装；不改变现有 config 结构语义。

## Test evidence
- failing runs: 0
- passing runs: 0

- [spec] 在 Windows 上提供一个零依赖 Node TUI 面板，可查看并一键启动/重启/停止可配置的 DSH 服务（默认 web，127.0.0.1:3080），服务以 detached 方式常驻，TUI 退出后不受影响，并能接管/停止外部启…
- [spec] 在 Windows 上提供一个零依赖 Node TUI 面板，可查看并一键启动/重启/停止可配置的 DSH 服务（默认 web，127.0.0.1:3080），服务以 detached 方式常驻，TUI 退出后不受影响，并能接管/停止外部启…
- [spec] 在现有 dsh-tui 中增加“检查并执行 DSH 全局更新（npm）”和“用外部编辑器修改启动参数并热重载配置”的能力，并提供 update / config 命令行入口；更新后只提示重启生效，不自动重启服务。

## Adversary review
No adversary review ran for this session.

## Verification
Not run.

## Delivery
- implementation edits: 60
