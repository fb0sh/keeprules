/**
 * The interactive rule picker.
 *
 * Three layers in one module, because they are one thing:
 *   1. text measurement — terminal cell width, wrapping, row counts
 *   2. state + frame      — pure; keys in, lines out
 *   3. terminal adapter   — readline, raw mode, repaint, cancellation
 *
 * Only the adapter touches process globals, and it takes its streams as an
 * option, so a test drives the same code with an in-memory pair.
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import pc from 'picocolors';

// ── 1. text measurement ─────────────────────────────────────────────────────


/** Matches one ANSI escape sequence, anchored by the caller. */
const ANSI_PATTERN = /\u001B\[[0-9;]*m/;

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

/**
 * Cut text to fit within `width` terminal cells.
 *
 * ANSI escape sequences are preserved whole: colouring is carried through, and
 * a sequence is never split even when the visible text is cut short. Width is
 * measured the same way `displayWidth` measures it, so the two agree.
 */
export function truncateToWidth(text, width) {
  const source = String(text);
  let result = '';
  let used = 0;
  let index = 0;
  let truncated = false;

  while (index < source.length) {
    const ansi = ANSI_PATTERN.exec(source.slice(index));

    // Copy a whole escape sequence without charging it any width.
    if (ansi && ansi.index === 0) {
      result += ansi[0];
      index += ansi[0].length;
      continue;
    }

    const char = String.fromCodePoint(source.codePointAt(index));
    const charWidth = isWideCodePoint(char.codePointAt(0)) ? 2 : 1;
    if (used + charWidth > width) {
      truncated = true;
      break;
    }

    result += char;
    used += charWidth;
    index += char.length;
  }

  // Cutting inside colour leaves the style open; close it so the rest of the
  // terminal line is not painted with it.
  if (truncated && ANSI_PATTERN.test(result)) {
    return `${result}\u001b[0m`;
  }

  return result;
}

/**
 * Wrap text into exactly `maxLines` lines so the detail pane never changes
 * height while the cursor moves. Long text is truncated with an ellipsis.
 *
 * Returns plain text: colouring is stripped so the pane never emits an escape
 * sequence it failed to close (a truncated sequence would bleed colour into
 * every following line). The caller styles each line as a whole.
 */
export function formatDetailLines(text, width, maxLines = 2) {
  const safeWidth = Math.max(1, width);
  const normalized = stripVTControlCharacters(String(text ?? ''))
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

/** Count physical terminal rows occupied by rendered lines. */
export function countVisualRows(lines, columns) {
  const cols = Math.max(1, columns);
  return lines.reduce(
    (total, line) => total + Math.max(1, Math.ceil(displayWidth(line) / cols)),
    0,
  );
}

// ── 2. state and frame ──────────────────────────────────────────────────────



const S_STEP_ACTIVE = pc.green('◆');
const S_STEP_CANCEL = pc.red('■');
const S_STEP_SUBMIT = pc.green('◇');
const S_RADIO_ACTIVE = pc.green('●');
const S_RADIO_PARTIAL = pc.yellow('◐');
const S_RADIO_INACTIVE = pc.dim('○');
const S_BAR = pc.dim('│');
const S_CURSOR = pc.cyan('❯');

/**
 * Create the selection/cursor state machine for the rule picker.
 *
 * @param {object} options
 * @param {{value: string, label: string, description?: string}[]} options.items
 * @param {string[]} [options.initialSelected]
 * @param {boolean} [options.required]
 * @param {number} [options.maxVisible]
 */
export function createPickerState({
  items,
  initialSelected = [],
  required = false,
  maxVisible = 8,
}) {
  const validValues = new Set(items.map((item) => item.value));
  const selected = new Set(
    initialSelected.filter((value) => validValues.has(value)),
  );

  let cursor = 0;
  let errorMessage = '';

  const selectedCount = () =>
    items.filter((item) => selected.has(item.value)).length;

  const selectAllState = () => {
    const count = selectedCount();
    if (count === 0) return 'none';
    if (count === items.length) return 'all';
    return 'partial';
  };

  const toggleAll = () => {
    const shouldClear = selectAllState() === 'all';
    for (const item of items) {
      if (shouldClear) {
        selected.delete(item.value);
      } else {
        selected.add(item.value);
      }
    }
  };

  const toggleCurrent = () => {
    if (cursor === 0) {
      toggleAll();
      return;
    }

    const item = items[cursor - 1];
    if (!item) return;
    if (selected.has(item.value)) {
      selected.delete(item.value);
    } else {
      selected.add(item.value);
    }
  };

  const visibleRange = () => {
    const limit = Math.max(1, maxVisible);
    const itemCursor = Math.max(0, cursor - 1);
    let start = 0;

    if (items.length > limit) {
      start = Math.max(
        0,
        Math.min(
          itemCursor - Math.floor(limit / 2),
          items.length - limit,
        ),
      );
    }

    return { start, end: Math.min(items.length, start + limit) };
  };

  const highlightedDetail = () => {
    if (cursor === 0) {
      return `选择或取消全部 ${items.length} 个规则。`;
    }
    const item = items[cursor - 1];
    return item?.description ?? '';
  };

  const selectedLabels = () =>
    items
      .filter((item) => selected.has(item.value))
      .map((item) => item.label);

  const getSelectedValues = () =>
    items
      .filter((item) => selected.has(item.value))
      .map((item) => item.value);

  /**
   * Apply one readline key.
   *
   * @returns {'render' | 'submit' | 'cancel' | 'ignored'}
   */
  const handleKey = (str, key) => {
    if (!key) return 'ignored';

    if (key.name === 'return' || key.name === 'enter') {
      if (required && selected.size === 0) {
        errorMessage = '请至少选择一个规则';
        return 'render';
      }
      return 'submit';
    }

    if (
      key.name === 'escape' ||
      (key.ctrl && (key.name === 'c' || key.name === 'd'))
    ) {
      return 'cancel';
    }

    if (!key.ctrl && !key.meta && (key.name === 'up' || key.name === 'k')) {
      cursor = Math.max(0, cursor - 1);
      errorMessage = '';
      return 'render';
    }

    if (!key.ctrl && !key.meta && (key.name === 'down' || key.name === 'j')) {
      cursor = Math.min(items.length, cursor + 1);
      errorMessage = '';
      return 'render';
    }

    if (key.name === 'space' || str === ' ') {
      toggleCurrent();
      errorMessage = '';
      return 'render';
    }

    if (
      !key.ctrl &&
      !key.meta &&
      (key.name === 'a' || str === 'a' || str === 'A')
    ) {
      toggleAll();
      errorMessage = '';
      return 'render';
    }

    return 'ignored';
  };

  return {
    get cursor() {
      return cursor;
    },
    get selectedCount() {
      return selectedCount();
    },
    get selectAllState() {
      return selectAllState();
    },
    get errorMessage() {
      return errorMessage;
    },
    get visibleRange() {
      return visibleRange();
    },
    get highlightedDetail() {
      return highlightedDetail();
    },
    get selectedLabels() {
      return selectedLabels();
    },
    isSelected(value) {
      return selected.has(value);
    },
    getSelectedValues,
    handleKey,
  };
}

/**
 * Compose one picker frame from state.
 *
 * @param {object} options
 * @param {string} options.message
 * @param {object[]} options.items
 * @param {object} options.state state returned by createPickerState
 * @param {'active' | 'submit' | 'cancel'} [options.mode]
 * @param {number} [options.columns]
 * @param {number} [options.detailLines]
 * @returns {string[]}
 */
export function renderPickerFrame({
  message,
  items,
  state,
  mode = 'active',
  columns = 80,
  detailLines = 2,
}) {
  const lines = [];
  const icon =
    mode === 'active'
      ? S_STEP_ACTIVE
      : mode === 'cancel'
        ? S_STEP_CANCEL
        : S_STEP_SUBMIT;

  lines.push(`${icon}  ${pc.bold(message)}`);

  if (mode === 'submit') {
    lines.push(`${S_BAR}  ${pc.dim(state.selectedLabels.join(', '))}`);
    lines.push(pc.dim('└'));
    return lines;
  }

  if (mode === 'cancel') {
    lines.push(`${S_BAR}  ${pc.dim('已取消')}`);
    lines.push(pc.dim('└'));
    return lines;
  }

  const allState = state.selectAllState;
  const allRadio =
    allState === 'all'
      ? S_RADIO_ACTIVE
      : allState === 'partial'
        ? S_RADIO_PARTIAL
        : S_RADIO_INACTIVE;
  const allCursor = state.cursor === 0;
  const allLabel = allCursor
    ? pc.underline(pc.bold('Select All'))
    : pc.bold('Select All');

  lines.push(S_BAR);
  lines.push(
    `${S_BAR} ${allCursor ? S_CURSOR : ' '} ${allRadio} ${allLabel} ${pc.dim(`(${state.selectedCount}/${items.length})`)}`,
  );
  lines.push(
    `${S_BAR}   ${pc.dim('─'.repeat(Math.min(36, Math.max(8, columns - 8))))}`,
  );

  // The Select All row is pinned above the scrollable item viewport.
  const { start, end } = state.visibleRange;
  for (let index = start; index < end; index += 1) {
    const item = items[index];
    const isCursor = state.cursor === index + 1;
    const radio = state.isSelected(item.value)
      ? S_RADIO_ACTIVE
      : S_RADIO_INACTIVE;
    const label = isCursor ? pc.underline(pc.bold(item.label)) : item.label;

    lines.push(`${S_BAR} ${isCursor ? S_CURSOR : ' '} ${radio} ${label}`);
  }

  if (start > 0 || end < items.length) {
    const parts = [];
    if (start > 0) parts.push(`↑ ${start} more`);
    if (end < items.length) parts.push(`↓ ${items.length - end} more`);
    lines.push(`${S_BAR}  ${pc.dim(parts.join('  '))}`);
  }

  // Fixed-height detail pane for the highlighted rule.
  lines.push(S_BAR);
  lines.push(`${S_BAR}  ${pc.dim('Description')}`);
  for (const detailLine of formatDetailLines(
    state.highlightedDetail,
    Math.max(10, columns - 5),
    detailLines,
  )) {
    lines.push(`${S_BAR}  ${pc.dim(detailLine)}`);
  }

  lines.push(S_BAR);
  const labels = state.selectedLabels;
  if (labels.length === 0) {
    lines.push(`${S_BAR}  ${pc.dim('Selected: (none)')}`);
  } else {
    const plainSummary =
      labels.length <= 3
        ? labels.join(', ')
        : `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more`;
    const available = Math.max(1, columns - 15);
    const summary =
      displayWidth(plainSummary) > available
        ? `${truncateToWidth(plainSummary, Math.max(0, available - 1)).trimEnd()}…`
        : plainSummary;
    lines.push(`${S_BAR}  ${pc.green('Selected:')} ${summary}`);
  }

  // Fixed operation hints at the bottom.
  lines.push(S_BAR);
  lines.push(`${S_BAR}  ${pc.dim('↑↓ 移动 · 空格 选择 · 回车 确认')}`);
  lines.push(`${S_BAR}  ${pc.dim('a 全选 / 取消全选 · Esc 取消')}`);

  if (state.errorMessage) {
    lines.push(`${S_BAR}  ${pc.yellow(state.errorMessage)}`);
  }

  lines.push(pc.dim('└'));
  return lines;
}

// ── 3. terminal adapter ─────────────────────────────────────────────────────


/** Sentinel returned when the user cancels the prompt. */
export const CANCEL = Symbol('keeprules:cancel');

/** The process streams, used when the caller supplies none. */
function processStreams() {
  const input = process.stdin;
  const output = process.stdout;

  return {
    input,
    output,
    columns: () => (output.columns > 0 ? output.columns : 80),
    setRawMode: (enabled) => {
      if (input.isTTY) input.setRawMode(enabled);
    },
    isExhausted: () => input.readableEnded || input.destroyed,
  };
}

/** Swallow readline's echo so our own frames are the only thing on screen. */
const silentOutput = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

/**
 * Interactive rule picker.
 *
 * @param {object} options
 * @param {string} options.message prompt heading
 * @param {{value: string, label: string, description?: string}[]} options.items
 * @param {string[]} [options.initialSelected]
 * @param {boolean} [options.required]
 * @param {number} [options.maxVisible]
 * @param {number} [options.detailLines]
 * @param {object} [options.streams] seam for tests; defaults to process streams
 * @returns {Promise<string[] | typeof CANCEL>}
 */
export async function ruleMultiselect({
  message = '选择要安装的规则',
  items,
  initialSelected = [],
  required = false,
  maxVisible = 8,
  detailLines = 2,
  streams = processStreams(),
}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: streams.input,
      output: silentOutput,
      terminal: false,
    });

    streams.setRawMode(true);
    readline.emitKeypressEvents(streams.input, rl);

    // State and frame must see the same items; both close over this array.
    const state = createPickerState({
      items,
      initialSelected,
      required,
      maxVisible,
    });

    let lastRenderHeight = 0;
    let settled = false;

    const render = (mode = 'active') => {
      const columns = streams.columns();
      const lines = renderPickerFrame({
        message,
        items,
        state,
        mode,
        columns,
        detailLines,
      });
      const clearPreviousFrame =
        lastRenderHeight > 0 ? `\x1b[${lastRenderHeight}A\x1b[J` : '';

      streams.output.write(`${clearPreviousFrame}${lines.join('\n')}\n`);
      lastRenderHeight = countVisualRows(lines, columns);
    };

    const cleanup = () => {
      streams.input.removeListener('keypress', keypressHandler);
      streams.output.removeListener('resize', resizeHandler);
      rl.removeListener('close', closeHandler);
      streams.setRawMode(false);
      rl.close();
    };

    const finish = (mode, value) => {
      if (settled) return;
      settled = true;
      render(mode);
      cleanup();
      resolve(value);
    };

    const onKeypress = (str, key) => {
      // A keystroke queued before cleanup must not paint over the final frame.
      if (settled) return;

      const action = state.handleKey(str, key);

      if (action === 'submit') {
        finish('submit', state.getSelectedValues());
        return;
      }

      if (action === 'cancel') {
        finish('cancel', CANCEL);
        return;
      }

      if (action === 'render') render();
    };

    const onClose = () => {
      // Treat EOF / readline close as a cancellation instead of hanging.
      finish('cancel', CANCEL);
    };

    const onResize = () => {
      if (!settled) render();
    };

    const keypressHandler = onKeypress;
    const closeHandler = onClose;
    const resizeHandler = onResize;

    // EOF that already happened cannot be listened for.
    if (streams.isExhausted()) {
      finish('cancel', CANCEL);
      return;
    }

    streams.input.on('keypress', keypressHandler);
    streams.output.on('resize', resizeHandler);
    rl.on('close', closeHandler);

    render();
  });
}

