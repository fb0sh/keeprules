import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = path.join(ROOT, 'tmp', 'runs');
const BIN = path.join(ROOT, 'bin', 'keeprules.js');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: options.cwd ?? ROOT,
    env: {
      ...process.env,
      // Windows reads TEMP/TMP rather than TMPDIR.
      TMPDIR: path.join(TMP_ROOT, 'spawn'),
      TEMP: path.join(TMP_ROOT, 'spawn'),
      TMP: path.join(TMP_ROOT, 'spawn'),
      ...options.env,
    },
  });
}

test('--help prints usage and points at the rule source', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /用法/);
  assert.match(result.stdout, /https:\/\/github\.com\/fb0sh\/keeprules/);
  assert.match(result.stdout, /fb0sh@outlook\.com/);
  assert.match(result.stdout, /需要联网/);
  assert.match(result.stdout, /add user\/repo/);
  assert.match(result.stdout, /第三方仓库/);
});

test('--version prints the package version', () => {
  const result = runCli(['--version']);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test('unknown commands and flags exit non-zero', () => {
  const command = runCli(['nope']);
  const flag = runCli(['--nope']);

  assert.equal(command.status, 1);
  assert.match(command.stderr, /未知命令/);
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /未知选项/);
});

test('a failed rule download leaves local rule files untouched', async () => {
  const { main } = await import('../bin/keeprules.js');
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  const originalFetch = globalThis.fetch;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;
  const originalSetRawMode = process.stdin.setRawMode;

  mkdirSync(TMP_ROOT, { recursive: true });
  const project = mkdtempSync(path.join(TMP_ROOT, 'clone-failure-'));
  mkdirSync(path.join(project, 'rules'));
  mkdirSync(path.join(project, 'no-git'));
  writeFileSync(path.join(project, 'rules', 'RULE.md'), 'LOCAL COPY\n');

  try {
    process.chdir(project);
    process.env.PATH = path.join(project, 'no-git');
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    process.stdin.setRawMode = () => {};

    const code = await main(['add']);

    assert.equal(code, 1);
    assert.equal(
      readFileSync(path.join(project, 'rules', 'RULE.md'), 'utf8'),
      'LOCAL COPY\n',
    );
    assert.equal(existsSync(path.join(project, 'tmp')), false);
  } finally {
    process.chdir(originalCwd);
    process.env.PATH = originalPath;
    globalThis.fetch = originalFetch;
    process.stdin.isTTY = originalStdinTTY;
    process.stdout.isTTY = originalStdoutTTY;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    if (originalSetRawMode === undefined) delete process.stdin.setRawMode;
    else process.stdin.setRawMode = originalSetRawMode;
    rmSync(project, { recursive: true, force: true });
  }
});

test('add refuses to start without a TTY', () => {
  const result = runCli(['add']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /需要交互式终端/);
});

test('add accepts a source argument and still requires a TTY', () => {
  for (const source of ['user/repo', 'https://github.com/user/repo', 'user/repo#dev']) {
    const result = runCli(['add', source]);

    assert.equal(result.status, 1, source);
    assert.match(result.stderr, /需要交互式终端/, source);
  }
});

test('an invalid source is rejected before the TTY check', () => {
  for (const source of ['https://gitlab.com/user/repo', 'user/repo/extra']) {
    const result = runCli(['add', source]);

    assert.equal(result.status, 1, source);
    assert.match(result.stderr, /无法识别的规则来源|只支持 GitHub 仓库/, source);
    assert.doesNotMatch(result.stderr, /需要交互式终端/, source);
  }
});

test('--help and --version never touch the network', () => {
  // Rules are fetched only for `add`; these two must stay instant and offline.
  for (const args of [['--help'], ['--version']]) {
    const result = runCli(args, { env: { NO_NETWORK: '1' } });

    assert.equal(result.status, 0, args.join(' '));
    assert.equal(result.stderr, '', args.join(' '));
  }
});

test('an unknown postInstall step is rejected when a rule is installed', () => {
  // The name is validated by the install module, against the steps it ships.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import { assertKnownSteps } from './src/install.js';
      try {
        assertKnownSteps(['not-a-step'], '规则 X.md');
        console.log('NO THROW');
      } catch (error) {
        console.error(error.message);
        process.exit(3);
      }
      `,
    ],
    { encoding: 'utf8', cwd: ROOT },
  );

  assert.equal(result.status, 3);
  assert.match(result.stderr, /不支持的 postInstall 步骤: "not-a-step"/);
});

test('parseArgs maps argv to exactly one intent', async () => {
  const { parseArgs } = await import('../bin/keeprules.js');

  assert.deepEqual(parseArgs([]), { kind: 'add' });
  assert.deepEqual(parseArgs(['add']), { kind: 'add' });
  assert.deepEqual(parseArgs(['add', 'user/repo']), {
    kind: 'add',
    source: 'user/repo',
  });
  assert.deepEqual(parseArgs(['add', 'https://github.com/user/repo']), {
    kind: 'add',
    source: 'https://github.com/user/repo',
  });
  assert.deepEqual(parseArgs(['add', 'user/repo#dev']), {
    kind: 'add',
    source: 'user/repo#dev',
  });
  assert.deepEqual(parseArgs(['-h']), { kind: 'help' });
  assert.deepEqual(parseArgs(['--help']), { kind: 'help' });
  assert.deepEqual(parseArgs(['help']), { kind: 'help' });
  assert.deepEqual(parseArgs(['-v']), { kind: 'version' });
  assert.deepEqual(parseArgs(['--version']), { kind: 'version' });
  assert.deepEqual(parseArgs(['version']), { kind: 'version' });

  assert.equal(parseArgs(['nope']).kind, 'error');
  assert.match(parseArgs(['nope']).message, /未知命令: nope/);
  assert.equal(parseArgs(['--nope']).kind, 'error');
  assert.match(parseArgs(['--nope']).message, /未知选项: --nope/);
  assert.equal(parseArgs(['add', 'user/repo', 'extra']).kind, 'error');
  assert.match(parseArgs(['add', 'user/repo', 'extra']).message, /多余的参数: extra/);
});

test('help wins over an unknown flag, as before', async () => {
  const { parseArgs } = await import('../bin/keeprules.js');

  assert.deepEqual(parseArgs(['--help', '--nope']), { kind: 'help' });
  assert.deepEqual(parseArgs(['--version', 'nope']), { kind: 'version' });
  assert.deepEqual(parseArgs(['add', 'user/repo', '--help']), { kind: 'help' });
});

test('positional help/version aliases work through the binary', () => {
  assert.equal(runCli(['help']).status, 0);
  assert.match(runCli(['help']).stdout, /用法/);
  assert.equal(runCli(['version']).status, 0);
  assert.equal(runCli(['version']).stdout.trim(), pkg.version);
});

test('extra positional arguments exit non-zero', () => {
  const result = runCli(['add', 'user/repo', 'extra']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /多余的参数/);
});

test('every printer method runs without throwing', async () => {
  // The printer is only reachable through an interactive install, so nothing
  // else in the suite would catch a stale identifier inside it.
  const { printer } = await import('../bin/keeprules.js');

  const write = process.stdout.write;
  process.stdout.write = () => true;

  try {
    printer.intro();
    printer.info('info');
    printer.note(['a → b'], '即将安装');
    printer.spinnerStart('正在安装规则...');
    printer.spinnerStop('完成', false);
    printer.report({
      outcomes: [{ level: 'success', message: 'ok' }],
      failures: [{ subject: 'S', message: 'boom' }],
    });
  } finally {
    process.stdout.write = write;
  }
});
