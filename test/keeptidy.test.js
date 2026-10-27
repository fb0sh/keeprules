import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RULES,
  ensureGitignoreTmp,
  hasTmpIgnoreRule,
  installRule,
} from '../bin/keeptidy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = path.join(ROOT, 'tmp', 'runs');
const BIN = path.join(ROOT, 'bin', 'keeptidy.js');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Create a disposable project directory inside the repository tmp/. */
function workspace() {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TMP_ROOT, 'keeptidy-test-'));
}

function withWorkspace(fn) {
  const dir = workspace();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('installRule copies the rule file and creates .gitignore with /tmp/', () => {
  withWorkspace((dir) => {
    const result = installRule(RULES[0], dir);

    assert.equal(result.copied, true);
    assert.equal(result.skipped, false);
    assert.equal(result.gitignore.status, 'created');
    assert.match(readFileSync(path.join(dir, 'KEEPTIDY.md'), 'utf8'), /KEEPTIDY/);
    assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), '# keeptidy: 临时目录\n/tmp/\n');
  });
});

test('a second run skips the rule and leaves the existing .gitignore alone', () => {
  withWorkspace((dir) => {
    installRule(RULES[0], dir);
    const before = readFileSync(path.join(dir, '.gitignore'), 'utf8');

    const result = installRule(RULES[0], dir);

    assert.equal(result.copied, false);
    assert.equal(result.skipped, true);
    assert.equal(result.gitignore.status, 'exists');
    assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), before);
  });
});

test('existing target files are never overwritten', () => {
  withWorkspace((dir) => {
    writeFileSync(path.join(dir, 'KEEPTIDY.md'), 'MY CUSTOM RULE\n');

    const result = installRule(RULES[0], dir);

    assert.equal(result.skipped, true);
    assert.equal(readFileSync(path.join(dir, 'KEEPTIDY.md'), 'utf8'), 'MY CUSTOM RULE\n');
  });
});

test('existing .gitignore rules are preserved when /tmp/ is appended', () => {
  withWorkspace((dir) => {
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n*.log');

    const result = ensureGitignoreTmp(dir);
    const content = readFileSync(path.join(dir, '.gitignore'), 'utf8');

    assert.equal(result.status, 'updated');
    assert.ok(content.startsWith('node_modules\n*.log\n'));
    assert.ok(content.endsWith('# keeptidy: 临时目录\n/tmp/\n'));
  });
});

test('equivalent tmp ignore patterns are detected', () => {
  for (const entry of ['/tmp/', 'tmp/', 'tmp', '/tmp', '  /tmp/  ']) {
    assert.equal(hasTmpIgnoreRule(`node_modules\n${entry}\n`), true, entry);
  }

  assert.equal(hasTmpIgnoreRule('node_modules\n'), false);
  assert.equal(hasTmpIgnoreRule('# /tmp/\n'), false);
  assert.equal(hasTmpIgnoreRule('!tmp/\n'), false);
});

test('installRule throws when the packaged rule file is missing', () => {
  withWorkspace((dir) => {
    assert.throws(
      () => installRule({ ...RULES[0], file: 'MISSING.md', postInstall: [] }, dir),
      /规则文件缺失/,
    );
  });
});

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: options.cwd ?? ROOT,
    env: {
      ...process.env,
      TMPDIR: path.join(TMP_ROOT, 'spawn'),
      ...options.env,
    },
  });
}

test('--help prints usage and available rules', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /用法/);
  assert.match(result.stdout, /KEEPTIDY\.md/);
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
