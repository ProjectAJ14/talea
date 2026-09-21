// The selection tree. Pure state, no terminal: this is why the checkbox logic
// can be trusted without a human driving it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyKey,
  applyNames,
  buildTree,
  groupState,
  renderRow,
  selectedRepos,
  setAll,
  splitKeys,
  toggle,
} from '../src/prompt.js';

const ESC = '\u001b';

const MANIFEST = {
  groups: {
    V1: { dir: 'V1', title: 'Legacy' },
    V2: { dir: 'V2', title: 'Current' },
    them: { dir: "them", title: "their org" },
  },
  repos: [
    // Deliberately out of group order — the tree must follow the catalogue.
    { name: 'oip-mono', group: 'them' },
    { name: 'cep-be', group: 'V2' },
    { name: 'ordering', group: 'V1' },
    { name: 'ordering-api', group: 'V1' },
    { name: 'cep-ui', group: 'V2' },
  ],
};

const rowFor = (rows, label) => rows.findIndex((r) => r.label === label);
const names = (rows) => selectedRepos(rows).map((r) => r.name).sort();

describe('building the tree', () => {
  test('groups come in catalogue order, each followed by its repos', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    assert.deepEqual(
      rows.map((r) => `${r.kind === 'group' ? '#' : '-'}${r.label}`),
      ['#V1', '-ordering', '-ordering-api', '#V2', '-cep-be', '-cep-ui', '#them', '-oip-mono'],
    );
  });

  test('a group with no selected repos is omitted entirely', () => {
    const rows = buildTree(MANIFEST, [{ name: 'cep-be', group: 'V2' }], false);
    assert.deepEqual(rows.map((r) => r.label), ['V2', 'cep-be']);
  });

  test('the tree can start fully selected or fully empty', () => {
    assert.equal(selectedRepos(buildTree(MANIFEST, MANIFEST.repos, true)).length, 5);
    assert.equal(selectedRepos(buildTree(MANIFEST, MANIFEST.repos, false)).length, 0);
  });
});

describe('toggling', () => {
  test('a repo row toggles only itself', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    toggle(rows, rowFor(rows, 'cep-be'));
    assert.deepEqual(names(rows), ['cep-be']);
    toggle(rows, rowFor(rows, 'cep-be'));
    assert.deepEqual(names(rows), []);
  });

  test('a group row takes every repo in that group and nothing else', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    toggle(rows, rowFor(rows, 'V1'));
    assert.deepEqual(names(rows), ['ordering', 'ordering-api']);
    assert.equal(groupState(rows, 'V1'), 'all');
    assert.equal(groupState(rows, 'V2'), 'none');
  });

  test('a fully selected group empties on the next press', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, true);
    toggle(rows, rowFor(rows, 'V1'));
    assert.deepEqual(names(rows), ['cep-be', 'cep-ui', 'oip-mono']);
  });

  test('a partly selected group fills up rather than emptying', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    toggle(rows, rowFor(rows, 'ordering'));
    assert.equal(groupState(rows, 'V1'), 'some');
    toggle(rows, rowFor(rows, 'V1'));
    assert.equal(groupState(rows, 'V1'), 'all', 'pressing a half-full group must complete it');
  });

  test('a group with one repo of two selected reports "some"', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    toggle(rows, rowFor(rows, 'cep-ui'));
    assert.equal(groupState(rows, 'V2'), 'some');
  });

  test('select-all and select-none touch repos only, never group rows', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    setAll(rows, true);
    assert.equal(selectedRepos(rows).length, 5);
    setAll(rows, false);
    assert.equal(selectedRepos(rows).length, 0);
    assert.ok(rows.filter((r) => r.kind === 'group').every((r) => r.checked === undefined));
  });

  test('an out-of-range index is a no-op, not a crash', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    toggle(rows, 999);
    assert.deepEqual(names(rows), []);
  });
});

describe('typed names (the no-raw-mode path)', () => {
  test('a group name selects its repos, a repo name selects just that repo', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    const { picked, unknown } = applyNames(rows, ['V1', 'cep-ui']);
    assert.deepEqual(picked.map((r) => r.name).sort(), ['cep-ui', 'ordering', 'ordering-api']);
    assert.deepEqual(unknown, []);
  });

  test('names are matched case-insensitively and trimmed', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    const { picked } = applyNames(rows, ['  v2 ', 'OIP-MONO']);
    assert.deepEqual(picked.map((r) => r.name).sort(), ['cep-be', 'cep-ui', 'oip-mono']);
  });

  test('a typo is reported rather than silently selecting nothing', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    const { picked, unknown } = applyNames(rows, ['V1', 'cep-uiii']);
    assert.deepEqual(unknown, ['cep-uiii']);
    assert.equal(picked.length, 2, 'the valid part of the selection still resolves');
  });
});

describe('rendering', () => {
  test('the group marker shows all / some / none', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    const i = rowFor(rows, 'V1');
    assert.match(renderRow(rows, i, 0), /◻/);
    toggle(rows, rowFor(rows, 'ordering'));
    assert.match(renderRow(rows, i, 0), /◐/);
    toggle(rows, rowFor(rows, 'ordering-api'));
    assert.match(renderRow(rows, i, 0), /◼/);
  });

  test('the cursor row is the only one with a pointer', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    assert.match(renderRow(rows, 1, 1), /❯/);
    assert.doesNotMatch(renderRow(rows, 2, 1), /❯/);
  });
});

describe('keyboard input', () => {
  // stdin hands over everything that arrived since the last read, so several
  // keypresses regularly land in one chunk. Comparing the whole chunk against a
  // single key drops them all — this shipped broken once and hung the picker.
  test('a chunk holding several keypresses is split into each one', () => {
    assert.deepEqual(splitKeys(`${ESC}[A ${ESC}[B${ESC}[B\r`), [
      `${ESC}[A`,
      ' ',
      `${ESC}[B`,
      `${ESC}[B`,
      '\r',
    ]);
  });

  test('a lone escape stays a lone escape, so it can still cancel', () => {
    assert.deepEqual(splitKeys(ESC), [ESC]);
  });

  test('application-mode arrows are recognised too', () => {
    assert.deepEqual(splitKeys(`${ESC}OA${ESC}OB`), [`${ESC}OA`, `${ESC}OB`]);
  });

  test('page keys keep their trailing tilde', () => {
    assert.deepEqual(splitKeys(`${ESC}[5~${ESC}[6~`), [`${ESC}[5~`, `${ESC}[6~`]);
  });

  test('plain characters pass through one at a time', () => {
    assert.deepEqual(splitKeys('anq'), ['a', 'n', 'q']);
  });

  test('enter confirms, q and ctrl-c and escape all cancel', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    assert.equal(applyKey(rows, '\r', 0, 5).action, 'confirm');
    for (const key of ['q', '\u0003', ESC]) {
      assert.equal(applyKey(rows, key, 0, 5).action, 'cancel', key);
    }
  });

  test('the cursor never leaves the list', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    assert.equal(applyKey(rows, 'k', 0, 5).cursor, 0, 'cannot go above the first row');
    const last = rows.length - 1;
    assert.equal(applyKey(rows, 'j', last, 5).cursor, last, 'cannot go below the last row');
    assert.equal(applyKey(rows, `${ESC}[6~`, 0, 99).cursor, last, 'a page down clamps');
  });

  test('an unrecognised key changes nothing', () => {
    const rows = buildTree(MANIFEST, MANIFEST.repos, false);
    const res = applyKey(rows, 'Z', 3, 5);
    assert.equal(res.action, 'ignored');
    assert.equal(res.cursor, 3);
    assert.equal(selectedRepos(rows).length, 0);
  });
});
