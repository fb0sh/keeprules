/**
 * Rule discovery and frontmatter parsing.
 *
 * Rules are plain Markdown files in `rules/`. Metadata is declared with a
 * small YAML frontmatter subset so adding a rule only requires adding a file.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

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
export function parseSimpleYaml(text) {
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
export function parseFrontmatter(content) {
  const normalized = String(content).replace(/^\uFEFF/, '');
  const match = FRONTMATTER_PATTERN.exec(normalized);

  if (!match) {
    return { data: {}, body: normalized, hasFrontmatter: false };
  }

  return {
    data: parseSimpleYaml(match[1]),
    body: normalized.slice(match[0].length),
    hasFrontmatter: true,
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
 * Read every `.md` file in `rulesDir` and build the rule registry.
 *
 * Files without frontmatter still work: id and name fall back to the file
 * basename, and description falls back to the first Markdown line.
 *
 * @param {string} rulesDir absolute path to the rules directory
 * @returns {{id: string, name: string, description: string, file: string, postInstall: string[]}[]}
 */
export function loadRules(rulesDir) {
  const fileNames = readdirSync(rulesDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith('.md') &&
        !entry.name.startsWith('.'),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const rules = [];
  const seenIds = new Map();

  for (const fileName of fileNames) {
    const content = readFileSync(path.join(rulesDir, fileName), 'utf8');
    const { data, body } = parseFrontmatter(content);
    const baseName = path.basename(fileName, path.extname(fileName));
    const id = asString(data.id) || baseName;
    const name = asString(data.name) || baseName;
    const description = asString(data.description) || fallbackDescription(body);

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
      postInstall: asStringArray(data.postInstall),
    });
  }

  return rules;
}
