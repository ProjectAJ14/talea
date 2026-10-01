// theme.js decides colour once, at load, from the environment. Each gate is
// exercised by loading a fresh copy of the module under that environment.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test, { describe } from 'node:test';

import * as t from '../src/theme.js';

const THEME = new URL('../src/theme.js', import.meta.url).href;
const KEYS = ['NO_COLOR', 'TERM', 'FORCE_COLOR', 'COLORTERM'];

/**
 * What theme.js paints when loaded under `env`, with stdout.isTTY forced to
 * `tty`. A child process rather than a cache-busted import: the gates are read
 * once at load, and coverage only merges runs of the file under its own URL.
 */
function themeWith(env, tty = false) {
  const script = `
    Object.defineProperty(process.stdout, 'isTTY', { value: ${tty} });
    const t = await import(${JSON.stringify(THEME)});
    console.log(JSON.stringify({
      useColor: t.useColor,
      ok: t.paint.ok('x'), aged: t.paint.aged('x'), fail: t.paint.fail('x'),
      faint: t.paint.faint('x'), warn: t.paint.warn('x'), bone: t.paint.bone('x'),
      bold: t.bold('b'), dim: t.dim('d'), cut: t.truncVisible('abcdef', 3),
    }));`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !KEYS.includes(k)));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

describe('colour gating', () => {
  test('NO_COLOR turns every paint into plain text, even when forced', () => {
    const r = themeWith({ NO_COLOR: '1', FORCE_COLOR: '1' }, true);
    assert.equal(r.useColor, false);
    assert.equal(r.ok, 'x');
    assert.equal(r.bold, 'b');
    assert.equal(r.dim, 'd');
    // Cut with colour off: nothing to close.
    assert.equal(r.cut, 'abc');
  });

  test('TERM=dumb is colourless too', () => {
    assert.equal(themeWith({ TERM: 'dumb' }, true).useColor, false);
  });

  test('FORCE_COLOR without COLORTERM uses the basic-16 code, closed with 39', () => {
    const r = themeWith({ FORCE_COLOR: '1' });
    assert.equal(r.useColor, true);
    assert.equal(r.ok, '\x1b[96mx\x1b[39m');
    assert.equal(r.fail, '\x1b[31mx\x1b[39m');
    assert.equal(r.faint, '\x1b[90mx\x1b[39m');
    assert.equal(r.bold, '\x1b[1mb\x1b[22m');
    assert.equal(r.dim, '\x1b[2md\x1b[22m');
    assert.equal(r.cut, 'abc\x1b[0m');
  });

  test('COLORTERM=truecolor uses the verdigris hex, closed with 39', () => {
    const r = themeWith({ FORCE_COLOR: '1', COLORTERM: 'truecolor' });
    // --vd-300 #79D5C4
    assert.equal(r.ok, '\x1b[38;2;121;213;196mx\x1b[39m');
    for (const role of ['aged', 'faint', 'warn', 'fail', 'bone']) {
      assert.match(r[role], /^\x1b\[38;2;\d+;\d+;\d+mx\x1b\[39m$/);
    }
  });

  test('an unrecognised COLORTERM is not truecolor', () => {
    assert.equal(themeWith({ FORCE_COLOR: '1', COLORTERM: 'yes' }).aged, '\x1b[36mx\x1b[39m');
  });

  test('with no overrides, colour follows the terminal', () => {
    assert.equal(themeWith({}, true).useColor, true);
    assert.equal(themeWith({}, false).useColor, false);
  });
});

describe('width maths', () => {
  const red = '\x1b[31mab\x1b[39m';

  test('pads, centres and measures by visible width', () => {
    assert.equal(t.visibleWidth(red), 2);
    assert.equal(t.stripAnsi(red), 'ab');
    assert.equal(t.padEndVisible(red, 4), red + '  ');
    assert.equal(t.padEndVisible('abc', 2), 'abc');
    assert.equal(t.padStartVisible(red, 4), '  ' + red);
    assert.equal(t.padStartVisible(5, 1), '5');
    assert.equal(t.centerVisible('ab', 5), ' ab  ');
    assert.equal(t.centerVisible(12, 1), '12');
  });

  test('ansi.up climbs only a positive count', () => {
    assert.equal(t.ansi.up(), '\x1b[1A');
    assert.equal(t.ansi.up(3), '\x1b[3A');
    assert.equal(t.ansi.up(0), '');
  });

  test('columns clamps the window to 40..120, defaulting to 80', () => {
    const desc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const set = (v) => Object.defineProperty(process.stdout, 'columns', { value: v, configurable: true });
    try {
      set(undefined);
      assert.equal(t.columns(), 80);
      set(10);
      assert.equal(t.columns(), 40);
      set(500);
      assert.equal(t.columns(), 120);
    } finally {
      if (desc) Object.defineProperty(process.stdout, 'columns', desc);
      else delete process.stdout.columns;
    }
  });

  test('truncVisible keeps escapes, cuts text, and closes the colour', () => {
    const close = t.useColor ? '\x1b[0m' : '';
    assert.equal(t.truncVisible('abc', 0), '');
    assert.equal(t.truncVisible('abc', 5), 'abc');
    // A leading escape (an empty split part), a part that fits, one that is cut.
    assert.equal(t.truncVisible(`${red}cdef`, 4), `${red}cd${close}`);
    // Past the cut, text is dropped but later escapes are kept.
    assert.equal(t.truncVisible('abcd\x1b[1mef', 2), `ab\x1b[1m${close}`);
  });

  test('glyphs, spinner and box are plain strings', () => {
    for (const g of [...Object.values(t.glyph), ...t.spinner, ...Object.values(t.box)]) {
      assert.equal(typeof g, 'string');
    }
  });
});
