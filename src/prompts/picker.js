/**
 * Pure rule-picker state and frame composition.
 *
 * Keystrokes produce actions; a frame is rendered from a state snapshot.
 * Nothing here touches stdin, stdout, readline, or process globals.
 */

import pc from 'picocolors';
import { displayWidth, formatDetailLines, truncateToWidth } from './text.js';

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
 * @param {{value: string, label: string, description?: string, hint?: string}[]} options.items
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
    return item?.description ?? item?.hint ?? '';
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
