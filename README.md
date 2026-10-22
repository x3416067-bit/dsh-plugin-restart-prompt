# dsh-plugin-restart-prompt

DSH 插件变动后提示「重启 DSH」，并一键完成**静默重启**（全程无命令提示符窗口）；同一张卡片上还能展开「查看变动」，看这次到底改了什么。

> 仅 Windows。重启链路用 VBScript + WMI + `taskkill`，依赖 `wscript.exe` 与 `System32\taskkill.exe`。

[English](#english) · [安装](#安装) · [接口](#接口)

## 它解决什么

DSH 的插件组合在宿主启动时构建：装完 / 更新完 / 卸掉一个插件，界面不会自己变，必须重启 DSH。手动重启的麻烦在于——要么在进程管理器里翻出 PID，要么看着终端闪一个黑框，而且如果此刻 Agent 正在跑任务，重启会直接中断它。

本插件把这条链路收成一张卡片：

| 场景 | 表现 |
|---|---|
| profile 的插件清单 / 依赖树落盘变化 | 变化稳定约 0.7s 后在右下角弹出卡片，列出变了什么（插件清单 / 依赖锁 / 补丁层 / 插件目录） |
| 点「查看变动」 | 展开面板：逐文件行级差异（`+` / `−` / 上下文），依赖版本变化、`dsh.profile.bundles` 增删、新增的插件目录 |
| 点「重启 DSH」（DSH 空闲） | 直接派发重启，卡片变为「正在重启 DSH…」 |
| 点「重启 DSH」（DSH 正在工作） | 先弹确认框「DSH 正在工作 / 正在进行的任务会被中断」，**「是」为红色高亮**，点「是」才重启 |
| 点「稍后」 | 收起卡片；下一次变动会重新提示 |

## 重启怎么实现（全程无窗口）

两段 VBScript，由 **`wscript.exe`（GUI 子系统，启动时不分配控制台）** 承载 → WMI 派生 → `taskkill` 结束整套 DSH 进程 → 重新拉起外壳 exe。

```vbscript
' launcher.vbs —— 宿主同步执行（约 100ms，退出码 = WMI ReturnValue）
Set svc = GetObject("winmgmts:\\.\root\cimv2:Win32_Process")
rv = svc.Create("""C:\Windows\System32\wscript.exe"" //B //Nologo ""...\relaunch.vbs""")
WScript.Quit rv
```

```vbscript
' relaunch.vbs —— WMI 子进程执行（宿主被杀也不受影响）
WScript.Sleep 700
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Windows\System32\taskkill.exe"" /F /T /IM ""<外壳进程名>""", 0, True   ' 0 = 窗口隐藏
WScript.Sleep 1800
sh.Run """<DSH 外壳 exe>""", 1, False                                            ' 1 = 正常显示新窗口
```

关键决策：

| 决策 | 原因 |
|---|---|
| 用 `wscript.exe` 而不是 `powershell.exe` / `cmd.exe` | 后两者是控制台子系统程序，即使 `-WindowStyle Hidden` 也会先抢一个控制台窗口闪一下；`wscript` 是 GUI 子系统，从头到尾没有窗口 |
| 用 WMI `Win32_Process.Create` 派生 | 桌面壳把子进程收进 Job Object，宿主被杀时 detached 子进程会被连带终止；WMI 派生的进程挂在 `WmiPrvSE` 下，不受宿主 Job 管辖 |
| 一切走绝对路径 | 机器 PATH 里可能既没有 `pwsh` 也没有 `powershell`；`spawn` 失败只异步抛 `error`（`try/catch` 抓不到），曾表现为「点了只有动画」 |
| 失败要能看见 | 派发失败或 20 秒内未生效，卡片显示红色错误与「重试」；派发结果追加到 `$DSH_HOME/dsh-plugin-restart/relaunch.log` |

## 什么算「插件变动」

只有**插件身份**变化才提示重启，判定口径：

| 观测面 | 判定方式 |
|---|---|
| `package.json` | 只比 `dependencies` 与 `dsh.profile.bundles`，其它字段（`scripts`、`description`…）变了不算 |
| `cordis.yml` / `cordis.patch.yml` | 只比插件条目结构（`id` / `name` 行）；`config` 段改动不算 |
| `pnpm-lock.yaml` | 按 mtime / size 变化算（只有装包才会变） |
| `node_modules` | 比顶层包清单，忽略 `.开头的缓存目录` |

因此改推理等级、切模型、调主题这类只写 `config` 段的设置**不会**再弹重启卡片。

## 变动详情面板

- 差异来源：本次变动前后的 `package.json`、`cordis.yml`、`cordis.patch.yml`、`pnpm-workspace.yaml` 快照；cordis 层只保留 `id` / `name` 条目行，不贴 `config`。
- 行级 diff 为 LCS 实现，改动行上下各留 2 行上下文，其余折成「… 跳过 N 行」，单文件上限 400 行。
- 结构化摘要：依赖版本变化（`a 1.0.0 → 1.1.0`）、`dsh.profile.bundles` 增删、`node_modules` 里新增 / 移除的包。
- `pnpm-lock.yaml` 体积大，只标注「依赖锁已变化」，不做行级对比。
- 快照只在变动稳定后采集，不增加 1s 轮询的开销；内容不落盘。

## 安装

```sh
dsh plugin --profile desktop add dsh-plugin-restart-prompt
```

装好后重启 DSH 一次，插件开始工作；此后每次插件变动都由它提示重启。

本地开发（把源码目录 link 进去，改完即生效）：

```sh
cd ~/.dsh/profiles/desktop
# package.json: dependencies 增加 "dsh-plugin-restart-prompt": "link:/path/to/dsh-plugin-restart-prompt"
#              dsh.profile.bundles 末尾增加 "dsh-plugin-restart-prompt"
pnpm install
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-restart-prompt/state.json` | `{needRestart, busy, workingAgents, changes, changedAt, restartRequested}` |
| GET | `/dsh-restart-prompt/changes.json` | `{ok, at, changes, sections, profileDir}`，变动详情（只读） |
| POST | `/dsh-restart-prompt/restart.json` | 派发重启（仅回环 Host / 同源 Origin，否则 403） |
| POST | `/dsh-restart-prompt/dismiss.json` | 收起当前提示 |
| GET | `/dsh-restart-prompt/client.js` | 客户端脚本 |

客户端注入走两条通道：桌面端 `webserver/index-inject` 内联行、Web 形态 `webServer.tapIndex`。

## 隐私

只读 profile 目录下 4 个小配置文件的文本与 `node_modules` 的目录名，用于本地差异展示；不读取会话内容，不上传任何数据，不发起外部网络请求。

## 冒烟

```sh
node smoke.mjs           # 路由 / 注入行 / 变动监听 / 本机栅栏；不会真的重启
node smoke-changes.mjs   # 差异计算（构造快照）+ 真实 profile 快照采集
```

---

## English

Prompts you to restart DSH after a plugin change, then restarts it in one click — **silently, with no console window** — and can show you exactly what changed.

Windows only: the restart path is VBScript + WMI `Win32_Process.Create` + `taskkill`, so it needs `wscript.exe` and `System32\taskkill.exe`.

**What it does**

- Watches the profile's plugin manifest and dependency tree (`package.json`, `pnpm-lock.yaml`, `cordis*.yml`, `node_modules`). Once a change settles, a card appears in the bottom-right corner.
- **View changes** opens a panel with a per-file line diff, dependency version moves, additions to `dsh.profile.bundles`, and packages added to `node_modules`. `pnpm-lock.yaml` is reported as changed rather than diffed.
- **Restart DSH** dispatches the restart. If any agent is running, it first asks for confirmation — the **Yes** button is red-highlighted, because work in progress will be interrupted.
- **Later** hides the card; the next change prompts again.

**Why it is built this way**

`wscript.exe` is a GUI-subsystem binary, so unlike `powershell.exe` or `cmd.exe` it never flashes a console. The actual kill-and-relaunch runs under WMI rather than as a detached child, because the desktop shell puts its children in a Job Object — a detached child would die together with the host it is supposed to replace. Everything uses absolute paths, since PATH may contain neither `pwsh` nor `powershell`, and a failed `spawn` only raises an async `error` that `try/catch` never sees. Failures surface as a red message with a retry button and are appended to `$DSH_HOME/dsh-plugin-restart/relaunch.log`.

**Privacy**: reads four small config files in the profile plus the names of installed modules, for local display only. No session content, no network calls, nothing uploaded.
