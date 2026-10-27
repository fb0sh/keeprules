import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

import { CANCEL, ruleMultiselect } from '../src/picker.js';
import { countVisualRows } from '../src/picker.js';

/**
 * In-memory stream pair plugged into the adapter's seam.
 *
 * It is a real adapter, not a mock: the input is a genuine Readable because
 * readline requires one, and the adapter drives it exactly like a terminal, so
 * raw-mode toggling, frame erasing, and cleanup ordering all run for real.
 */
function fakeTerminal({ columns = 80 } = {}) {
  const input = new PassThrough();
  const output = new EventEmitter();
  const writes = [];
  const rawMode = [];

  input.isTTY = true;
  input.setRawMode = (enabled) => rawMode.push(enabled);

  output.columns = columns;
  output.write = (chunk) => {
    writes.push(chunk);
    return true;
  };

  return {
    streams: {
      input,
      output,
      columns: () => (output.columns > 0 ? output.columns : 80),
      setRawMode: (enabled) => input.setRawMode(enabled),
      isExhausted: () => input.readableEnded || input.destroyed,
    },
    writes,
    rawMode,
    /** Frames written so far, with control sequences stripped. */
    frames: () =>
      writes.map((chunk) => stripVTControlCharacters(chunk).split('\n')),
    /** Press one key, as readline would report it. */
    press: (name, extras = {}) =>
      input.emit('keypress', extras.sequence ?? '', { name, ...extras }),
    resize: () => output.emit('resize'),
    setColumns: (value) => {
      output.columns = value;
    },
    close: () => input.emit('close'),
    writesContaining: (needle) =>
      writes.filter((chunk) => stripVTControlCharacters(chunk).includes(needle)),
  };
}

const ITEMS = [
  { value: 'alpha', label: 'ALPHA', description: 'Alpha rule' },
  { value: 'beta', label: 'BETA', description: 'Beta rule' },
];

/** Long labels and descriptions so the frame wraps at narrow widths. */
const WIDE_ITEMS = [
  { value: 'alpha', label: 'A'.repeat(60), description: 'x'.repeat(160) },
  { value: 'beta', label: 'B'.repeat(60), description: 'y'.repeat(160) },
];

/** The row count an erase prefix claims, or null when there is no prefix. */
function eraseHeight(write) {
  const match = /^\x1b\[(\d+)A\x1b\[J/.exec(write);
  return match ? Number(match[1]) : null;
}

/** Rows a frame painted, measured at the width it was painted at. */
function paintedRows(write, columns) {
  // The write is "frame\n"; the trailing newline is the cursor move, not a row.
  const body = write.replace(/^\x1b\[\d+A\x1b\[J/, '').replace(/\n$/, '');
  return countVisualRows(stripVTControlCharacters(body).split('\n'), columns);
}

/** Assert the last frame erased exactly what the frame before it painted. */
function assertRowsErasedMatch(term, widths) {
  const index = term.writes.length - 1;
  const previous = term.writes[index - 1];
  const current = term.writes[index];

  assert.equal(
    eraseHeight(current),
    paintedRows(previous, widths[index - 1]),
    `frame ${index} erased the wrong height`,
  );
}

test('a submitted selection resolves with the chosen values', async () => {
  const term = fakeTerminal();

  const result = ruleMultiselect({ items: ITEMS, streams: term.streams });

  term.press('down');
  term.press('space');
  term.press('return');

  assert.deepEqual(await result, ['alpha']);
});

test('escape cancels and raw mode is restored', async () => {
  const term = fakeTerminal();

  const result = ruleMultiselect({ items: ITEMS, streams: term.streams });
  term.press('escape');

  assert.equal(await result, CANCEL);
  assert.deepEqual(term.rawMode, [true, false]);
});

test('the first frame erases nothing, later frames erase the previous one', async () => {
  const term = fakeTerminal();

  const result = ruleMultiselect({ items: ITEMS, streams: term.streams });
  term.press('down');
  term.press('return');
  await result;

  // Assert on the erase sequence itself, not on "starts with an escape": a
  // frame legitimately begins with a colour escape whenever colour is on.
  assert.equal(eraseHeight(term.writes[0]), null, 'first frame has nothing to erase');
  assert.ok(
    term.writes.slice(1).every((chunk) => eraseHeight(chunk) !== null),
    'every later frame erases the previous frame first',
  );
});

test('a resize repaints without changing the selection', async () => {
  const term = fakeTerminal();

  const result = ruleMultiselect({ items: ITEMS, streams: term.streams });
  const before = term.writes.length;

  term.press('down');
  term.press('space');
  term.resize();

  assert.ok(term.writes.length > before + 1);

  term.press('return');
  assert.deepEqual(await result, ['alpha']);
});

test('keystrokes arriving after a submit do not paint over the final frame', async () => {
  const term = fakeTerminal();

  const result = ruleMultiselect({ items: ITEMS, streams: term.streams });
  term.press('down');
  term.press('space');
  term.press('return');

  const afterSubmit = term.writes.length;

  // A queued keystroke during cleanup.
  term.press('down');
  term.press('space');

  assert.deepEqual(await result, ['alpha']);
  assert.equal(term.writes.length, afterSubmit, 'no frame was painted after submit');
});

test('EOF before the prompt starts cancels instead of hanging', async () => {
  const term = fakeTerminal();
  // A stream that already ended reports it through `destroyed`, which is what
  // the adapter checks before attaching listeners.
  term.streams.input.destroy();

  const result = ruleMultiselect({ items: ITEMS, streams: term.streams });

  assert.equal(await result, CANCEL);
  assert.deepEqual(term.rawMode, [true, false], 'raw mode was turned back off');
});

test('EOF after the prompt starts cancels', async () => {
  const term = fakeTerminal();

  const result = ruleMultiselect({ items: ITEMS, streams: term.streams });
  term.streams.input.emit('end');

  assert.equal(await result, CANCEL);
});

test('submitting twice resolves once with the same value', async () => {
  const term = fakeTerminal();

  const result = ruleMultiselect({ items: ITEMS, streams: term.streams });
  term.press('down');
  term.press('space');
  term.press('return');
  term.press('return');

  assert.deepEqual(await result, ['alpha']);
});

test('a required prompt refuses an empty submit and shows an error', async () => {
  const term = fakeTerminal();

  const result = ruleMultiselect({
    items: ITEMS,
    required: true,
    streams: term.streams,
  });

  term.press('return');
  assert.ok(term.writesContaining('请至少选择一个规则').length > 0);

  term.press('down');
  term.press('space');
  term.press('return');

  assert.deepEqual(await result, ['alpha']);
});

test('the final frame reports the submitted labels', async () => {
  const term = fakeTerminal();

  const result = ruleMultiselect({ items: ITEMS, streams: term.streams });
  term.press('a');
  term.press('return');
  await result;

  const last = term.frames().at(-1).join('\n');
  assert.ok(last.includes('ALPHA, BETA'), 'submit frame lists the chosen labels');
});

test('each frame erases exactly the rows the previous frame painted', async () => {
  const term = fakeTerminal({ columns: 80 });

  const result = ruleMultiselect({ items: WIDE_ITEMS, streams: term.streams });
  term.press('down');

  // Every erase height must equal the row count the frame it follows painted,
  // measured at the width that frame was painted at.
  const widths = [80];
  assertRowsErasedMatch(term, widths);

  term.press('down');
  widths.push(80);
  assertRowsErasedMatch(term, widths);

  term.press('return');
  await result;
});

test('a repaint at a narrower width erases every row the wider frame painted', async () => {
  const term = fakeTerminal({ columns: 80 });

  const result = ruleMultiselect({ items: WIDE_ITEMS, streams: term.streams });

  // The frame at 80 columns wraps to fewer rows than the same frame at 20.
  const paintedAt80 = paintedRows(term.writes.at(-1), 80);

  term.setColumns(20);
  term.resize();

  // Frame 2 must erase what frame 1 painted, at frame 1's width.
  assert.equal(eraseHeight(term.writes.at(-1)), paintedAt80);

  // And frame 3 must erase what frame 2 painted, at 20 columns.
  const paintedAt20 = paintedRows(term.writes.at(-1), 20);
  term.resize();
  assert.equal(eraseHeight(term.writes.at(-1)), paintedAt20);
  assert.ok(paintedAt20 > paintedAt80, 'the narrower frame really is taller');

  term.press('escape');
  await result;
});
