/**
 * Install: copy the selected rules into the project, then run the
 * project-level steps those rules declare.
 *
 * This is the whole write policy in one place — where rules land, how the
 * `.gitignore` and `AGENTS.md` blocks are written, what gets reported. There are
 * exactly two steps, so they are two functions, not a plugin system.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Rules are copied into a dedicated directory, not the project root. */
export const RULES_DIR = 'rules';

/** Project-relative destination for a rule file, e.g. `rules/KEEPTIDY.md`. */
export function ruleTargetPath(rule) {
  return path.posix.join(RULES_DIR, rule.file);
}

// ── file helpers ────────────────────────────────────────────────────────────

/** Read a file with its path, existence, and line-ending convention. */
function open(filePath) {
  const exists = existsSync(filePath);
  const content = exists ? readFileSync(filePath, 'utf8') : '';
  const eol = content.includes('\r\n') ? '\r\n' : '\n';

  return {
    path: filePath,
    exists,
    content,
    eol,
    /** Write `text` (which uses \n) in this file's convention. */
    render: (text) => text.split('\n').join(eol),
  };
}

/** Append rendered text, keeping the file's existing blank-line style. */
function append(file, text) {
  const block = file.render(text) + file.eol;

  let separator = '';
  if (file.content.length > 0) {
    if (file.content.endsWith(`${file.eol}${file.eol}`)) separator = '';
    else if (file.content.endsWith('\n')) separator = file.eol;
    else separator = `${file.eol}${file.eol}`;
  }

  writeFileSync(file.path, file.content + separator + block, 'utf8');
}

// ── step: .gitignore ────────────────────────────────────────────────────────

const GITIGNORE_BLOCK = ['# keeprules: 临时目录', '/tmp/'];

/** Does this ignore file already cover the project `tmp/` directory? */
function hasTmpEntry(content) {
  return content.split(/\r?\n/).some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) return false;

    return line.replace(/^\/+/, '').replace(/\/+$/, '') === 'tmp';
  });
}

function addTmpIgnore(cwd) {
  const file = open(path.join(cwd, '.gitignore'));

  if (hasTmpEntry(file.content)) {
    return { level: 'info', message: '.gitignore 已包含 /tmp/ 规则，无需修改' };
  }

  append(file, GITIGNORE_BLOCK.join('\n'));

  return {
    level: 'success',
    message: file.exists
      ? '已向 .gitignore 补充 /tmp/ 规则'
      : '已创建 .gitignore 并添加 /tmp/ 规则',
  };
}

// ── step: AGENTS.md reference block ─────────────────────────────────────────

const AGENTS_START = '<!-- keeprules:start -->';
const AGENTS_END = '<!-- keeprules:end -->';
const AGENTS_FOOTER =
  'These rules are mandatory for all Coding Agents working in this repository.';

/** One `## NAME` section pointing at the installed rule file. */
function renderSection(rule) {
  const target = ruleTargetPath(rule);
  return `## ${rule.name}\n\nFollow the ${rule.name} rules defined in [${target}](./${target}).`;
}

/** The whole marked block, for these rules plus any preserved sections. */
function renderBlock(rules, preserved = []) {
  const sections = [...rules.map(renderSection), ...preserved];

  return [
    AGENTS_START,
    ...sections.flatMap((section, index) =>
      index === 0 ? [section] : ['', section],
    ),
    '',
    AGENTS_FOOTER,
    AGENTS_END,
  ].join('\n');
}

/** Split an existing block body back into its `## NAME` sections. */
function splitSections(body) {
  const sections = [];
  let current = [];

  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === AGENTS_FOOTER) continue;

    if (/^##\s+/.test(line)) {
      if (current.length > 0) sections.push(current.join('\n').trim());
      current = [line];
      continue;
    }

    current.push(line);
  }

  const tail = current.join('\n').trim();
  if (tail) sections.push(tail);

  return sections
    .map((text) => ({
      name: /^##\s+(.+)$/m.exec(text)?.[1].trim() ?? '',
      text,
    }))
    .filter((section) => section.name);
}

/**
 * Correct a root-level rule link (`[X.md](./X.md)`) written by keeprules 0.1.1,
 * which copied rules into the project root.
 */
function normalizeLinks(section) {
  return section.replace(
    /\[([^\]/]+\.md)\]\((?:(\.\/))?([^/)]+\.md)\)/g,
    (match, label, _dot, target) =>
      label === target
        ? `[${RULES_DIR}/${target}](./${RULES_DIR}/${target})`
        : match,
  );
}

function addAgentReferences(rules, cwd) {
  if (rules.length === 0) {
    return {
      level: 'info',
      message: '没有成功安装的规则可引用，已跳过 AGENTS.md',
    };
  }

  const file = open(path.join(cwd, 'AGENTS.md'));
  const start = file.content.indexOf(AGENTS_START);
  const end = file.content.indexOf(AGENTS_END);

  // No block yet: append one.
  if (start === -1 || end === -1 || end < start) {
    if (file.content.includes(AGENTS_START)) {
      return { level: 'info', message: 'AGENTS.md 中已存在 keeprules 引用，无需修改' };
    }

    append(file, renderBlock(rules));

    return {
      level: 'success',
      message: file.exists
        ? '已向 AGENTS.md 追加规则引用'
        : '已创建 AGENTS.md 并添加规则引用',
    };
  }

  // Rewrite the block in place, keeping rules an earlier run referenced.
  const selected = new Set(rules.map((rule) => rule.name));
  const preserved = splitSections(
    file.content.slice(start + AGENTS_START.length, end),
  )
    .filter((section) => !selected.has(section.name))
    .map((section) => normalizeLinks(section.text));

  const rendered = file.render(renderBlock(rules, preserved));
  const next =
    file.content.slice(0, start) +
    rendered +
    file.content.slice(end + AGENTS_END.length);

  if (next === file.content) {
    return { level: 'info', message: 'AGENTS.md 中已存在 keeprules 引用，无需修改' };
  }

  writeFileSync(file.path, next, 'utf8');
  return { level: 'success', message: '已更新 AGENTS.md 中的规则引用' };
}

// ── steps registry ──────────────────────────────────────────────────────────

/**
 * The project-level steps an install can perform, keyed by the name a rule
 * writes in its `postInstall` list.
 *
 * `automatic` steps run whenever a selected rule declares them; a step with a
 * `prompt` runs only after the user agrees.
 */
const STEPS = {
  gitignore: { automatic: true, run: (_rules, cwd) => addTmpIgnore(cwd) },
  agents: {
    prompt: '是否在 AGENTS.md 中添加引用？',
    declined: '已跳过 AGENTS.md 引用',
    run: (rules, cwd) => addAgentReferences(rules, cwd),
  },
};

/** Reject a `postInstall` name no step implements. */
export function assertKnownSteps(names, source) {
  for (const name of names) {
    if (!Object.hasOwn(STEPS, name)) {
      throw new Error(
        `${source} 包含不支持的 postInstall 步骤: "${name}"。支持: ${Object.keys(
          STEPS,
        ).join(', ')}`,
      );
    }
  }
}

/** The steps these rules declare, in registry order. */
function declaredBy(rules) {
  return Object.entries(STEPS)
    .filter(([name]) => rules.some((rule) => rule.postInstall?.includes(name)))
    .map(([name, step]) => ({ name, ...step }));
}

/** The opt-in steps to ask the user about, for this selection. */
export function promptSteps(rules) {
  return declaredBy(rules)
    .filter((step) => step.prompt)
    .map(({ name, prompt, declined }) => ({ name, prompt, declined }));
}

// ── install ─────────────────────────────────────────────────────────────────

/** Fail two rules that would write the same file on a case-insensitive disk. */
function claimTargets(rules) {
  const claimed = new Map();
  const installable = [];
  const failures = [];

  for (const rule of rules) {
    const target = ruleTargetPath(rule);
    const owner = claimed.get(target.toLowerCase());

    if (owner) {
      failures.push({
        subject: rule.name,
        message:
          `目标文件冲突: "${ruleTargetPath(owner)}" 与 "${target}" ` +
          '在大小写不敏感的文件系统上是同一个文件，请重命名其中一个规则。',
      });
      continue;
    }

    claimed.set(target.toLowerCase(), rule);
    installable.push(rule);
  }

  return { installable, failures };
}

/** Write one rule file, unless it is already there. */
function writeRule(rule, cwd) {
  assertKnownSteps(rule.postInstall ?? [], `规则 ${rule.file}`);

  if (typeof rule.content !== 'string') {
    throw new Error(`规则内容缺失: ${rule.file}`);
  }

  const relative = ruleTargetPath(rule);
  const target = path.join(cwd, relative);

  if (existsSync(target)) {
    return {
      level: 'warn',
      message: `${relative} 已存在，已跳过（未覆盖现有文件；项目级规则步骤照常执行）`,
    };
  }

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, rule.content, 'utf8');

  return { level: 'success', message: `${rule.name} → ${relative}` };
}

/**
 * Install the selected rules, then run the steps they declare.
 *
 * Policy:
 * - An existing rule file is never overwritten.
 * - Steps run for every *selected* rule that declares them, even when a copy
 *   was skipped — they assert project invariants, not the rule's contents.
 * - `confirmed` names the opt-in steps the user agreed to; a step that was not
 *   confirmed never runs.
 * - One failure never stops the others.
 *
 * @param {object} options
 * @param {object[]} options.rules selected rules
 * @param {string} options.cwd target project
 * @param {string[]} [options.confirmed] opt-in step names the user accepted
 * @returns {{outcomes: {level: string, message: string}[], failures: {subject: string, message: string}[]}}
 */
export function installSelection({ rules, cwd, confirmed = [] }) {
  assertKnownSteps(confirmed, `选项 ${confirmed.join(', ')}`);

  const outcomes = [];
  const failures = [];

  const claim = claimTargets(rules);
  failures.push(...claim.failures);

  const installed = [];

  for (const rule of claim.installable) {
    try {
      outcomes.push(writeRule(rule, cwd));
      installed.push(rule);
    } catch (error) {
      failures.push({ subject: rule.name, message: error.message });
    }
  }

  for (const step of declaredBy(rules)) {
    const enabled = step.automatic || confirmed.includes(step.name);
    if (!enabled) continue;

    try {
      outcomes.push(step.run(installed, cwd));
    } catch (error) {
      failures.push({ subject: step.name, message: error.message });
    }
  }

  return { outcomes, failures };
}
