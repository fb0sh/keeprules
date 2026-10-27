#!/usr/bin/env node

/**
 * keeprules — interactive installer for Coding Agent project rules.
 *
 * Usage:
 *   npx keeprules
 *   npx keeprules add
 *
 * This module is the composition root: argv parsing, prompt wiring, and
 * status printing. Rule discovery lives in src/rules.js and file-write policy
 * lives in src/install.js.
 */

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadRules } from '../src/rules.js';
import { installSelection } from '../src/install.js';
import {
  CANCELLED,
  promptSession,
} from '../src/prompts/prompt-session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const RULES_DIR = path.join(PACKAGE_ROOT, 'rules');
const packageJson = JSON.parse(
  readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
);

const PROJECT_URL = 'https://github.com/fb0sh/keeprules';
const AUTHOR_EMAIL = 'fb0sh@outlook.com';

/** Rules are auto-registered from `rules/*.md` frontmatter at startup. */
const RULES = loadRules(RULES_DIR);

function printHelp() {
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

  const selection = await promptSession.selectRules({
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

  if (selection === CANCELLED) {
    // The custom picker renders its own cancel state.
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
    const answer = await promptSession.confirm({
      message: '是否在 AGENTS.md 中添加引用？',
      initialValue: true,
    });

    if (answer === CANCELLED) {
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

  const confirmed = await promptSession.confirm({
    message: `确认安装以上 ${selectedRules.length} 个规则？`,
    initialValue: true,
  });

  if (confirmed === CANCELLED || !confirmed) {
    p.cancel('安装已取消');
    return 0;
  }

  const spinner = p.spinner();
  spinner.start('正在安装规则...');

  const report = installSelection({
    rules: selectedRules,
    cwd,
    collective: { agents: addAgentsReference },
  });

  spinner.stop(
    report.failures.length > 0 ? '安装未完全成功' : '规则安装完成',
    report.failures.length > 0 ? 1 : 0,
  );

  for (const result of report.results) {
    if (result.copied) {
      p.log.success(
        `${pc.bold(result.rule.name)} → ${pc.cyan(result.rule.file)}`,
      );
    } else if (result.skipped) {
      p.log.warn(
        `${pc.cyan(result.rule.file)} 已存在，已跳过（未覆盖现有文件）`,
      );
    }

    const gitignore = result.postInstall.gitignore;
    if (gitignore?.status === 'created') {
      p.log.success('已创建 .gitignore 并添加 /tmp/ 规则');
    } else if (gitignore?.status === 'updated') {
      p.log.success('已向 .gitignore 补充 /tmp/ 规则');
    } else if (gitignore?.status === 'exists') {
      p.log.info('.gitignore 已包含 /tmp/ 规则，无需修改');
    }
  }

  const agentsResult = report.collective.agents;
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

  for (const { rule, error } of report.failures) {
    p.log.error(`${pc.bold(rule.name)} 安装失败: ${error.message}`);
  }

  if (report.failures.length > 0) {
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
    (arg) =>
      arg.startsWith('-') && !['-h', '--help', '-v', '--version'].includes(arg),
  );

  if (
    argv.includes('-h') ||
    argv.includes('--help') ||
    positional[0] === 'help'
  ) {
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
