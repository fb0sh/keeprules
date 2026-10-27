#!/usr/bin/env node

/**
 * keeptidy — interactive installer for Coding Agent project rules.
 *
 * Usage:
 *   npx keeptidy
 *   npx keeptidy add
 *
 * The CLI keeps the rule registry in this file (`RULES`) and copies the
 * matching files from the package's `rules/` directory into the current
 * working directory.
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const RULES_DIR = path.join(PACKAGE_ROOT, 'rules');
const packageJson = JSON.parse(
  readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
);

/**
 * Rule registry.
 *
 * - id:          stable identifier used by the multiselect prompt
 * - name:        display name
 * - description: short hint shown next to the name
 * - file:        file name inside the package's `rules/` directory, also the
 *                target file name in the user's project
 * - postInstall: optional extra setup steps ('gitignore' ensures `/tmp/`)
 */
export const RULES = [
  {
    id: 'keeptidy',
    name: 'KEEPTIDY',
    description:
      'Coding Agent 工程卫生与资源管理规范（临时目录、Git 安全、进程清理、破坏性操作检查点等）',
    file: 'KEEPTIDY.md',
    postInstall: ['gitignore'],
  },
];

const GITIGNORE_HEADER = '# keeptidy: 临时目录';

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
 * Copy one rule file into `cwd` and run its post-install steps.
 * Existing target files are never overwritten.
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
    `${pc.bold('用法')}`,
    `  ${pc.cyan('$ keeptidy')}          ${pc.dim('# 进入交互式安装')}`,
    `  ${pc.cyan('$ keeptidy add')}      ${pc.dim('# 同上')}`,
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
    `${pc.bgCyan(pc.black(' keeptidy '))} ${pc.dim(`v${packageJson.version}`)}`,
  );
  p.log.info(`安装目标: ${pc.cyan(cwd)}`);

  const selection = await p.multiselect({
    message: '选择要安装的规则（空格选择，回车确认）',
    options: RULES.map((rule) => ({
      value: rule.id,
      label: rule.name,
      hint: rule.description,
    })),
    initialValues: RULES.map((rule) => rule.id),
    required: true,
  });

  if (p.isCancel(selection)) {
    p.cancel('安装已取消');
    return 0;
  }

  const selectedRules = RULES.filter((rule) => selection.includes(rule.id));

  if (selectedRules.length === 0) {
    p.cancel('未选择任何规则，安装已取消');
    return 0;
  }

  p.note(
    selectedRules
      .map((rule) => `${pc.green('•')} ${pc.bold(rule.name)} → ${rule.file}`)
      .join('\n'),
    '即将安装',
  );

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

  for (const rule of selectedRules) {
    try {
      results.push(installRule(rule, cwd));
    } catch (error) {
      failures.push({ rule, error });
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

  for (const { rule, error } of failures) {
    p.log.error(`${pc.bold(rule.name)} 安装失败: ${error.message}`);
  }

  if (failures.length > 0) {
    p.outro(pc.red('部分规则安装失败，请根据上方日志修复后重试。'));
    return 1;
  }

  p.outro(
    `${pc.green('完成！')} 规则已就绪，请让 Coding Agent 阅读项目中的规则文件。`,
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
    console.error(pc.dim('运行 `keeptidy --help` 查看用法。'));
    return 1;
  }

  const command = positional[0];
  if (command !== undefined && command !== 'add') {
    console.error(pc.red(`✖ 未知命令: ${command}`));
    console.error(pc.dim('运行 `keeptidy --help` 查看用法。'));
    return 1;
  }

  if (positional.length > 1) {
    console.error(pc.red(`✖ 多余的参数: ${positional.slice(1).join(' ')}`));
    return 1;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(pc.red('✖ 需要交互式终端才能运行安装向导。'));
    console.error(pc.dim('请在本地终端中执行 `npx keeptidy add`。'));
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
