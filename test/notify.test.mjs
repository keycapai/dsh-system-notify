/**
 * Unit tests for the pure half of dsh-system-notify.
 *
 * Nothing here posts a real banner: the platform adapters are exercised through
 * the strings they build, which is where the escaping bugs live. The one thing
 * that IS asserted about delivery is the contract that matters — a platform with
 * no reachable notifier returns null instead of throwing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULTS,
  TEXTS,
  escapeApple,
  escapePowerShell,
  escapeXml,
  formatElapsed,
  interpolate,
  readSettings,
  resolveLocale,
  windowsBalloonScript,
  windowsToastScript,
} from '../index.js';

test('formatElapsed renders seconds and padded minutes', async (t) => {
  await t.test('sub-minute stays in seconds', () => {
    assert.equal(formatElapsed(0), '0s');
    assert.equal(formatElapsed(999), '1s');
    assert.equal(formatElapsed(42_000), '42s');
    assert.equal(formatElapsed(59_400), '59s');
  });

  await t.test('a full minute rolls over and pads the seconds', () => {
    assert.equal(formatElapsed(60_000), '1m 00s');
    assert.equal(formatElapsed(68_000), '1m 08s');
    assert.equal(formatElapsed(3_600_000), '60m 00s');
  });

  await t.test('negative input clamps instead of rendering a minus sign', () => {
    assert.equal(formatElapsed(-1), '0s');
    assert.equal(formatElapsed(-90_000), '0s');
  });
});

test('interpolate substitutes only known placeholders', async (t) => {
  await t.test('replaces a named slot', () => {
    assert.equal(interpolate('took {time}', { time: '42s' }), 'took 42s');
  });

  await t.test('leaves an unknown slot verbatim', () => {
    assert.equal(interpolate('took {time}', {}), 'took {time}');
  });

  await t.test('replaces every occurrence', () => {
    assert.equal(interpolate('{a}-{a}-{b}', { a: 'x', b: 'y' }), 'x-x-y');
  });

  await t.test('stringifies non-string values', () => {
    assert.equal(interpolate('{n}', { n: 7 }), '7');
  });
});

test('escapeApple protects backslashes and double quotes', () => {
  assert.equal(escapeApple('plain'), 'plain');
  assert.equal(escapeApple('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapeApple('back\\slash'), 'back\\\\slash');
});

test('escapePowerShell doubles single quotes', () => {
  assert.equal(escapePowerShell('plain'), 'plain');
  assert.equal(escapePowerShell("it's"), "it''s");
});

test('escapeXml escapes the four significant characters', () => {
  assert.equal(escapeXml('a & b'), 'a &amp; b');
  assert.equal(escapeXml('<t>'), '&lt;t&gt;');
  assert.equal(escapeXml('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(escapeXml('clean'), 'clean');
});

test('resolveLocale honours an explicit preference over detection', () => {
  assert.equal(resolveLocale({ locale: 'zh' }), 'zh');
  assert.equal(resolveLocale({ locale: 'zh-CN' }), 'zh');
  assert.equal(resolveLocale({ locale: 'en' }), 'en');
  assert.equal(resolveLocale({ locale: 'en-US' }), 'en');
  assert.equal(resolveLocale({ locale: 'ZH' }), 'zh');
});

test('resolveLocale falls back to a real language for auto or garbage', () => {
  for (const config of [{}, { locale: 'auto' }, { locale: 42 }, { locale: '' }, null]) {
    const resolved = resolveLocale(config);
    assert.ok(resolved === 'zh' || resolved === 'en', 'got ' + resolved);
  }
});

test('TEXTS carries both locales with the same key set', () => {
  assert.deepEqual(Object.keys(TEXTS.zh).sort(), Object.keys(TEXTS.en).sort());
  for (const key of ['turn', 'subagent', 'approval', 'question', 'elapsed']) {
    assert.ok(TEXTS.zh[key].length > 0, 'zh.' + key);
    assert.ok(TEXTS.en[key].length > 0, 'en.' + key);
  }
});

test('readSettings applies every default to an empty config', () => {
  const settings = readSettings({});
  assert.equal(settings.enabled, DEFAULTS.enabled);
  assert.equal(settings.turnDone, DEFAULTS.turnDone);
  assert.equal(settings.needsYou, DEFAULTS.needsYou);
  assert.equal(settings.subagentDone, DEFAULTS.subagentDone);
  assert.equal(settings.thresholdMs, DEFAULTS.thresholdMs);
  assert.equal(settings.sound, DEFAULTS.sound);
  assert.equal(settings.appName, DEFAULTS.appName);
});

test('readSettings survives a hostile config', () => {
  for (const config of [null, undefined, 42, 'nope', []]) {
    const settings = readSettings(config);
    assert.equal(settings.thresholdMs, DEFAULTS.thresholdMs);
    assert.equal(settings.enabled, DEFAULTS.enabled);
  }
});

test('readSettings only accepts booleans for switches', () => {
  const settings = readSettings({ enabled: 'yes', sound: 1, turnDone: false });
  assert.equal(settings.enabled, DEFAULTS.enabled, 'a string is not a boolean');
  assert.equal(settings.sound, DEFAULTS.sound, 'a number is not a boolean');
  assert.equal(settings.turnDone, false, 'an explicit false is honoured');
});

test('readSettings rejects a nonsensical threshold', () => {
  assert.equal(readSettings({ thresholdMs: 'soon' }).thresholdMs, DEFAULTS.thresholdMs);
  assert.equal(readSettings({ thresholdMs: -5 }).thresholdMs, DEFAULTS.thresholdMs);
  assert.equal(readSettings({ thresholdMs: Number.NaN }).thresholdMs, DEFAULTS.thresholdMs);
  assert.equal(readSettings({ thresholdMs: 5000 }).thresholdMs, 5000);
  assert.equal(readSettings({ thresholdMs: 0 }).thresholdMs, 0, '0 is a real choice');
});

test('windowsToastScript builds a toast payload', () => {
  const script = windowsToastScript('Title', 'Body', null);
  assert.match(script, /ToastNotificationManager/);
  assert.ok(script.includes('<text>Title</text>'));
  assert.ok(script.includes('<text>Body</text>'));
  assert.ok(!script.includes('appLogoOverride'), 'no icon requested, no image node');
});

test('windowsToastScript escapes hostile text into the XML payload', () => {
  const script = windowsToastScript('a<b', 'c & d', null);
  assert.ok(script.includes('&lt;b'));
  assert.ok(script.includes('c &amp; d'));
  assert.ok(!script.includes('<text>a<b</text>'));
});

test('windowsToastScript embeds a requested icon as a file URL', () => {
  const script = windowsToastScript('T', 'B', 'C:\\icons\\a b.png');
  assert.ok(script.includes('appLogoOverride'));
  assert.ok(script.includes('file:///'));
  assert.ok(script.includes('a%20b.png'), 'spaces must be percent-encoded');
});

test('windowsBalloonScript stays a single-quoted PowerShell string', () => {
  const script = windowsBalloonScript("it's", 'body');
  assert.match(script, /ShowBalloonTip/);
  assert.ok(script.includes("it''s"), 'the apostrophe is doubled, not escaped with a backslash');
});
