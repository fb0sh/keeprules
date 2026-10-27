#!/usr/bin/env node

/**
 * keeprules — interactive installer for Coding Agent project rules.
 *
 * Usage:
 *   npx keeprules
 *   npx keeprules add [user/repo | user/repo#branch | https://github.com/user/repo]
 *
 * This file is only the process shell: read argv, drive the flow, print with
 * clack, set the exit code. Rule discovery is src/rules.js, the write policy is
 * src/install.js, the flow is src/flow.js, the picker is src/picker.js.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { RULES_DIR } from '../src/install.js';
import { RESULT, runFlow } from '../src/flow.js';
import { prompts } from '../src/prompts.js';
import { REPO_URL, fetchRules, parseSource } from '../src/remote.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const AUTHOR_EMAIL = 'fb0sh@outlook.com';

/** How a log level maps to a clack writer. */
const LOG = {
  success: (text) => p.log.success(text),
  info: (text) => p.log.info(text),
  warn: (text) => p.log.warn(text),
};

/** The terminal printer the flow writes through. */
export const printer = {
  intro() {
    p.intro(`${pc.bgCyan(pc.black(' keeprules '))} ${pc.dim(`v${packageJson.version}`)}`);
    p.log.message(
      `${pc.dim('默认仓库:')} ${REPO_URL}  ${pc.dim('作者:')} ${AUTHOR_EMAIL}`,
    );
  },

  info: (text) => p.log.info(text),

  note: (lines, title) => p.note(lines.join('\n'), title),

  spinnerStart: (text) => {
    printer.spinner = p.spinner();
    printer.spinner.start(text);
  },

  spinnerStop: (text, failed) => printer.spinner?.stop(text, failed ? 1 : 0),

  report({ outcomes, failures }) {
    for (const { level, message } of outcomes) {
      const write = LOG[level];
      if (!write) throw new Error(`未知的 outcome level: "${level}"`);
      write(message);
    }

    for (const { subject, message } of failures) {
      p.log.error(`${pc.bold(subject)} 安装失败: ${message}`);
    }
  },
};

function printHelp() {
  console.log(
    [
      `${pc.bold('keeprules')} ${pc.dim(`v${packageJson.version}`)}`,
      `${pc.dim('仓库')}: ${REPO_URL}`,
      `${pc.dim('作者')}: ${AUTHOR_EMAIL}`,
      '',
      `${pc.bold('用法')}`,
      `  ${pc.cyan('$ keeprules')}                          ${pc.dim('# 交互式安装官方规则')}`,
      `  ${pc.cyan('$ keeprules add')}                      ${pc.dim('# 同上')}`,
      `  ${pc.cyan('$ keeprules add user/repo')}            ${pc.dim('# 从任意 GitHub 仓库安装')}`,
      `  ${pc.cyan('$ keeprules add https://github.com/user/repo')}`,
      `  ${pc.cyan('$ keeprules add user/repo#branch')}     ${pc.dim('# 指定分支（默认 main）')}`,
      '',
      `${pc.bold('选项')}`,
      `  ${pc.cyan('-h, --help')}         显示帮助`,
      `  ${pc.cyan('-v, --version')}      显示版本`,
      '',
      `${pc.bold('规则来源')}`,
      `  ${pc.dim(`默认运行时从 ${REPO_URL} 的 main 分支获取（需要联网）`)}`,
      `  ${pc.dim('第三方仓库只需在 rules/ 下放带 frontmatter 的 .md 文件')}`,
      `  ${pc.dim('设置 GITHUB_TOKEN 可提高 GitHub API 限额并访问私有仓库')}`,
    ].join('\n'),
  );
}

/**
 * Read argv as one intent. Pure, so the argument surface needs no process.
 *
 * @returns {{kind: 'help'} | {kind: 'version'} | {kind: 'add', source?: string} | {kind: 'error', message: string}}
 */
export function parseArgs(argv) {
  const positional = argv.filter((arg) => !arg.startsWith('-'));
  const known = ['-h', '--help', '-v', '--version'];

  if (argv.includes('-h') || argv.includes('--help') || positional[0] === 'help') {
    return { kind: 'help' };
  }

  if (argv.includes('-v') || argv.includes('--version') || positional[0] === 'version') {
    return { kind: 'version' };
  }

  const unknown = argv.find((arg) => arg.startsWith('-') && !known.includes(arg));
  if (unknown) return { kind: 'error', message: `未知选项: ${unknown}` };

  if (positional[0] !== undefined && positional[0] !== 'add') {
    return { kind: 'error', message: `未知命令: ${positional[0]}` };
  }

  if (positional.length > 2) {
    return { kind: 'error', message: `多余的参数: ${positional.slice(2).join(' ')}` };
  }

  if (positional[1] === undefined) return { kind: 'add' };

  return { kind: 'add', source: positional[1] };
}

/**
 * Drive the flow and translate its result into an exit code.
 *
 * @param {ReturnType<typeof parseSource>} repo resolved rule source
 */
async function runAdd(repo) {
  const spinner = p.spinner();
  spinner.start(`正在从 ${repo.label} 获取规则...`);

  let rules;

  try {
    rules = await fetchRules({ source: repo.label });
  } catch (error) {
    spinner.stop('无法获取规则', 1);
    p.log.error(error.message);
    p.outro(
      pc.red(`请检查仓库地址、分支与网络后重试，或访问 ${repo.url} 查看规则。`),
    );
    return 1;
  }

  spinner.stop(`已从 ${repo.label} 获取 ${rules.length} 个规则`);

  const result = await runFlow({
    rules,
    cwd: process.cwd(),
    prompts,
    out: printer,
  });

  if (result === RESULT.cancelled) {
    // The picker draws its own cancel frame; clack's questions do not.
    p.cancel('安装已取消');
    return 0;
  }

  if (result === RESULT.failed) {
    p.outro(pc.red('部分规则安装失败，请根据上方日志修复后重试。'));
    return 1;
  }

  p.outro(
    `${pc.green('完成！')} 规则已就绪，请让 Coding Agent 阅读 ${pc.cyan(`${RULES_DIR}/`)} 目录下的规则文件。`,
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
  const intent = parseArgs(argv);

  if (intent.kind === 'help') return printHelp() ?? 0;
  if (intent.kind === 'version') {
    console.log(packageJson.version);
    return 0;
  }

  if (intent.kind === 'error') {
    console.error(pc.red(`✖ ${intent.message}`));
    console.error(pc.dim('运行 `keeprules --help` 查看用法。'));
    return 1;
  }

  let repo;

  try {
    repo = parseSource(intent.source);
  } catch (error) {
    console.error(pc.red(`✖ ${error.message}`));
    console.error(pc.dim('运行 `keeprules --help` 查看用法。'));
    return 1;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(pc.red('✖ 需要交互式终端才能运行安装向导。'));
    console.error(pc.dim('请在本地终端中执行 `npx keeprules add`。'));
    return 1;
  }

  return runAdd(repo);
}

/** Detect direct execution (npm link and global installs run through symlinks). */
function isMain() {
  if (!process.argv[1]) return false;

  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(pc.red(`✖ 发生未预期错误: ${error?.stack ?? error}`));
      process.exitCode = 1;
    });
}
