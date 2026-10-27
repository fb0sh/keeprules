/**
 * Terminal adapter for the rule picker.
 *
 * All cursor/selection/frame logic lives in picker.js and text.js. This file
 * only wires readline, raw mode, resize/EOF handling, and the final outcome.
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import { createPickerState, renderPickerFrame } from './picker.js';
import { countVisualRows } from './text.js';

/** Sentinel returned when the user cancels the prompt. */
export const CANCEL = Symbol('keeprules:cancel');

// Prevent readline from echoing raw keystrokes over our rendered frame.
const silentOutput = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

function terminalColumns() {
  return process.stdout.columns && process.stdout.columns > 0
    ? process.stdout.columns
    : 80;
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

    const state = createPickerState({
      items,
      initialSelected,
      required,
      maxVisible,
    });

    let lastRenderHeight = 0;
    let settled = false;

    const render = (mode = 'active') => {
      const columns = terminalColumns();
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

      process.stdout.write(`${clearPreviousFrame}${lines.join('\n')}\n`);
      lastRenderHeight = countVisualRows(lines, columns);
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

    const finish = (mode, value) => {
      if (settled) return;
      settled = true;
      render(mode);
      cleanup();
      resolve(value);
    };

    const closeHandler = () => {
      // Treat EOF / readline close as a cancellation instead of hanging.
      finish('cancel', CANCEL);
    };

    const resizeHandler = () => {
      if (!settled) render();
    };

    const keypressHandler = (str, key) => {
      const action = state.handleKey(str, key);

      if (action === 'submit') {
        finish('submit', state.getSelectedValues());
        return;
      }

      if (action === 'cancel') {
        finish('cancel', CANCEL);
        return;
      }

      if (action === 'render') {
        render();
      }
    };

    process.stdin.on('keypress', keypressHandler);
    process.stdout.on('resize', resizeHandler);
    rl.on('close', closeHandler);

    if (process.stdin.readableEnded || process.stdin.destroyed) {
      finish('cancel', CANCEL);
      return;
    }

    render();
  });
}
