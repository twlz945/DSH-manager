# DSH 服务管理器（dsh-tui）

零依赖的终端 TUI，用来快捷 **启动 / 重启 / 停止** DSH（默认 `dsh web`，端口 3080），
并实时显示端口、PID、运行时长。服务以 detached 方式常驻，**退出 TUI 不会停止服务**。

- 纯 Node.js（≥ 18），无需安装任何依赖
- 可配置多个服务（列表）
- 能识别并接管手动启动的实例（按端口 owner PID 终止）
- 一键检查/执行 DSH 全局更新（npm），只提示重启、不打断服务
- 用外部编辑器改启动参数，保存后热重载配置
- 附带命令行模式（status/start/stop/update/config），方便脚本调用

> ⚠️ 默认的 `web` 服务通常就是**当前正在使用的 DSH GUI 宿主**：停止/重启它会让
> 当前页面和本会话断开。TUI 对停止/重启外部实例有 3 秒内二次确认；如果不想影响
> 当前实例，请把服务配置到其它端口（如 3090）。

## 快速开始

要求：Node.js 已安装；`dsh` 命令在 PATH 中（Windows 下即 npm 全局的 `dsh.cmd`）。

双击 `启动 DSH 管理器.cmd`，或在终端执行：

```bat
cd /d C:\Users\twlz9\Documents\deepseek-harness\DSH管理
node dsh-tui.mjs
```

也可以用 `dsh-tui.cmd` 作为命令别名（可在任意目录执行，建议把本目录加入 PATH）。

## TUI 按键

| 按键 | 作用 |
| --- | --- |
| `↑` / `↓` 或 `k` / `j` | 选择服务 |
| `s` / `Enter` | 启动选中的服务 |
| `r` | 重启（先停后起） |
| `x` / `Backspace` | 停止选中的服务 |
| `e` | 用外部编辑器修改启动参数，保存后热重载 |
| `u` | 检查更新；有新版时再按一次 `u` 执行更新 |
| `q` / `Esc` / `Ctrl+C` | 退出 TUI（服务继续运行） |

当端口被**外部启动**的进程占用时，停止/重启需要在 3 秒内再按一次确认，防止误杀。
更新检查结果出现后，`Esc` 用于取消待执行的更新。

启动/停止期间底部显示进度；每 1 秒自动刷新状态。

## 状态说明

| 状态 | 含义 |
| --- | --- |
| `running` | 由本工具启动并记录在案，进程存活、端口在监听 |
| `external` | 端口在监听，但不是本工具启动的（可接管停止） |
| `starting` | 进程已创建但端口尚未就绪 |
| `stopped` | 端口无监听且无存活进程 |

运行数据保存在配置文件同目录的 `.dsh-tui/`：

- `.dsh-tui/state.json`：各服务的 PID、启动时间、日志路径
- `.dsh-tui/logs/<id>.log`：该服务的 stdout/stderr
- `.dsh-tui/logs/update-<时间>.log`：DSH 更新输出

## 命令行模式

```bat
node dsh-tui.mjs status                 :: 输出 JSON（含 status/pid/uptimeMs 等）
node dsh-tui.mjs list                   :: 列出配置中的服务
node dsh-tui.mjs start web              :: 启动
node dsh-tui.mjs stop web               :: 停止
node dsh-tui.mjs restart web            :: 重启
node dsh-tui.mjs update --check         :: 只检查 DSH 更新（JSON）
node dsh-tui.mjs update                 :: 检查并执行 npm 全局更新
node dsh-tui.mjs config path            :: 配置文件路径
node dsh-tui.mjs config show            :: 输出配置 JSON
node dsh-tui.mjs config edit            :: 用外部编辑器修改配置
node dsh-tui.mjs config set web args '["web","--port","3090"]'
node dsh-tui.mjs --config my.json start web
```

`update` 只更新 npm 全局包 `@deepseek-ai/dsh@latest`，**不会停止或重启任何服务**；
更新完成后需要手动按 `r` 重启服务才会用上新版本。

`config set` 支持的字段：`name`、`command`、`args`、`port`、`host`、`url`、`cwd`、
`startTimeoutMs`、`env`。其中 `args` 必须是 JSON 数组、`env` 必须是 JSON 对象、
`port`/`startTimeoutMs` 必须是整数。写入前会做完整校验，并保留配置文件里其它
未知字段与其它服务。

`status` 的 JSON 结构：

```json
{
  "version": "1.1.0",
  "config": "...\\dsh-tui.config.json",
  "runtimeDir": "...\\.dsh-tui",
  "warning": null,
  "services": [
    {
      "id": "web",
      "name": "DSH Web",
      "status": "external",
      "port": 3080,
      "host": "127.0.0.1",
      "url": "http://127.0.0.1:3080",
      "pid": 29576,
      "portPid": 29576,
      "managedPid": null,
      "startedAt": null,
      "uptimeMs": null,
      "logPath": "...\\.dsh-tui\\logs\\web.log"
    }
  ]
}
```

## 更新 DSH

TUI 中按 `u`：先显示「已安装版本 / npm 最新版本」；有新版时再按一次 `u` 执行
`npm install -g @deepseek-ai/dsh@latest`。更新输出写入
`.dsh-tui/logs/update-<时间>.log`，失败时消息栏会显示错误和日志路径。
网络不可用、npm 不存在或权限不足都会以可读错误呈现，不影响 TUI 继续使用。
更新完成后只提示「重启服务后生效」，不会自动停止或重启任何服务。

## 修改启动参数

TUI 中按 `e` 会临时退出全屏，用外部编辑器打开配置文件，保存退出后自动重载。
编辑器优先级：`DSH_TUI_EDITOR` → `VISUAL` → `EDITOR` → `notepad`（Windows）/`vi`。
配置改坏时会回退内置默认配置并显示警告，原文件不会被覆盖。

修改保存后服务不会自动重启；面板上会提示「配置已重新加载，重启服务后生效」，
需要时按 `r` 重启该服务。也可以直接编辑 `dsh-tui.config.json`，或使用
`config set` 命令。

## 配置

默认读取本目录的 `dsh-tui.config.json`；文件不存在时使用内置默认配置。
也可用 `--config <路径>` 或环境变量 `DSH_TUI_CONFIG` 指定。

```json
{
  "services": [
    {
      "id": "web",
      "name": "DSH Web",
      "command": "dsh",
      "args": ["web", "--port", "3080"],
      "port": 3080,
      "host": "127.0.0.1",
      "url": "http://127.0.0.1:3080",
      "cwd": ".",
      "startTimeoutMs": 20000,
      "env": {}
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 服务唯一标识，命令行和 state 用 |
| `name` | 显示名称（缺省同 id） |
| `command` | 可执行文件；Windows 下 `.cmd`/`.bat` 会自动经 shell 启动 |
| `args` | 参数数组 |
| `port` / `host` | 用于端口探测的地址（默认 3080 / 127.0.0.1） |
| `url` | 显示用 URL |
| `cwd` | 工作目录，相对配置文件所在目录；缺省为该目录 |
| `startTimeoutMs` | 启动后等待端口监听的超时（毫秒） |
| `env` | 追加的环境变量 |

可配置多个服务，例如同时管理 `web` 与另一个 profile：

```json
{
  "services": [
    { "id": "web", "command": "dsh", "args": ["web", "--port", "3080"], "port": 3080 },
    { "id": "dev", "name": "DSH Dev", "command": "dsh", "args": ["web", "--port", "3090"], "port": 3090 }
  ]
}
```

> 注意：多个服务不能共用同一端口；同一 id 重复会报配置错误。
>
> `dsh web` 进程默认会自行打开浏览器；若不需要，把 `args` 改为
> `["web", "--port", "3080", "--no-open"]`。

## 安全与边界

- 只终止「端口 owner PID」或 state 中记录且存活的 PID；不会按进程名批量杀进程
- 停止外部实例必须二次确认（TUI）或显式执行 `stop`（命令行）
- 本工具不会主动打开浏览器（`dsh web` 自身可能按 DSH 默认行为打开，可用 `--no-open` 关闭）；不会读取/解析日志内容（日志仅供排错）
- 不会修改 DSH 本体或其配置

## 故障排查

- **`dsh-tui: 当前不是交互式终端`**：在 IDE 输出面板或重定向环境中无法进入 TUI，请改用 `status/start/stop` 子命令或在真正的终端窗口运行。
- **启动失败、进程已退出**：查看 `.dsh-tui/logs/<id>.log`，常见原因是 `dsh` 不在 PATH，或端口被占用。
- **权限不足（EPERM）**：Windows 下结束进程需要相应权限；以普通用户运行时若目标进程属于其他用户，会提示手动处理。
