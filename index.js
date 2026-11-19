/**
 * Host half: delivers turn notifications through the operating system itself.
 *
 * Why native: the Web Notification API in the renderer is served by Chromium and
 * gated by the Electron/UNUserNotificationCenter authorization of the app bundle.
 * A plugin cannot grant it, and a refusal is silent. Plugins run in a plain Node
 * process (`require('electron')` does not even resolve there), so Electron's
 * main-process `Notification` class is out of reach as well. Posting from the Host
 * through the platform's own notifier is the route that works everywhere and also
 * survives a closed page.
 *
 * Events (all Host-side, from the Event registry):
 *   - `agent/status` (`idle` after `running`)  -> a turn finished
 *   - `approval/request` / `user-questions/request` -> waiting for the user
 *   - `subagent/start` + `agent/status`        -> a child session finished
 *   - `api-session/added` / `session/event`    -> session display names
 *
 * Settings come from this row's `config` in `cordis.patch.yml`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM = process.platform;
const LOG = '[dsh-system-notify]';
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  enabled: true,
  turnDone: true,
  needsYou: true,
  subagentDone: false,
  thresholdMs: 30000,
  sound: true,
  locale: 'auto',
  icon: '',
  appName: 'DeepSeek Harness',
};

export const TEXTS = {
  zh: {
    turn: '本轮回答已完成',
    subagent: '子 agent 已完成',
    approval: '等待你的审批',
    question: '有一个问题等你回答',
    elapsed: '用时 {time}',
  },
  en: {
    turn: 'Turn finished',
    subagent: 'Subagent finished',
    approval: 'Waiting for your approval',
    question: 'A question is waiting for your answer',
    elapsed: 'took {time}',
  },
};

function log(...args) {
  try {
    console.info(LOG, ...args);
  } catch (error) {
    /* logging is optional */
  }
}

function which(command) {
  try {
    const probe = spawnSync(PLATFORM === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' });
    return probe.status === 0;
  } catch (error) {
    return false;
  }
}

/**
 * Resolve `auto` from the preference the user actually sees: the bundle's
 * language list first (that is what the Desktop window renders in), then the
 * POSIX locale environment.
 */
function detectLocale() {
  try {
    if (PLATFORM === 'darwin') {
      const probe = spawnSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8' });
      const first = (probe.stdout || '').match(/"([^"]+)"/);
      if (first && first[1]) return /^zh/i.test(first[1]) ? 'zh' : 'en';
    }
  } catch (error) {
    /* fall through */
  }
  try {
    const guess = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
    if (guess) return /^zh/i.test(guess) ? 'zh' : 'en';
  } catch (error) {
    /* fall through */
  }
  return 'en';
}

export function resolveLocale(config) {
  // 'config' is whatever the patch layer produced; a row with no config at
  // all must fall back to detection rather than throw on a property read.
  const raw = config && typeof config === 'object' ? config.locale : undefined;
  const wanted = typeof raw === 'string' ? raw.trim().toLowerCase() : 'auto';
  if (wanted === 'zh' || wanted.startsWith('zh-')) return 'zh';
  if (wanted === 'en' || wanted.startsWith('en-')) return 'en';
  return detectLocale();
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function interpolate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    values[key] === undefined ? match : String(values[key]),
  );
}

/** AppleScript string literals only need backslash and quote escaping. */
export function escapeApple(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** PowerShell single-quoted literals escape a quote by doubling it. */
export function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function run(command, args) {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', (error) => log('spawn failed:', command, error && error.message));
    child.unref();
    return true;
  } catch (error) {
    log('spawn threw:', command, error && error.message);
    return false;
  }
}

/** Resolved at startup so a missing helper is reported once, not per turn. */
const CAPS = {
  terminalNotifier: PLATFORM === 'darwin' ? which('terminal-notifier') : false,
  notifySend: PLATFORM === 'linux' ? which('notify-send') : false,
  powershell: PLATFORM === 'win32' ? which('powershell') || which('pwsh') : false,
};

export function windowsToastScript(title, body, iconPath) {
  const lines = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    '  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '  [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
  ];
  const image = iconPath
    ? `<image placement="appLogoOverride" hint-crop="circle" src="file:///${iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}"/>`
    : '';
  const xml =
    `<toast><visual><binding template="ToastGeneric">` +
    `<text>${escapeXml(title)}</text><text>${escapeXml(body)}</text>${image}` +
    `</binding></visual></toast>`;
  lines.push(
    '  $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()',
    `  $xml.LoadXml('${escapePowerShell(xml)}')`,
    '  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("DeepSeek.Harness").Show($toast)',
    '} catch {}',
  );
  return lines.join('; ');
}

/** Toast needs a registered AppUserModelID; the tray balloon does not. */
export function windowsBalloonScript(title, body) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon = [System.Drawing.SystemIcons]::Information',
    '$n.Visible = $true',
    `$n.ShowBalloonTip(6000, '${escapePowerShell(title)}', '${escapePowerShell(body)}', [System.Windows.Forms.ToolTipIcon]::Info)`,
    'Start-Sleep -Milliseconds 6500',
    '$n.Dispose()',
  ].join('; ');
}

/**
 * Post one banner. Returns the adapter used, or null when the platform has no
 * reachable notifier.
 */
function postNative(options) {
  const { title, body, sound, iconPath } = options;

  if (PLATFORM === 'darwin') {
    // `display notification` always shows the host script's icon, so a custom
    // icon is only possible through terminal-notifier when it is installed.
    if (CAPS.terminalNotifier) {
      const args = ['-title', title, '-message', body];
      if (iconPath) args.push('-appIcon', iconPath);
      run('terminal-notifier', args);
      return 'terminal-notifier';
    }
    const soundArg = sound ? ' sound name "Ping"' : '';
    run('osascript', ['-e', `display notification "${escapeApple(body)}" with title "${escapeApple(title)}"${soundArg}`]);
    return 'osascript';
  }

  if (PLATFORM === 'linux') {
    if (!CAPS.notifySend) {
      log('notify-send missing; install libnotify-bin for desktop notifications');
      return null;
    }
    const args = ['-a', options.appName || DEFAULTS.appName, '-u', 'normal'];
    if (iconPath) args.push('-i', iconPath);
    args.push(title, body);
    run('notify-send', args);
    return 'notify-send';
  }

  if (PLATFORM === 'win32') {
    const shell = which('pwsh') ? 'pwsh' : 'powershell';
    if (!CAPS.powershell) {
      log('PowerShell missing; no native toast channel');
      return null;
    }
    run(shell, ['-NoProfile', '-NonInteractive', '-Command', windowsToastScript(title, body, iconPath)]);
    // The WinRT toast depends on a registered AppUserModelID; the balloon is the
    // fallback when nothing appears.
    run(shell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', windowsBalloonScript(title, body)]);
    return 'powershell';
  }

  log('unsupported platform:', PLATFORM);
  return null;
}

export function readSettings(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const threshold = Number(raw.thresholdMs);
  const guessedIcon = path.join(PKG_DIR, 'icon.png');
  const icon = typeof raw.icon === 'string' && raw.icon.trim() !== ''
    ? (path.isAbsolute(raw.icon) ? raw.icon : path.join(PKG_DIR, raw.icon))
    : guessedIcon;
  return {
    enabled: bool(raw.enabled, DEFAULTS.enabled),
    turnDone: bool(raw.turnDone, DEFAULTS.turnDone),
    needsYou: bool(raw.needsYou, DEFAULTS.needsYou),
    subagentDone: bool(raw.subagentDone, DEFAULTS.subagentDone),
    sound: bool(raw.sound, DEFAULTS.sound),
    thresholdMs: Number.isFinite(threshold) && threshold >= 0 ? Math.round(threshold) : DEFAULTS.thresholdMs,
    appName: typeof raw.appName === 'string' && raw.appName !== '' ? raw.appName : DEFAULTS.appName,
    locale: resolveLocale(raw),
    iconPath: existsSync(icon) ? icon : undefined,
  };
}

/** Best-effort identity of a published child from an unknown payload shape. */
function childIdOf(info) {
  if (!info || typeof info !== 'object') return undefined;
  const direct = info.childSessionId ?? info.childId ?? info.sessionId ?? info.id;
  if (direct !== undefined && direct !== null) return String(direct);
  const nested = info.child ?? info.agent ?? info.session;
  const nestedId = nested && (nested.sessionId ?? nested.id);
  return nestedId === undefined || nestedId === null ? undefined : String(nestedId);
}

function sessionIdOf(agent) {
  if (!agent || typeof agent !== 'object') return undefined;
  const id = agent.sessionId ?? agent.id;
  return id === undefined || id === null ? undefined : String(id);
}

export function apply(ctx, config) {
  const settings = readSettings(config);
  if (!settings.enabled) {
    log('disabled by config');
    return;
  }

  const texts = TEXTS[settings.locale] || TEXTS.en;
  const titles = new Map();
  const runningSince = new Map();
  const children = new Set();
  let lastNeedsYouAt = 0;

  const sessionName = (sessionId) => {
    const title = sessionId === undefined ? undefined : titles.get(sessionId);
    if (typeof title === 'string' && title.trim() !== '') return title.trim();
    return '';
  };

  const send = (title, sessionId, detail) => {
    const name = sessionName(sessionId);
    const body = name && detail ? `${name} · ${detail}` : name || detail || '';
    return postNative({
      title,
      body,
      sound: settings.sound,
      iconPath: settings.iconPath,
      appName: settings.appName,
    });
  };

  const remember = (summary) => {
    if (!summary || typeof summary !== 'object') return;
    const id = summary.id ?? summary.sessionId;
    const title = summary.title ?? summary.name ?? summary.displayTitle;
    if (id === undefined || id === null) return;
    if (typeof title === 'string' && title.trim() !== '') titles.set(String(id), title.trim());
  };

  ctx.effect(() => {
    const disposers = [
      // Session display names, so a banner can say which session it is about.
      ctx.on('api-session/added', (summary) => remember(summary)),

      // A renamed session keeps its new title; the durable event carries it.
      ctx.on('session/event', (session, event) => {
        if (!event || typeof event !== 'object') return;
        if (event.type !== 'session/title' && event.type !== 'session/renamed') return;
        const id = sessionIdOf(session);
        const title = event.title ?? (event.data && event.data.title);
        if (id !== undefined && typeof title === 'string' && title.trim() !== '') {
          titles.set(id, title.trim());
        }
      }),

      // A turn finished: `running` opened the window, `idle` closes it.
      ctx.on('agent/status', (payload) => {
        const sessionId = sessionIdOf(payload && payload.agent);
        if (sessionId === undefined) return;
        if (payload.status === 'running') {
          if (!runningSince.has(sessionId)) runningSince.set(sessionId, Date.now());
          return;
        }
        if (payload.status !== 'idle') return;
        const startedAt = runningSince.get(sessionId);
        if (startedAt === undefined) return;
        runningSince.delete(sessionId);
        const elapsedMs = Date.now() - startedAt;
        const isChild = children.has(sessionId);
        if (isChild ? !settings.subagentDone : !settings.turnDone) return;
        if (elapsedMs < settings.thresholdMs) {
          log('skipped below threshold:', formatElapsed(elapsedMs));
          return;
        }
        const detail = interpolate(texts.elapsed, { time: formatElapsed(elapsedMs) });
        const used = send(isChild ? texts.subagent : texts.turn, sessionId, detail);
        log('notified', isChild ? 'subagent' : 'turn', formatElapsed(elapsedMs), 'via', used);
      }),

      // A published child settled: remember which sessions are children.
      ctx.on('subagent/start', (info) => {
        const id = childIdOf(info);
        if (id !== undefined) children.add(id);
      }),

      // The agent is blocked on a human decision. Waterfall: always continue.
      ctx.on('approval/request', (request, next) => {
        const now = Date.now();
        if (settings.needsYou && now - lastNeedsYouAt > 3000) {
          lastNeedsYouAt = now;
          const sessionId = sessionIdOf(request && request.agent);
          log('notified approval request via', send(texts.approval, sessionId, ''));
        }
        return next();
      }),
      ctx.on('user-questions/request', (request, next) => {
        const now = Date.now();
        if (settings.needsYou && now - lastNeedsYouAt > 3000) {
          lastNeedsYouAt = now;
          const sessionId = sessionIdOf(request && request.agent);
          log('notified question request via', send(texts.question, sessionId, ''));
        }
        return next();
      }),
    ];
    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose();
      }
    };
  }, 'dsh-system-notify: notifications');

  log(
    'ready',
    '| platform', PLATFORM,
    '| locale', settings.locale,
    '| icon', settings.iconPath || 'none',
    '| threshold', formatElapsed(settings.thresholdMs),
    '| caps', JSON.stringify(CAPS),
  );
}
