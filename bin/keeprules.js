#!/usr/bin/env node

/**
 * keeprules — interactive installer for Coding Agent project rules.
 *
 * Usage:
 *   npx keeprules
 *   npx keeprules add
 *
 * Rules are auto-registered from `rules/*.md` frontmatter and copied into the
 * current working directory.
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  CANCEL as RULE_SELECTION_CANCEL,
  ruleMultiselect,
} from '../src/prompts/rule-multiselect.js';
import { loadRules } from '../src/rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const RULES_DIR = path.join(PACKAGE_ROOT, 'rules');
const packageJson = JSON.parse(
  readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
);

const PROJECT_URL = 'https://github.com/fb0sh/keeprules';
const AUTHOR_EMAIL = 'fb0sh@outlook.com';

/**
 * Rule registry loaded from `rules/*.md` frontmatter at startup.
 * See src/rules.js for the supported frontmatter keys.
 */
export const RULES = loadRules(RULES_DIR);

const GITIGNORE_HEADER = '# keeprules: 临时目录';

const AGENTS_FILE = 'AGENTS.md';
const AGENTS_MARKER_START = '<!-- keeprules:start -->';
const AGENTS_MARKER_END = '<!-- keeprules:end -->';

/**
 * Build the marked AGENTS.md block for all selected rules that opt into
 * `postInstall: ['agents']`.
 */
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
 * Ensure `.gitignore` contains a `/tmp/` entry without touching existing
 * rules. Creates the file when it does not exist yet.
 *
 * @returns {{status: 'created' | 'updated' | 'exists', path: string}}
 */
export function ensureGitignoreTmp(cwd) {
  const gitignorePath = path.join(cwd, '.gitignore');
  const fileExists = existsSync(gitignorePath);
  const content = fileExists ? readFileSync(gitignorePath, 'utf8') : '';

  if (hasTmpIgnoreRule(content)) {
    return { status: 'exists', path: gitignorePath };
  }

  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const separator =
    content.length === 0 ? '' : content.endsWith('\n') ? eol : `${eol}${eol}`;
  const block = [GITIGNORE_HEADER, '/tmp/'].join(eol) + eol;

  writeFileSync(gitignorePath, content + separator + block, 'utf8');

  return { status: fileExists ? 'updated' : 'created', path: gitignorePath };
}

/**
 * Ensure AGENTS.md references the selected rule files inside a marked block.
 * Existing user content is preserved and an existing block is never duplicated.
 *
 * @param {string} cwd target project directory
 * @param {object[]} rules rules that should be referenced
 * @returns {{status: 'created' | 'appended' | 'exists', path: string}}
 */
export function ensureAgentsReference(cwd, rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('没有可写入 AGENTS.md 的规则');
  }

  const agentsPath = path.join(cwd, AGENTS_FILE);
  const fileExists = existsSync(agentsPath);
  const content = fileExists ? readFileSync(agentsPath, 'utf8') : '';

  if (content.includes(AGENTS_MARKER_START)) {
    return { status: 'exists', path: agentsPath };
  }

  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const block = buildAgentsBlock(rules).split('\n').join(eol) + eol;

  if (content.length === 0) {
    writeFileSync(agentsPath, block, 'utf8');
    return { status: 'created', path: agentsPath };
  }

  // Separate the new block from existing content with exactly one blank line.
  let separator;
  if (content.endsWith(`${eol}${eol}`)) {
    separator = '';
  } else if (content.endsWith('\n')) {
    separator = eol;
  } else {
    separator = `${eol}${eol}`;
  }

  writeFileSync(agentsPath, content + separator + block, 'utf8');
  return { status: 'appended', path: agentsPath };
}

/**
 * Copy one rule file into `cwd` and run its per-rule post-install steps.
 * Existing target files are never overwritten. The collective AGENTS.md step
 * is handled separately because it may reference several selected rules.
 *
 * @param {object} rule rule definition loaded from rules/
 * @param {string} cwd target project directory
 *
 * @returns {{
 *   rule: object,
 *   target: string,
 *   copied: boolean,
 *   skipped: boolean,
 *   gitignore: {status: string, path: string} | null,
 * }}
 */
export function installRule(rule, cwd) {
  const source = path.join(RULES_DIR, rule.file);
  if (!existsSync(source)) {
    throw new Error(`规则文件缺失: ${source}`);
  }

  const target = path.join(cwd, rule.file);
  const result = {
    rule,
    target,
    copied: false,
    skipped: false,
    gitignore: null,
  };

  if (existsSync(target)) {
    result.skipped = true;
  } else {
    copyFileSync(source, target);
    result.copied = true;
  }

  if (Array.isArray(rule.postInstall) && rule.postInstall.includes('gitignore')) {
    result.gitignore = ensureGitignoreTmp(cwd);
  }

  return result;
}

export function printHelp() {
  const usage = [
    `${pc.bold('keeprules')} ${pc.dim(`v${packageJson.version}`)}`,
    `${pc.dim('仓库')}: ${PROJECT_URL}`,
    `${pc.dim('作者')}: ${AUTHOR_EMAIL}`,
    '',
    `${pc.bold('用法')}`,
    `  ${pc.cyan('$ keeprules')}          ${pc.dim('# 进入交互式安装')}`,
    `  ${pc.cyan('$ keeprules add')}      ${pc.dim('# 同上')}`,
    '',
    `${pc.bold('选项')}`,
    `  ${pc.cyan('-h, --help')}         显示帮助`,
    `  ${pc.cyan('-v, --version')}      显示版本`,
    '',
    `${pc.bold('可用规则')}`,
    ...RULES.map(
      (rule) => `  ${pc.green(rule.name)}  ${pc.dim(`(${rule.file})`)}\n    ${rule.description}`,
    ),
  ].join('\n');

  console.log(usage);
}

/** Interactive install flow. */
async function runAdd() {
  const cwd = process.cwd();

  p.intro(
    `${pc.bgCyan(pc.black(' keeprules '))} ${pc.dim(`v${packageJson.version}`)}`,
  );
  p.log.message(
    `${pc.dim('仓库:')} ${PROJECT_URL}  ${pc.dim('作者:')} ${AUTHOR_EMAIL}`,
  );
  p.log.info(`安装目标: ${pc.cyan(cwd)}`);

  const selection = await ruleMultiselect({
    message: '选择要安装的规则',
    items: RULES.map((rule) => ({
      value: rule.id,
      label: rule.name,
      description: rule.description,
    })),
    // Nothing is selected by default; users opt in explicitly.
    initialSelected: [],
    required: true,
  });

  if (selection === RULE_SELECTION_CANCEL) {
    // The custom prompt renders its own cancel state.
    return 0;
  }

  const selectedRules = RULES.filter((rule) => selection.includes(rule.id));

  if (selectedRules.length === 0) {
    p.cancel('未选择任何规则，安装已取消');
    return 0;
  }

  // Rules that opt into an AGENTS.md reference block.
  const agentsRules = selectedRules.filter((rule) =>
    rule.postInstall?.includes('agents'),
  );
  let addAgentsReference = false;

  if (agentsRules.length > 0) {
    const answer = await p.confirm({
      message: '是否在 AGENTS.md 中添加引用？',
      initialValue: true,
    });

    if (p.isCancel(answer)) {
      p.cancel('安装已取消');
      return 0;
    }

    addAgentsReference = answer;
  }

  const previewLines = selectedRules.map(
    (rule) => `${pc.green('•')} ${pc.bold(rule.name)} → ${rule.file}`,
  );

  p.note(previewLines.join('\n'), '即将安装');

  // AGENTS.md is not a copied file, so keep it as a lightweight note rather
  // than mixing it into the list of rule files above.
  if (addAgentsReference) {
    p.log.message(pc.dim('并在 AGENTS.md 中添加引用'));
  }

  const confirmed = await p.confirm({
    message: `确认安装以上 ${selectedRules.length} 个规则？`,
    initialValue: true,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('安装已取消');
    return 0;
  }

  const spinner = p.spinner();
  spinner.start('正在安装规则...');

  const results = [];
  const failures = [];
  let agentsResult = null;

  for (const rule of selectedRules) {
    try {
      results.push(installRule(rule, cwd));
    } catch (error) {
      failures.push({ rule, error });
    }
  }

  // The AGENTS.md block is written once so multiple selected rules can be
  // referenced in a single marked section.
  if (addAgentsReference && agentsRules.length > 0) {
    try {
      agentsResult = ensureAgentsReference(cwd, agentsRules);
    } catch (error) {
      failures.push({ rule: { name: 'AGENTS.md' }, error });
    }
  }

  spinner.stop(
    failures.length > 0 ? '安装未完全成功' : '规则安装完成',
    failures.length > 0 ? 1 : 0,
  );

  for (const result of results) {
    if (result.copied) {
      p.log.success(
        `${pc.bold(result.rule.name)} → ${pc.cyan(result.rule.file)}`,
      );
    } else if (result.skipped) {
      p.log.warn(
        `${pc.cyan(result.rule.file)} 已存在，已跳过（未覆盖现有文件）`,
      );
    }

    if (result.gitignore?.status === 'created') {
      p.log.success('已创建 .gitignore 并添加 /tmp/ 规则');
    } else if (result.gitignore?.status === 'updated') {
      p.log.success('已向 .gitignore 补充 /tmp/ 规则');
    } else if (result.gitignore?.status === 'exists') {
      p.log.info('.gitignore 已包含 /tmp/ 规则，无需修改');
    }
  }

  if (agentsResult?.status === 'created') {
    p.log.success('已创建 AGENTS.md 并添加规则引用');
  } else if (agentsResult?.status === 'appended') {
    p.log.success('已向 AGENTS.md 追加规则引用');
  } else if (agentsResult?.status === 'exists') {
    p.log.info('AGENTS.md 中已存在 keeprules 引用');
  }

  if (agentsRules.length > 0 && !addAgentsReference) {
    p.log.info('已跳过 AGENTS.md 引用');
  }

  for (const { rule, error } of failures) {
    p.log.error(`${pc.bold(rule.name)} 安装失败: ${error.message}`);
  }

  if (failures.length > 0) {
    p.outro(pc.red('部分规则安装失败，请根据上方日志修复后重试。'));
    return 1;
  }

  p.outro(
    `${pc.green('完成！')} 规则已就绪。${pc.dim(`仓库: ${PROJECT_URL}`)}`,
  );
  return 0;
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv arguments without `node` and the script path
 * @returns {Promise<number>} process exit code
 */
export async function main(argv = process.argv.slice(2)) {
  const positional = argv.filter((arg) => !arg.startsWith('-'));
  const unknownFlag = argv.find(
    (arg) => arg.startsWith('-') && !['-h', '--help', '-v', '--version'].includes(arg),
  );

  if (argv.includes('-h') || argv.includes('--help') || positional[0] === 'help') {
    printHelp();
    return 0;
  }

  if (
    argv.includes('-v') ||
    argv.includes('--version') ||
    positional[0] === 'version'
  ) {
    console.log(packageJson.version);
    return 0;
  }

  if (unknownFlag) {
    console.error(pc.red(`✖ 未知选项: ${unknownFlag}`));
    console.error(pc.dim('运行 `keeprules --help` 查看用法。'));
    return 1;
  }

  const command = positional[0];
  if (command !== undefined && command !== 'add') {
    console.error(pc.red(`✖ 未知命令: ${command}`));
    console.error(pc.dim('运行 `keeprules --help` 查看用法。'));
    return 1;
  }

  if (positional.length > 1) {
    console.error(pc.red(`✖ 多余的参数: ${positional.slice(1).join(' ')}`));
    return 1;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(pc.red('✖ 需要交互式终端才能运行安装向导。'));
    console.error(pc.dim('请在本地终端中执行 `npx keeprules add`。'));
    return 1;
  }

  return runAdd();
}

/**
 * Detect direct execution. `realpathSync` keeps this working through the
 * symlink created by `npm link` and by global installs.
 */
function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(pc.red(`✖ 发生未预期错误: ${error?.stack ?? error}`));
      process.exitCode = 1;
    });
}
