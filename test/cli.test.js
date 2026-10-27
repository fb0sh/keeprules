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

test('--help prints usage, project info, and auto-loaded rules', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /用法/);
  assert.match(result.stdout, /https:\/\/github\.com\/fb0sh\/keeprules/);
  assert.match(result.stdout, /fb0sh@outlook\.com/);
  assert.match(result.stdout, /KEEPTIDY\.md/);
  assert.match(result.stdout, /KEEPSECURED\.md/);
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

test('--help lists every rule under its install path', () => {
  const result = runCli(['--help']);

  assert.match(result.stdout, /rules\/KEEPTIDY\.md/);
  assert.match(result.stdout, /rules\/KEEPSECURED\.md/);
});

test('an unknown postInstall step is rejected at startup', () => {
  // bin validates every rule's postInstall names against the installed steps
  // during module load, so a typo in a rule file fails before any prompt.
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
