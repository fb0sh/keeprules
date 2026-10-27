/**
 * Deep install module: rule data in, one install report out.
 *
 * This module owns the file-write policy for copied rules, managed append
 * blocks, and the per-rule versus collective postInstall split. It performs
 * no prompts, rendering, or process exit handling.
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  POST_INSTALL_STEPS,
  assertSupportedPostInstall,
} from './rule-capabilities.js';

const GITIGNORE_HEADER = '# keeprules: 临时目录';
const AGENTS_FILE = 'AGENTS.md';
const AGENTS_MARKER_START = '<!-- keeprules:start -->';
const AGENTS_MARKER_END = '<!-- keeprules:end -->';

/** Build the marked AGENTS.md block for selected rules. */
export function buildAgentsBlock(rules) {
  const sections = rules.map((rule) =>
    [
      `## ${rule.name}`,
      '',
      `Follow the ${rule.name} rules defined in [${rule.file}](./${rule.file}).`,
    ].join('\n'),
  );

  return [
    AGENTS_MARKER_START,
    ...sections.flatMap((section, index) =>
      index === 0 ? [section] : ['', section],
    ),
    '',
    'These rules are mandatory for all Coding Agents working in this repository.',
    AGENTS_MARKER_END,
  ].join('\n');
}

/**
 * Check whether a .gitignore already ignores the project `tmp/` directory.
 * Accepts common equivalent spellings: `tmp`, `tmp/`, `/tmp`, `/tmp/`.
 */
export function hasTmpIgnoreRule(content) {
  return content.split(/\r?\n/).some((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) {
      return false;
    }

    const normalized = line.replace(/^\/+/, '').replace(/\/+$/, '');
    return normalized === 'tmp';
  });
}

/**
 * Append a managed block once, preserving existing content and line endings.
 *
 * @returns {{status: 'created' | 'appended' | 'exists', path: string}}
 */
function appendManagedBlock({ filePath, block, isPresent }) {
  const fileExists = existsSync(filePath);
  const content = fileExists ? readFileSync(filePath, 'utf8') : '';

  if (isPresent(content)) {
    return { status: 'exists', path: filePath };
  }

  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const renderedBlock = block.split('\n').join(eol) + eol;

  let separator = '';
  if (content.length > 0) {
    if (content.endsWith(`${eol}${eol}`)) {
      separator = '';
    } else if (content.endsWith('\n')) {
      separator = eol;
    } else {
      separator = `${eol}${eol}`;
    }
  }

  writeFileSync(filePath, content + separator + renderedBlock, 'utf8');
  return { status: fileExists ? 'appended' : 'created', path: filePath };
}

/**
 * Ensure `.gitignore` contains `/tmp/` without touching existing rules.
 *
 * @returns {{status: 'created' | 'updated' | 'exists', path: string}}
 */
export function ensureGitignoreTmp(cwd) {
  const result = appendManagedBlock({
    filePath: path.join(cwd, '.gitignore'),
    block: [GITIGNORE_HEADER, '/tmp/'].join('\n'),
    isPresent: hasTmpIgnoreRule,
  });

  return {
    status: result.status === 'appended' ? 'updated' : result.status,
    path: result.path,
  };
}

/**
 * Ensure AGENTS.md references the selected rule files inside one marked block.
 *
 * @returns {{status: 'created' | 'appended' | 'exists', path: string}}
 */
export function ensureAgentsReference(cwd, rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('没有可写入 AGENTS.md 的规则');
  }

  return appendManagedBlock({
    filePath: path.join(cwd, AGENTS_FILE),
    block: buildAgentsBlock(rules),
    isPresent: (content) => content.includes(AGENTS_MARKER_START),
  });
}

/** Per-rule postInstall handlers. */
const PER_RULE_HANDLERS = {
  gitignore: (_rule, cwd) => ensureGitignoreTmp(cwd),
};

/** Collective postInstall handlers; each runs once for all matching rules. */
const COLLECTIVE_HANDLERS = {
  agents: (rules, cwd) => ensureAgentsReference(cwd, rules),
};

/**
 * Copy one rule file and run its per-rule postInstall steps.
 *
 * @param {object} rule loaded rule with a sourcePath
 * @param {string} cwd target project directory
 * @returns {{
 *   rule: object,
 *   target: string,
 *   copied: boolean,
 *   skipped: boolean,
 *   postInstall: Record<string, {status: string, path: string}>,
 * }}
 */
export function installRule(rule, cwd) {
  assertSupportedPostInstall(rule.postInstall ?? [], rule.file);

  if (!rule.sourcePath || !existsSync(rule.sourcePath)) {
    throw new Error(`规则文件缺失: ${rule.sourcePath ?? rule.file}`);
  }

  const target = path.join(cwd, rule.file);
  const result = {
    rule,
    target,
    copied: false,
    skipped: false,
    postInstall: {},
  };

  if (existsSync(target)) {
    result.skipped = true;
  } else {
    copyFileSync(rule.sourcePath, target);
    result.copied = true;
  }

  for (const step of rule.postInstall ?? []) {
    if (POST_INSTALL_STEPS[step].scope !== 'rule') continue;
    const handler = PER_RULE_HANDLERS[step];
    if (!handler) {
      throw new Error(`postInstall 步骤缺少处理器: ${step}`);
    }
    result.postInstall[step] = handler(rule, cwd);
  }

  return result;
}

/**
 * Install every selected rule, then run each enabled collective step once.
 *
 * @param {object} options
 * @param {object[]} options.rules selected rule entries
 * @param {string} options.cwd target project directory
 * @param {Record<string, boolean>} [options.collective] enabled collective steps
 * @returns {{
 *   results: object[],
 *   collective: Record<string, {status: string, path: string}>,
 *   failures: {rule: object, error: Error}[],
 * }}
 */
export function installSelection({ rules, cwd, collective = {} }) {
  const results = [];
  const failures = [];
  const collectiveResults = {};

  for (const rule of rules) {
    try {
      results.push(installRule(rule, cwd));
    } catch (error) {
      failures.push({ rule, error });
    }
  }

  for (const [step, handler] of Object.entries(COLLECTIVE_HANDLERS)) {
    if (!collective[step]) continue;

    const matchingRules = rules.filter((rule) =>
      rule.postInstall?.includes(step),
    );
    if (matchingRules.length === 0) continue;

    try {
      collectiveResults[step] = handler(matchingRules, cwd);
    } catch (error) {
      failures.push({
        rule: { name: step === 'agents' ? 'AGENTS.md' : step },
        error,
      });
    }
  }

  return { results, collective: collectiveResults, failures };
}
