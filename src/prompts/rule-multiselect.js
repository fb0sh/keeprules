/**
 * Lightweight rule multiselect prompt inspired by vercel-labs/skills.
 *
 * Features:
 * - A pinned "Select All (selected/total)" row with none/partial/all states
 * - Nothing selected by default
 * - A fixed-height description pane for the highlighted entry
 * - Space to toggle, Enter to confirm, Esc/Ctrl+C to cancel
 *
 * The implementation intentionally uses only Node's readline plus picocolors
 * instead of importing the reference project.
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import pc from 'picocolors';

/** Sentinel returned when the user cancels the prompt. */
export const CANCEL = Symbol('keeptidy:cancel');

const S_STEP_ACTIVE = pc.green('◆');
const S_STEP_CANCEL = pc.red('■');
const S_STEP_SUBMIT = pc.green('◇');
const S_RADIO_ACTIVE = pc.green('●');
const S_RADIO_PARTIAL = pc.yellow('◐');
const S_RADIO_INACTIVE = pc.dim('○');
const S_BAR = pc.dim('│');
const S_CURSOR = pc.cyan('❯');

// Prevent readline from echoing raw keystrokes over our rendered frame.
const silentOutput = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

/**
 * Code points that occupy two terminal cells. This covers CJK text and the
 * common emoji blocks used in the rule descriptions.
 */
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function isWideCodePoint(code) {
  if (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) {
    return true;
  }
  return WIDE_RANGES.some(([start, end]) => code >= start && code <= end);
}

/** Approximate terminal cell width, ignoring ANSI escape sequences. */
export function displayWidth(text) {
  let width = 0;
  for (const char of stripVTControlCharacters(String(text))) {
    const code = char.codePointAt(0);
    if (!code) continue;
    width += isWideCodePoint(code) ? 2 : 1;
  }
  return width;
}

/** Cut plain text (no ANSI colors) to fit within `width` terminal cells. */
export function truncateToWidth(text, width) {
  let result = '';
  let used = 0;

  for (const char of String(text)) {
    const charWidth = isWideCodePoint(char.codePointAt(0)) ? 2 : 1;
    if (used + charWidth > width) break;
    result += char;
    used += charWidth;
  }

  return result;
}

/**
 * Wrap text into exactly `maxLines` lines so the detail pane never changes
 * height while the cursor moves. Long text is truncated with an ellipsis.
 */
export function formatDetailLines(text, width, maxLines = 2) {
  const safeWidth = Math.max(1, width);
  const normalized = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const lines = [];
  let remaining = normalized;

  while (remaining && lines.length < maxLines) {
    if (displayWidth(remaining) <= safeWidth) {
      lines.push(remaining);
      remaining = '';
      break;
    }

    const candidate = truncateToWidth(remaining, safeWidth);
    const breakAt = candidate.lastIndexOf(' ');

    if (breakAt > 0) {
      lines.push(candidate.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    } else {
      lines.push(candidate);
      remaining = remaining.slice(candidate.length).trimStart();
    }
  }

  if (remaining && lines.length > 0) {
    const last = lines.length - 1;
    lines[last] = `${truncateToWidth(lines[last], Math.max(0, safeWidth - 1)).trimEnd()}…`;
  }

  while (lines.length < maxLines) {
    lines.push('');
  }

  return lines;
}

/** Aggregate state represented by the Select All row. */
export function getSelectAllState(selected, items) {
  const selectedCount = items.filter((item) => selected.has(item.value)).length;
  if (selectedCount === 0) return 'none';
  if (selectedCount === items.length) return 'all';
  return 'partial';
}

/** Select every item, or clear every item when everything is selected. */
export function toggleAllItems(selected, items) {
  const shouldClear = getSelectAllState(selected, items) === 'all';
  for (const item of items) {
    if (shouldClear) {
      selected.delete(item.value);
    } else {
      selected.add(item.value);
    }
  }
}

function terminalColumns() {
  return process.stdout.columns && process.stdout.columns > 0
    ? process.stdout.columns
    : 80;
}

function countVisualRows(lines) {
  const columns = Math.max(1, terminalColumns());
  return lines.reduce(
    (total, line) => total + Math.max(1, Math.ceil(displayWidth(line) / columns)),
    0,
  );
}

/**
 * Interactive rule picker.
 *
 * @param {object} options
 * @param {string} options.message prompt heading
 * @param {{value: string, label: string, description?: string, hint?: string}[]} options.items
 * @param {string[]} [options.initialSelected]
 * @param {boolean} [options.required]
 * @param {number} [options.maxVisible]
 * @param {number} [options.detailLines]
 * @returns {Promise<string[] | typeof CANCEL>}
 */
export async function ruleMultiselect({
  message = '选择要安装的规则',
  items,
  initialSelected = [],
  required = false,
  maxVisible = 8,
  detailLines = 2,
}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: silentOutput,
      terminal: false,
    });

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    readline.emitKeypressEvents(process.stdin, rl);

    const validValues = new Set(items.map((item) => item.value));
    const selected = new Set(
      initialSelected.filter((value) => validValues.has(value)),
    );

    let cursor = 0;
    let errorMessage = '';
    let lastRenderHeight = 0;
    let settled = false;

    const getHighlightedDetail = () => {
      if (cursor === 0) {
        return `选择或取消全部 ${items.length} 个规则。`;
      }
      const item = items[cursor - 1];
      return item?.description ?? item?.hint ?? '';
    };

    const render = (state = 'active') => {
      const columns = terminalColumns();
      const lines = [];
      const icon =
        state === 'active'
          ? S_STEP_ACTIVE
          : state === 'cancel'
            ? S_STEP_CANCEL
            : S_STEP_SUBMIT;

      lines.push(`${icon}  ${pc.bold(message)}`);

      if (state === 'submit') {
        const labels = items
          .filter((item) => selected.has(item.value))
          .map((item) => item.label);
        lines.push(`${S_BAR}  ${pc.dim(labels.join(', '))}`);
        lines.push(pc.dim('└'));
      } else if (state === 'cancel') {
        lines.push(`${S_BAR}  ${pc.dim('已取消')}`);
        lines.push(pc.dim('└'));
      } else {
        const selectedCount = items.filter((item) =>
          selected.has(item.value),
        ).length;
        const allState = getSelectAllState(selected, items);
        const allRadio =
          allState === 'all'
            ? S_RADIO_ACTIVE
            : allState === 'partial'
              ? S_RADIO_PARTIAL
              : S_RADIO_INACTIVE;
        const allCursor = cursor === 0;
        const allLabel = allCursor
          ? pc.underline(pc.bold('Select All'))
          : pc.bold('Select All');

        lines.push(S_BAR);
        lines.push(
          `${S_BAR} ${allCursor ? S_CURSOR : ' '} ${allRadio} ${allLabel} ${pc.dim(`(${selectedCount}/${items.length})`)}`,
        );
        lines.push(
          `${S_BAR}   ${pc.dim('─'.repeat(Math.min(36, Math.max(8, columns - 8))))}`,
        );

        // Keep the viewport centered around the item cursor. The Select All
        // row is pinned above the scrollable list and does not count as an item.
        const itemCursor = Math.max(0, cursor - 1);
        let visibleStart = 0;
        if (items.length > maxVisible) {
          visibleStart = Math.max(
            0,
            Math.min(
              itemCursor - Math.floor(maxVisible / 2),
              items.length - maxVisible,
            ),
          );
        }
        const visibleEnd = Math.min(items.length, visibleStart + maxVisible);

        for (let index = visibleStart; index < visibleEnd; index += 1) {
          const item = items[index];
          const isCursor = cursor === index + 1;
          const isSelected = selected.has(item.value);
          const radio = isSelected ? S_RADIO_ACTIVE : S_RADIO_INACTIVE;
          const label = isCursor ? pc.underline(pc.bold(item.label)) : item.label;

          lines.push(
            `${S_BAR} ${isCursor ? S_CURSOR : ' '} ${radio} ${label}`,
          );
        }

        if (visibleStart > 0 || visibleEnd < items.length) {
          const parts = [];
          if (visibleStart > 0) parts.push(`↑ ${visibleStart} more`);
          if (visibleEnd < items.length) {
            parts.push(`↓ ${items.length - visibleEnd} more`);
          }
          lines.push(`${S_BAR}  ${pc.dim(parts.join('  '))}`);
        }

        // Fixed-height detail pane for the highlighted rule.
        lines.push(S_BAR);
        lines.push(`${S_BAR}  ${pc.dim('Description')}`);
        for (const detailLine of formatDetailLines(
          getHighlightedDetail(),
          Math.max(10, columns - 5),
          detailLines,
        )) {
          lines.push(`${S_BAR}  ${pc.dim(detailLine)}`);
        }

        lines.push(S_BAR);
        const selectedLabels = items
          .filter((item) => selected.has(item.value))
          .map((item) => item.label);
        if (selectedLabels.length === 0) {
          lines.push(`${S_BAR}  ${pc.dim('Selected: (none)')}`);
        } else {
          const plainSummary =
            selectedLabels.length <= 3
              ? selectedLabels.join(', ')
              : `${selectedLabels.slice(0, 3).join(', ')} +${selectedLabels.length - 3} more`;
          const available = Math.max(1, columns - 15);
          const summary =
            displayWidth(plainSummary) > available
              ? `${truncateToWidth(plainSummary, Math.max(0, available - 1)).trimEnd()}…`
              : plainSummary;
          lines.push(`${S_BAR}  ${pc.green('Selected:')} ${summary}`);
        }

        // Fixed operation hints at the bottom of the frame.
        lines.push(S_BAR);
        lines.push(`${S_BAR}  ${pc.dim('↑↓ 移动 · 空格 选择 · 回车 确认')}`);
        lines.push(`${S_BAR}  ${pc.dim('a 全选 / 取消全选 · Esc 取消')}`);

        if (errorMessage) {
          lines.push(`${S_BAR}  ${pc.yellow(errorMessage)}`);
        }

        lines.push(pc.dim('└'));
      }

      const clearPreviousFrame =
        lastRenderHeight > 0 ? `\x1b[${lastRenderHeight}A\x1b[J` : '';
      process.stdout.write(`${clearPreviousFrame}${lines.join('\n')}\n`);
      lastRenderHeight = countVisualRows(lines);
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', keypressHandler);
      process.stdout.removeListener('resize', resizeHandler);
      rl.removeListener('close', closeHandler);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      rl.close();
    };

    const submit = () => {
      if (settled) return;
      if (required && selected.size === 0) {
        errorMessage = '请至少选择一个规则';
        render();
        return;
      }

      settled = true;
      render('submit');
      cleanup();
      resolve([
        ...items
          .filter((item) => selected.has(item.value))
          .map((item) => item.value),
      ]);
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      render('cancel');
      cleanup();
      resolve(CANCEL);
    };

    const closeHandler = () => {
      // Treat EOF / readline close as a cancellation instead of hanging.
      cancel();
    };

    const resizeHandler = () => {
      if (!settled) render();
    };

    const keypressHandler = (str, key) => {
      if (!key) return;

      if (key.name === 'return' || key.name === 'enter') {
        submit();
        return;
      }

      if (
        key.name === 'escape' ||
        (key.ctrl && (key.name === 'c' || key.name === 'd'))
      ) {
        cancel();
        return;
      }

      if (!key.ctrl && !key.meta && (key.name === 'up' || key.name === 'k')) {
        cursor = Math.max(0, cursor - 1);
        errorMessage = '';
        render();
        return;
      }

      if (!key.ctrl && !key.meta && (key.name === 'down' || key.name === 'j')) {
        cursor = Math.min(items.length, cursor + 1);
        errorMessage = '';
        render();
        return;
      }

      if (key.name === 'space' || str === ' ') {
        if (cursor === 0) {
          toggleAllItems(selected, items);
        } else {
          const item = items[cursor - 1];
          if (selected.has(item.value)) {
            selected.delete(item.value);
          } else {
            selected.add(item.value);
          }
        }
        errorMessage = '';
        render();
        return;
      }

      // Keep the earlier "a" shortcut as a convenient alternative.
      if (
        !key.ctrl &&
        !key.meta &&
        (key.name === 'a' || str === 'a' || str === 'A')
      ) {
        toggleAllItems(selected, items);
        errorMessage = '';
        render();
      }
    };

    process.stdin.on('keypress', keypressHandler);
    process.stdout.on('resize', resizeHandler);
    rl.on('close', closeHandler);

    if (process.stdin.readableEnded || process.stdin.destroyed) {
      cancel();
      return;
    }

    render();
  });
}
