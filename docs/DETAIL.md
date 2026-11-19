# Dsh SystemNotify

agent 完成一轮回答、等待你介入、或子 agent 完成时，由**操作系统**发出桌面通知。不在应用内弹任何浮层。

## 为什么不用浏览器通知

页面里的 `window.Notification` 是 Chromium 的 Web API，它按 **app bundle 身份**向 `UNUserNotificationCenter` 申请授权；这道门属于 DSH 桌面端主进程，插件既不能触发也不能绕过，被拒时会**静默丢弃**（不抛异常）。

而插件运行的 Host 进程是一个纯 Node 进程（`require('electron')` 在该进程直接 `MODULE_NOT_FOUND`），拿不到 Electron 主进程的 `Notification` 类；主进程也没有开放通知类 IPC 通道。所以唯一可用且可靠的通道是：**Host 调系统原生命令**。顺带的好处是页面关掉也能通知。

## 通知内容

| 事件 | 标题 | 正文 |
|---|---|---|
| 主 agent 一轮结束 | 本轮回答已完成 | `会话名 · 用时 42s` |
| 子 agent 完成 | 子 agent 已完成 | `会话名 · 用时 1m 08s` |
| 等待审批 | 等待你的审批 | `会话名` |
| 等待回答 | 有一个问题等你回答 | `会话名` |

会话名来自 Host 的会话摘要（`api-session/added`）与重命名事件（`session/event`），取不到时会自动省略，只显示用时。

## 图标

包内自带 `icon.svg`，另附 256px 的 `icon.png`（由 SVG 生成）。各平台的现实情况不同：

| 平台 | 图标 | 说明 |
|---|---|---|
| Linux | ✅ 支持 | `notify-send -i <png>` |
| Windows | ✅ 支持 | Toast XML 的 `appLogoOverride`；未注册 AppUserModelID 时回落到托盘气泡（系统图标） |
| macOS | ⚠️ 有条件 | `osascript display notification` **无法指定图标**（永远显示脚本宿主图标）。装了 `terminal-notifier` 时自动改用它并加 `-appIcon`，此时图标生效 |

想要 macOS 上也显示自定义图标：

```sh
brew install terminal-notifier
```

插件启动时会探测该命令，存在即启用，无需改配置。

## 本地化

宿主侧没有 locale 服务，所以插件自带中英词典，并按顺序解析语言：

1. 配置项 `locale`：`zh` / `en` 显式指定时优先
2. macOS：`defaults read -g AppleLanguages` 的首选语言（与桌面窗口一致）
3. POSIX 环境变量 `LC_ALL` / `LC_MESSAGES` / `LANG`
4. 兜底 `en`

```yaml
locale: auto   # 或 zh / en
```

耗时格式不随语言变化（`42s` / `1m 08s`），由短语模板包起来，所以中文是「用时 42s」、英文是「took 42s」。

## 跨平台适配

| 平台 | 投递方式 | 声音 |
|---|---|---|
| macOS | `osascript`（默认）/ `terminal-notifier`（装了则优先） | `sound name "Ping"`，可关 |
| Linux | `notify-send -a … -u normal -i …` | 由桌面环境决定；`notify-send` 缺失时记录日志并跳过 |
| Windows | PowerShell WinRT Toast，附托盘气泡兜底 | 系统默认 |
| 其他 | 记录日志并跳过 | — |

启动时会打印一行能力快照，便于排查：

```
[dsh-system-notify] ready | platform darwin | locale zh | icon /…/icon.png | threshold 30s | caps {"terminalNotifier":false,"notifySend":false,"powershell":false}
```

## 配置

全部集中在插件行的 `config` 里（`~/.dsh/profiles/desktop/cordis.patch.yml` 中由 bundle 提供的行，或直接改包内 `cordis.patch.yml`）：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | true | 总开关 |
| `turnDone` | true | 主 agent 一轮结束提醒 |
| `needsYou` | true | 等待审批 / 回答时提醒（不受阈值限制） |
| `subagentDone` | false | 子 agent 完成提醒 |
| `thresholdMs` | 30000 | 低于此时长不提醒；`0` 表示每轮都提醒 |
| `sound` | true | 是否带提示音（macOS 生效） |
| `locale` | auto | `auto` / `zh` / `en` |
| `icon` | 包内 icon.png | 自定义图标路径（绝对路径或包内相对路径） |
| `appName` | DeepSeek Harness | Linux 通知的来源名 |

## 事件来源

| 事件 | Host 事件 |
|---|---|
| 一轮结束 | `agent/status`：`running` → `idle`，插件记录起止时间 |
| 子 agent 完成 | `subagent/start` 标记子会话 + `agent/status` 结算 |
| 等待审批 | `approval/request`（waterfall 监听，始终 `return next()`） |
| 等待回答 | `user-questions/request`（同上） |
| 会话名 | `api-session/added`、`session/event` |

## 已知限制

- macOS 原生脚本通道无法设置图标（见上文，可用 `terminal-notifier` 补足）。
- Windows 的 WinRT Toast 需要已注册的 AppUserModelID；缺失时只能回落到托盘气泡，样式由系统决定。
- Linux 需要 `libnotify-bin`；纯 CLI 环境没有通知守护进程时不会显示。
- 会话名依赖会话摘要缓存；插件在某个会话已存在之后才加载时，该会话在被再次公告前的通知会省略会话名。
- 修改 Host 插件后需要**重启应用**（不是刷新页面）才会加载新的模块。
