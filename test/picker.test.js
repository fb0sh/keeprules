import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';

import {
  countVisualRows,
  createPickerState,
  displayWidth,
  formatDetailLines,
  renderPickerFrame,
  truncateToWidth,
} from '../src/picker.js';

const items = [
  { value: 'a', label: 'ALPHA', description: 'First rule' },
  { value: 'b', label: 'BETA', description: 'Second rule' },
  { value: 'c', label: 'GAMMA', description: 'Third rule' },
];

const manyItems = Array.from({ length: 5 }, (_, index) => ({
  value: `item-${index}`,
  label: `ITEM ${index}`,
  description: `Description ${index}`,
}));

function plain(lines) {
  return lines.map((line) => stripVTControlCharacters(line)).join('\n');
}

test('picker starts at Select All with nothing selected', () => {
  const state = createPickerState({ items });

  assert.equal(state.cursor, 0);
  assert.equal(state.selectedCount, 0);
  assert.equal(state.selectAllState, 'none');
  assert.equal(state.highlightedDetail, '选择或取消全部 3 个规则。');
  assert.deepEqual(state.selectedLabels, []);
  assert.deepEqual(state.getSelectedValues(), []);
  assert.deepEqual(state.visibleRange, { start: 0, end: 3 });
});

test('cursor movement changes the highlighted description', () => {
  const state = createPickerState({ items });

  assert.equal(state.handleKey('', { name: 'down' }), 'render');
  assert.equal(state.cursor, 1);
  assert.equal(state.highlightedDetail, 'First rule');

  assert.equal(state.handleKey('', { name: 'down' }), 'render');
  assert.equal(state.cursor, 2);
  assert.equal(state.highlightedDetail, 'Second rule');

  assert.equal(state.handleKey('', { name: 'up' }), 'render');
  assert.equal(state.cursor, 1);
});

test('space toggles one rule and Select All reports partial state', () => {
  const state = createPickerState({ items });
  state.handleKey('', { name: 'down' });

  state.handleKey(' ', { name: 'space' });
  assert.equal(state.selectedCount, 1);
  assert.equal(state.selectAllState, 'partial');
  assert.equal(state.isSelected('a'), true);
  assert.deepEqual(state.selectedLabels, ['ALPHA']);

  state.handleKey(' ', { name: 'space' });
  assert.equal(state.selectedCount, 0);
  assert.equal(state.selectAllState, 'none');
});

test('a toggles all rules from any cursor position', () => {
  const state = createPickerState({ items });
  state.handleKey('', { name: 'down' });

  state.handleKey('a', { name: 'a' });
  assert.equal(state.selectedCount, 3);
  assert.equal(state.selectAllState, 'all');
  assert.deepEqual(state.getSelectedValues(), ['a', 'b', 'c']);

  state.handleKey('a', { name: 'a' });
  assert.equal(state.selectedCount, 0);
});

test('space on the Select All row fills a partial selection', () => {
  const state = createPickerState({ items });
  state.handleKey('', { name: 'down' });
  state.handleKey(' ', { name: 'space' });
  assert.equal(state.selectAllState, 'partial');

  state.handleKey('', { name: 'up' });
  state.handleKey(' ', { name: 'space' });
  assert.equal(state.selectAllState, 'all');
});

test('required blocks submit until at least one rule is selected', () => {
  const state = createPickerState({ items, required: true });

  assert.equal(state.handleKey('', { name: 'return' }), 'render');
  assert.equal(state.errorMessage, '请至少选择一个规则');

  state.handleKey('', { name: 'down' });
  assert.equal(state.errorMessage, '');
  state.handleKey(' ', { name: 'space' });

  assert.equal(state.handleKey('', { name: 'return' }), 'submit');
});

test('escape and Ctrl+C/Ctrl+D cancel the picker', () => {
  const escapeState = createPickerState({ items });
  const ctrlCState = createPickerState({ items });
  const ctrlDState = createPickerState({ items });

  assert.equal(escapeState.handleKey('', { name: 'escape' }), 'cancel');
  assert.equal(
    ctrlCState.handleKey('', { name: 'c', ctrl: true }),
    'cancel',
  );
  assert.equal(
    ctrlDState.handleKey('', { name: 'd', ctrl: true }),
    'cancel',
  );
});

test('viewport follows the cursor when the list is long', () => {
  const state = createPickerState({ items: manyItems, maxVisible: 2 });

  assert.deepEqual(state.visibleRange, { start: 0, end: 2 });
  for (let index = 0; index < 4; index += 1) {
    state.handleKey('', { name: 'down' });
  }
  assert.deepEqual(state.visibleRange, { start: 2, end: 4 });

  state.handleKey('', { name: 'down' });
  assert.deepEqual(state.visibleRange, { start: 3, end: 5 });
});

test('active frame includes Select All, description, summary, and hints', () => {
  const state = createPickerState({ items });
  const frame = plain(
    renderPickerFrame({ message: '选择要安装的规则', items, state }),
  );

  assert.match(frame, /Select All \(0\/3\)/);
  assert.match(frame, /ALPHA/);
  assert.match(frame, /Description/);
  assert.match(frame, /选择或取消全部 3 个规则。/);
  assert.match(frame, /Selected: \(none\)/);
  assert.match(frame, /空格 选择/);
  assert.match(frame, /Esc 取消/);
});

test('active frame reflects highlighted detail and selected summary', () => {
  const state = createPickerState({ items });
  state.handleKey('', { name: 'down' });
  state.handleKey('', { name: 'down' });
  state.handleKey(' ', { name: 'space' });

  const frame = plain(
    renderPickerFrame({ message: '选择要安装的规则', items, state }),
  );

  assert.match(frame, /Second rule/);
  assert.match(frame, /BETA/);
  assert.match(frame, /Selected: BETA/);
});

test('submit and cancel frames report the final outcome', () => {
  const submitState = createPickerState({ items });
  submitState.handleKey('a', { name: 'a' });
  assert.equal(submitState.handleKey('', { name: 'return' }), 'submit');

  const submitFrame = plain(
    renderPickerFrame({
      message: '选择要安装的规则',
      items,
      state: submitState,
      mode: 'submit',
    }),
  );
  assert.match(submitFrame, /ALPHA, BETA, GAMMA/);
  assert.doesNotMatch(submitFrame, /Select All/);

  const cancelState = createPickerState({ items });
  assert.equal(cancelState.handleKey('', { name: 'escape' }), 'cancel');
  const cancelFrame = plain(
    renderPickerFrame({
      message: '选择要安装的规则',
      items,
      state: cancelState,
      mode: 'cancel',
    }),
  );
  assert.match(cancelFrame, /已取消/);
});

test('required error is rendered in the frame', () => {
  const state = createPickerState({ items, required: true });
  state.handleKey('', { name: 'return' });

  const frame = plain(
    renderPickerFrame({ message: '选择要安装的规则', items, state }),
  );

  assert.match(frame, /请至少选择一个规则/);
});

test('long lists render a viewport hint', () => {
  const state = createPickerState({ items: manyItems, maxVisible: 2 });
  const frame = plain(
    renderPickerFrame({
      message: '选择要安装的规则',
      items: manyItems,
      state,
    }),
  );

  assert.match(frame, /↓ 3 more/);
});

// ── text measurement ────────────────────────────────────────────────────────




test('formatDetailLines always returns the requested number of lines', () => {
  const short = formatDetailLines('short', 40, 2);
  assert.deepEqual(short, ['short', '']);

  const empty = formatDetailLines('', 40, 2);
  assert.deepEqual(empty, ['', '']);
});

test('formatDetailLines truncates long descriptions with an ellipsis', () => {
  const lines = formatDetailLines(
    'Coding Agent 工程卫生与资源管理规范（临时目录、Git 安全、进程清理、破坏性操作检查点等）',
    20,
    2,
  );

  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => displayWidth(line) <= 20));
  assert.ok(lines[1].endsWith('…'));
});

test('display width counts CJK characters as two cells', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('\u001b[31m红色\u001b[39m'), 4);
});

test('truncateToWidth never splits a wide character', () => {
  assert.equal(truncateToWidth('中文', 3), '中');
  assert.equal(truncateToWidth('中文', 4), '中文');
  assert.equal(truncateToWidth('abcd', 2), 'ab');
});

test('countVisualRows accounts for wrapping and wide characters', () => {
  assert.equal(countVisualRows(['abc', '中文'], 80), 2);
  assert.equal(countVisualRows(['a'.repeat(81)], 80), 2);
  assert.equal(countVisualRows(['中文中文'], 4), 2);
});

test('truncateToWidth keeps ANSI sequences whole', () => {
  const red = '\u001b[31mRED\u001b[39m';

  assert.equal(truncateToWidth(red, 5), red, 'fits, so nothing is cut');
  assert.equal(truncateToWidth(red, 1), '\u001b[31mR\u001b[0m', 'cut text closes the style');
  const cut = truncateToWidth(red, 2);
  assert.ok(
    !stripVTControlCharacters(cut).includes('\u001b'),
    'every escape sequence in the output is complete',
  );
  assert.equal(displayWidth(cut), 2, 'visible width matches the cut');
  assert.ok(cut.endsWith('\u001b[0m'), 'a cut style is closed');
});

test('formatDetailLines strips colour so a truncated line cannot bleed', () => {
  const red = '\u001b[31m中文说明文字\u001b[39m';
  const lines = formatDetailLines(red, 4, 2);

  assert.deepEqual(lines, ['中文', '说…']);
  assert.ok(
    lines.every((line) => !/[\u001b]/.test(line)),
    'no escape sequence survives wrapping',
  );
  assert.deepEqual(lines.map(displayWidth), [4, 3], 'widths match the cut text');
});
