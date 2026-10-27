/**
 * Rule discovery and frontmatter parsing.
 *
 * Rules are plain Markdown files in `rules/`. Metadata is declared with a
 * small YAML frontmatter subset so adding a rule only requires adding a file.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Compare two strings by code point.
 *
 * `localeCompare` is deliberately avoided: its ordering depends on the host
 * locale and ICU build, so the picker would list rules in a different order on
 * different machines. Code point order is stable everywhere.
 */
function compareCodePoints(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Parse a quoted or plain YAML scalar. */
function parseScalar(rawValue) {
  const value = rawValue.trim();

  if (value === '') return '';
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Inline arrays: [gitignore, agents]
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((part) => parseScalar(part))
      .filter((part) => part !== '');
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }

  return value;
}

/**
 * Parse the YAML subset used by rule frontmatter:
 * - `key: value`
 * - `key:` followed by `  - item` list entries
 * - inline arrays
 *
 * Unsupported/complex YAML is intentionally ignored rather than executed.
 */
function parseSimpleYaml(text) {
  const data = {};
  let currentKey = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');

    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }

    const listItem = /^\s*-\s*(.*)$/.exec(line);
    if (listItem && currentKey) {
      if (!Array.isArray(data[currentKey])) {
        data[currentKey] = [];
      }
      data[currentKey].push(parseScalar(listItem[1]));
      continue;
    }

    const keyValue = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!keyValue) {
      continue;
    }

    const [, key, rawValue] = keyValue;
    currentKey = key;
    data[key] = rawValue === '' ? null : parseScalar(rawValue);
  }

  return data;
}

/** Split frontmatter from the Markdown body. */
function parseFrontmatter(content) {
  const normalized = String(content).replace(/^\uFEFF/, '');
  const match = FRONTMATTER_PATTERN.exec(normalized);

  if (!match) {
    return { data: {}, body: normalized };
  }

  return {
    data: parseSimpleYaml(match[1]),
    body: normalized.slice(match[0].length),
  };
}

/** Use the first meaningful Markdown line when no description is declared. */
function fallbackDescription(body) {
  const line = body
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith('<!--'));

  if (!line) return '';
  return line.replace(/^#+\s*/, '').trim();
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asString(entry))
      .filter((entry) => entry !== '');
  }

  const single = asString(value);
  return single ? [single] : [];
}

/**
 * Reject rule file names that map to the same file on a case-insensitive
 * filesystem (default on macOS and Windows).
 *
 * Without this check such a pair installs silently wrong: the second copy
 * collides with the first, is reported as "already exists", and AGENTS.md ends
 * up linking the same file twice.
 */
function assertNoFileNameCollisions(fileNames) {
  const seen = new Map();

  for (const fileName of fileNames) {
    const key = fileName.toLowerCase();
    if (seen.has(key)) {
      throw new Error(
        `规则文件名大小写冲突: "${seen.get(key)}" 与 "${fileName}"。` +
          'macOS 与 Windows 的文件系统默认不区分大小写，这两个规则会写入同一个文件。请重命名其中一个。',
      );
    }
    seen.set(key, fileName);
  }
}

/**
 * Read every `.md` file in `rulesDir` and build the rule registry.
 *
 * Files without frontmatter still work: id and name fall back to the file
 * basename, and description falls back to the first Markdown line.
 *
 * @param {string} rulesDir absolute path to the rules directory
 * @param {{fileNames?: string[]}} [options] `fileNames` overrides the scan; it
 *   exists so the case-collision check can be exercised on a filesystem that
 *   cannot hold colliding names in the first place.
 * @returns {{id: string, name: string, description: string, file: string, sourcePath: string, postInstall: string[]}[]}
 */
export function loadRules(rulesDir, { fileNames: overrideNames } = {}) {
  const fileNames = (
    overrideNames ??
    readdirSync(rulesDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.toLowerCase().endsWith('.md') &&
          !entry.name.startsWith('.'),
      )
      .map((entry) => entry.name)
  ).sort(compareCodePoints);

  assertNoFileNameCollisions(fileNames);

  const rules = [];
  const seenIds = new Map();

  for (const fileName of fileNames) {
    const sourcePath = path.join(rulesDir, fileName);
    const content = readFileSync(sourcePath, 'utf8');
    const { data, body } = parseFrontmatter(content);
    const baseName = path.basename(fileName, path.extname(fileName));
    const id = asString(data.id) || baseName;
    const name = asString(data.name) || baseName;
    const description = asString(data.description) || fallbackDescription(body);
    const postInstall = asStringArray(data.postInstall);

    if (seenIds.has(id)) {
      throw new Error(
        `规则 id 重复: "${id}"（${fileName} 与 ${seenIds.get(id)}）`,
      );
    }
    seenIds.set(id, fileName);

    rules.push({
      id,
      name,
      description,
      file: fileName,
      sourcePath,
      postInstall,
    });
  }

  return rules;
}
