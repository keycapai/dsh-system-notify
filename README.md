# dsh-system-notify

> 用**操作系统**通知你 agent 的状态。不在应用内弹任何浮层。

[![npm](https://img.shields.io/npm/v/dsh-system-notify.svg)](https://www.npmjs.com/package/dsh-system-notify)
[![license](https://img.shields.io/npm/l/dsh-system-notify.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-system-notify.svg)](./package.json)

agent 完成一轮回答、等待你审批、或子 agent 跑完时，直接由系统发桌面通知。
切到别的窗口干活也不会漏掉——**页面关掉照样通知**，因为通知根本不经过渲染进程。

## 为什么不用浏览器通知

页面里的 `window.Notification` 是 Chromium 的 Web API，它按 **app bundle 身份**向
`UNUserNotificationCenter` 申请授权；这道门属于 DSH 桌面端主进程，插件既不能触发也不能绕过，
被拒时会**静默丢弃**（不抛异常，所以看起来像"插件没生效"）。

而插件运行的 Host 进程是一个纯 Node 进程（`require('electron')` 在该进程直接 `MODULE_NOT_FOUND`），
拿不到 Electron 主进程的 `Notification` 类；主进程也没有开放通知类 IPC 通道。

所以唯一可用且可靠的通道是：**Host 调系统原生命令**。

## 通知内容

| 事件 | 标题 | 正文 |
|---|---|---|
| 主 agent 一轮结束 | 本轮回答已完成 | `会话名 · 用时 42s` |
| 子 agent 完成 | 子 agent 已完成 | `会话名 · 用时 1m 08s` |
| 等待审批 | 等待你的审批 | `会话名` |
| 等待回答 | 有一个问题等你回答 | `会话名` |

会话名来自 Host 的会话摘要（`api-session/added`）与重命名事件（`session/event`），
取不到时会自动省略，只显示用时。中英文随系统语言自动切换。

## 快速上手

```bash
npm install dsh-system-notify
```

装好后默认就会工作：一轮回答超过 **30 秒**才通知（短回答不打扰你），完成和等待类事件都开启。

想改行为，在你的 profile 的 `cordis.patch.yml` 里覆盖同 id 的行：

```yaml
- insert:
    - id: dsh-system-notify
      name: dsh-system-notify
      config:
        thresholdMs: 60000      # 只通知跑超过 1 分钟的回答
        subagentDone: true      # 子 agent 也通知
        sound: false            # 静音
```

## 配置字典

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。关掉后不注册任何监听。 |
| `turnDone` | boolean | `true` | 主 agent 一轮结束时通知。 |
| `needsYou` | boolean | `true` | 等待审批 / 等待回答时通知。 |
| `subagentDone` | boolean | `false` | 子 agent 完成时通知。默认关闭：子 agent 常常连着跑完，通知会刷屏。 |
| `thresholdMs` | number | `30000` | 只通知耗时超过此值的回答，单位毫秒。`0` 表示全部都通知。 |
| `sound` | boolean | `true` | 是否带提示音。 |
| `locale` | string | `auto` | `auto` / `zh` / `en`。`auto` 先读 macOS 的 `AppleLanguages`，再读 `LC_ALL`/`LANG`。 |
| `icon` | string | `''` | 自定义图标绝对路径。留空则用包内自带的 `icon.png`。 |
| `appName` | string | `DeepSeek Harness` | Linux 通知的应用名。 |

非布尔值不会被当成布尔值（`enabled: "yes"` 仍然取默认值），非法阈值回落到默认值——
配置写错不会让插件静默失效。

## 各平台的实际通道

| 平台 | 通道 | 图标 | 说明 |
|---|---|---|---|
| macOS | `terminal-notifier`（有则优先） | ✅ | 支持自定义图标 |
| macOS | `osascript`（内置回落） | ❌ | `display notification` 只能用宿主脚本的图标 |
| Linux | `notify-send` | ✅ | 需要 `libnotify-bin`；缺失时日志里说明一次 |
| Windows | WinRT Toast | ✅ | 走 `appLogoOverride` |
| Windows | 托盘气泡 | ❌ | Toast 需要注册 AppUserModelID，未注册时自动回落 |

macOS 上想要自定义图标，装一下 `terminal-notifier` 即可：

```bash
brew install terminal-notifier
```

## 开发

```bash
git clone https://github.com/keycapai/dsh-system-notify.git
cd dsh-system-notify
npm test
```

测试只覆盖纯函数那一半（时间格式化、占位符替换、三个平台的转义、配置归一化）——
真正会出错的地方就是这些转义，而它们不需要真的弹一个通知出来验证。

## 发布

发布由 tag 驱动，详见 [docs/RELEASING.md](./docs/RELEASING.md)。

## 许可证

[MIT](./LICENSE) © 2026 Keycap AI & Rentong Zhang
