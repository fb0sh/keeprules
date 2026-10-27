import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('add refuses to start without a TTY', () => {
  const result = runCli(['add']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /需要交互式终端/);
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
  assert.equal(parseArgs(['add', 'extra']).kind, 'error');
  assert.match(parseArgs(['add', 'extra']).message, /多余的参数: extra/);
});

test('help wins over an unknown flag, as before', async () => {
  const { parseArgs } = await import('../bin/keeprules.js');

  assert.deepEqual(parseArgs(['--help', '--nope']), { kind: 'help' });
  assert.deepEqual(parseArgs(['--version', 'nope']), { kind: 'version' });
});

test('positional help/version aliases work through the binary', () => {
  assert.equal(runCli(['help']).status, 0);
  assert.match(runCli(['help']).stdout, /用法/);
  assert.equal(runCli(['version']).status, 0);
  assert.equal(runCli(['version']).stdout.trim(), pkg.version);
});

test('extra positional arguments exit non-zero', () => {
  const result = runCli(['add', 'extra']);

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
