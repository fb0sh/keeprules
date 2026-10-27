/**
 * Terminal text measurement and wrapping helpers.
 *
 * Pure functions only: no streams, cursor state, or process globals.
 */

import { stripVTControlCharacters } from 'node:util';

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

/** Count physical terminal rows occupied by rendered lines. */
export function countVisualRows(lines, columns) {
  const cols = Math.max(1, columns);
  return lines.reduce(
    (total, line) => total + Math.max(1, Math.ceil(displayWidth(line) / cols)),
    0,
  );
}
