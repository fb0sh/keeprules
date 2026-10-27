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

import {
  RULES,
  ensureAgentsReference,
  ensureGitignoreTmp,
  hasTmpIgnoreRule,
  installRule,
} from '../bin/keepit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = path.join(ROOT, 'tmp', 'runs');
const BIN = path.join(ROOT, 'bin', 'keepit.js');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const KEEPTIDY = RULES.find((rule) => rule.id === 'keeptidy');
const KEEPSECURED = RULES.find((rule) => rule.id === 'keepsecured');

const AGENTS_KEEPTIDY_BLOCK = [
  '<!-- keepit:start -->',
  '## KEEPTIDY',
  '',
  'Follow the KEEPTIDY rules defined in [KEEPTIDY.md](./KEEPTIDY.md).',
  '',
  'These rules are mandatory for all Coding Agents working in this repository.',
  '<!-- keepit:end -->',
].join('\n') + '\n';

const AGENTS_BOTH_BLOCK = [
  '<!-- keepit:start -->',
  '## KEEPSECURED',
  '',
  'Follow the KEEPSECURED rules defined in [KEEPSECURED.md](./KEEPSECURED.md).',
  '',
  '## KEEPTIDY',
  '',
  'Follow the KEEPTIDY rules defined in [KEEPTIDY.md](./KEEPTIDY.md).',
  '',
  'These rules are mandatory for all Coding Agents working in this repository.',
  '<!-- keepit:end -->',
].join('\n') + '\n';

/** Create a disposable project directory inside the repository tmp/. */
function workspace() {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TMP_ROOT, 'keepit-test-'));
}

function withWorkspace(fn) {
  const dir = workspace();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('rules are auto-loaded from rules/*.md frontmatter', () => {
  assert.ok(KEEPTIDY);
  assert.equal(KEEPTIDY.file, 'KEEPTIDY.md');
  assert.deepEqual(KEEPTIDY.postInstall, ['gitignore', 'agents']);

  assert.ok(KEEPSECURED);
  assert.equal(KEEPSECURED.file, 'KEEPSECURED.md');
  assert.deepEqual(KEEPSECURED.postInstall, ['agents']);
});

test('installRule copies the rule file and creates .gitignore with /tmp/', () => {
  withWorkspace((dir) => {
    const result = installRule(KEEPTIDY, dir);

    assert.equal(result.copied, true);
    assert.equal(result.skipped, false);
    assert.equal(result.gitignore.status, 'created');
    assert.match(readFileSync(path.join(dir, 'KEEPTIDY.md'), 'utf8'), /KEEPTIDY/);
    assert.equal(
      readFileSync(path.join(dir, '.gitignore'), 'utf8'),
      '# keepit: 临时目录\n/tmp/\n',
    );
    assert.equal(existsSync(path.join(dir, 'AGENTS.md')), false);
  });
});

test('a second run skips the rule and leaves the existing .gitignore alone', () => {
  withWorkspace((dir) => {
    installRule(KEEPTIDY, dir);
    const before = readFileSync(path.join(dir, '.gitignore'), 'utf8');

    const result = installRule(KEEPTIDY, dir);

    assert.equal(result.copied, false);
    assert.equal(result.skipped, true);
    assert.equal(result.gitignore.status, 'exists');
    assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), before);
  });
});

test('existing target files are never overwritten', () => {
  withWorkspace((dir) => {
    writeFileSync(path.join(dir, 'KEEPTIDY.md'), 'MY CUSTOM RULE\n');

    const result = installRule(KEEPTIDY, dir);

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
    assert.ok(content.endsWith('# keepit: 临时目录\n/tmp/\n'));
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
      () => installRule({ ...KEEPTIDY, file: 'MISSING.md', postInstall: [] }, dir),
      /规则文件缺失/,
    );
  });
});

test('ensureAgentsReference creates AGENTS.md with the exact marked block', () => {
  withWorkspace((dir) => {
    const result = ensureAgentsReference(dir, [KEEPTIDY]);

    assert.equal(result.status, 'created');
    assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), AGENTS_KEEPTIDY_BLOCK);
  });
});

test('ensureAgentsReference can reference multiple rules in one block', () => {
  withWorkspace((dir) => {
    const result = ensureAgentsReference(dir, [KEEPSECURED, KEEPTIDY]);

    assert.equal(result.status, 'created');
    assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), AGENTS_BOTH_BLOCK);
  });
});

test('ensureAgentsReference appends to existing content with one blank line', () => {
  withWorkspace((dir) => {
    writeFileSync(path.join(dir, 'AGENTS.md'), '# Existing AGENTS\n\nKeep me.\n');

    const result = ensureAgentsReference(dir, [KEEPTIDY]);

    assert.equal(result.status, 'appended');
    assert.equal(
      readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'),
      `# Existing AGENTS\n\nKeep me.\n\n${AGENTS_KEEPTIDY_BLOCK}`,
    );
  });
});

test('ensureAgentsReference handles files without a trailing newline', () => {
  withWorkspace((dir) => {
    writeFileSync(path.join(dir, 'AGENTS.md'), 'Keep me.');

    ensureAgentsReference(dir, [KEEPTIDY]);

    assert.equal(
      readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'),
      `Keep me.\n\n${AGENTS_KEEPTIDY_BLOCK}`,
    );
  });
});

test('ensureAgentsReference is idempotent and preserves an existing block', () => {
  withWorkspace((dir) => {
    const original = `# Existing AGENTS\n\n${AGENTS_KEEPTIDY_BLOCK}`;
    writeFileSync(path.join(dir, 'AGENTS.md'), original);

    const result = ensureAgentsReference(dir, [KEEPTIDY]);

    assert.equal(result.status, 'exists');
    assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), original);
  });
});

test('ensureAgentsReference requires at least one rule', () => {
  withWorkspace((dir) => {
    assert.throws(() => ensureAgentsReference(dir, []), /没有可写入 AGENTS\.md 的规则/);
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

test('--help prints usage and auto-loaded rules', () => {
  const result = runCli(['--help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /用法/);
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
