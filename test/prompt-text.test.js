import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countVisualRows,
  displayWidth,
  formatDetailLines,
  truncateToWidth,
} from '../src/prompts/text.js';

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
