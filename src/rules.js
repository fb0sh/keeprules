/**
 * Rule parsing.
 *
 * A rule is a Markdown file with a small YAML frontmatter subset. This module
 * turns file contents into rule records and rejects a bad set — it never reads
 * the disk or the network, so it is driven by whatever the caller fetched.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Compare by code point: stable across platforms and locales. */
function byCodePoint(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Parse a quoted or plain YAML scalar. */
function parseScalar(raw) {
  const value = raw.trim();

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
 * Parse the YAML subset used by frontmatter:
 *   key: value
 *   key:
 *     - item
 *   key: [a, b]
 *
 * Anything more complex is ignored rather than executed.
 */
function parseYaml(text) {
  const data = {};
  let key = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(parseScalar(item[1]));
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;

    [, key] = pair;
    data[key] = pair[2] === '' ? null : parseScalar(pair[2]);
  }

  return data;
}

/** Split frontmatter from the Markdown body. */
function parseFrontmatter(content) {
  const text = String(content).replace(/^\uFEFF/, '');
  const match = FRONTMATTER.exec(text);

  if (!match) return { data: {}, body: text };

  return { data: parseYaml(match[1]), body: text.slice(match[0].length) };
}

/** Use the first meaningful Markdown line when no description is declared. */
function firstLine(body) {
  const line = body
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith('<!--'));

  return line ? line.replace(/^#+\s*/, '').trim() : '';
}

const asString = (value) => (typeof value === 'string' ? value.trim() : '');

function asList(value) {
  if (Array.isArray(value)) {
    return value.map(asString).filter((entry) => entry !== '');
  }

  const single = asString(value);
  return single ? [single] : [];
}

/**
 * Reject names that would be the same file on a case-insensitive disk.
 *
 * macOS and Windows do not distinguish `RULE.md` from `rule.md`, so such a pair
 * writes one file twice and the reference block links it under two names.
 */
function assertDistinctFiles(files) {
  const seen = new Map();

  for (const file of files) {
    const key = file.toLowerCase();

    if (seen.has(key)) {
      throw new Error(
        `规则文件名大小写冲突: "${seen.get(key)}" 与 "${file}"。` +
          'macOS 与 Windows 的文件系统默认不区分大小写，这两个规则会写入同一个文件。请重命名其中一个。',
      );
    }

    seen.set(key, file);
  }
}

/**
 * Build the rule registry from file contents.
 *
 * @param {{file: string, content: string}[]} files rule files, already fetched
 * @returns {{id: string, name: string, description: string, file: string, content: string, postInstall: string[]}[]}
 */
export function loadRules(files) {
  const markdown = files
    .filter((entry) => entry.file.toLowerCase().endsWith('.md'))
    .sort((a, b) => byCodePoint(a.file, b.file));

  assertDistinctFiles(markdown.map((entry) => entry.file));

  const rules = [];
  const seen = new Map();

  for (const { file, content } of markdown) {
    const { data, body } = parseFrontmatter(content);
    const base = file.replace(/\.md$/i, '');
    const id = asString(data.id) || base;

    if (seen.has(id)) {
      throw new Error(`规则 id 重复: "${id}"（${file} 与 ${seen.get(id)}）`);
    }
    seen.set(id, file);

    rules.push({
      id,
      name: asString(data.name) || base,
      description: asString(data.description) || firstLine(body),
      file,
      content,
      postInstall: asList(data.postInstall),
    });
  }

  return rules;
}
