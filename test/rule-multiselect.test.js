import test from 'node:test';
import assert from 'node:assert/strict';

import {
  displayWidth,
  formatDetailLines,
  getSelectAllState,
  toggleAllItems,
  truncateToWidth,
} from '../src/prompts/rule-multiselect.js';

const items = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
  { value: 'c', label: 'C' },
];

test('getSelectAllState reports none, partial, and all', () => {
  assert.equal(getSelectAllState(new Set(), items), 'none');
  assert.equal(getSelectAllState(new Set(['a']), items), 'partial');
  assert.equal(getSelectAllState(new Set(['a', 'b']), items), 'partial');
  assert.equal(getSelectAllState(new Set(['a', 'b', 'c']), items), 'all');
});

test('toggleAllItems selects all from none and clears from all', () => {
  const selected = new Set();

  toggleAllItems(selected, items);
  assert.deepEqual([...selected].sort(), ['a', 'b', 'c']);

  toggleAllItems(selected, items);
  assert.equal(selected.size, 0);
});

test('toggleAllItems fills a partial selection instead of clearing it', () => {
  const selected = new Set(['b']);

  toggleAllItems(selected, items);
  assert.deepEqual([...selected].sort(), ['a', 'b', 'c']);
});

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
