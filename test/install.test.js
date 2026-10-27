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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRules } from '../src/rules.js';
import {
  ensureAgentsReference,
  ensureGitignoreTmp,
  hasTmpIgnoreRule,
  installRule,
  installSelection,
} from '../src/install.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = path.join(ROOT, 'tmp', 'runs');
const RULES = loadRules(path.join(ROOT, 'rules'));

const KEEPTIDY = RULES.find((rule) => rule.id === 'keeptidy');
const KEEPSECURED = RULES.find((rule) => rule.id === 'keepsecured');

const AGENTS_KEEPTIDY_BLOCK = [
  '<!-- keeprules:start -->',
  '## KEEPTIDY',
  '',
  'Follow the KEEPTIDY rules defined in [KEEPTIDY.md](./KEEPTIDY.md).',
  '',
  'These rules are mandatory for all Coding Agents working in this repository.',
  '<!-- keeprules:end -->',
].join('\n') + '\n';

const AGENTS_BOTH_BLOCK = [
  '<!-- keeprules:start -->',
  '## KEEPSECURED',
  '',
  'Follow the KEEPSECURED rules defined in [KEEPSECURED.md](./KEEPSECURED.md).',
  '',
  '## KEEPTIDY',
  '',
  'Follow the KEEPTIDY rules defined in [KEEPTIDY.md](./KEEPTIDY.md).',
  '',
  'These rules are mandatory for all Coding Agents working in this repository.',
  '<!-- keeprules:end -->',
].join('\n') + '\n';

function workspace(prefix = 'keeprules-install-') {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TMP_ROOT, prefix));
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
    const result = installRule(KEEPTIDY, dir);

    assert.equal(result.copied, true);
    assert.equal(result.skipped, false);
    assert.equal(result.postInstall.gitignore.status, 'created');
    assert.match(readFileSync(path.join(dir, 'KEEPTIDY.md'), 'utf8'), /KEEPTIDY/);
    assert.equal(
      readFileSync(path.join(dir, '.gitignore'), 'utf8'),
      '# keeprules: 临时目录\n/tmp/\n',
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
    assert.equal(result.postInstall.gitignore.status, 'exists');
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
    assert.ok(content.endsWith('# keeprules: 临时目录\n/tmp/\n'));
  });
});

test('managed append preserves CRLF line endings', () => {
  withWorkspace((dir) => {
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules\r\n');
    writeFileSync(path.join(dir, 'AGENTS.md'), '# Existing\r\n');

    ensureGitignoreTmp(dir);
    ensureAgentsReference(dir, [KEEPTIDY]);

    assert.equal(
      readFileSync(path.join(dir, '.gitignore'), 'utf8'),
      'node_modules\r\n\r\n# keeprules: 临时目录\r\n/tmp/\r\n',
    );
    assert.ok(
      readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').startsWith(
        '# Existing\r\n\r\n<!-- keeprules:start -->\r\n',
      ),
    );
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

test('installRule throws when the rule source is missing', () => {
  withWorkspace((dir) => {
    assert.throws(
      () =>
        installRule(
          { ...KEEPTIDY, sourcePath: path.join(dir, 'MISSING.md'), postInstall: [] },
          dir,
        ),
      /规则文件缺失/,
    );
  });
});

test('installRule accepts a rule from an explicit source path', () => {
  withWorkspace((dir) => {
    const rulesDir = path.join(dir, 'source-rules');
    const targetDir = path.join(dir, 'project');
    mkdirSync(rulesDir);
    mkdirSync(targetDir);
    writeFileSync(
      path.join(rulesDir, 'LOCAL.md'),
      '---\nid: local\nname: LOCAL\ndescription: Local rule\n---\n# LOCAL\n',
    );

    const [rule] = loadRules(rulesDir);
    const result = installRule(rule, targetDir);

    assert.equal(result.copied, true);
    assert.equal(
      readFileSync(path.join(targetDir, 'LOCAL.md'), 'utf8'),
      '---\nid: local\nname: LOCAL\ndescription: Local rule\n---\n# LOCAL\n',
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

test('installSelection returns one report for files and collective agents', () => {
  withWorkspace((dir) => {
    const report = installSelection({
      rules: [KEEPSECURED, KEEPTIDY],
      cwd: dir,
      collective: { agents: true },
    });

    assert.equal(report.failures.length, 0);
    assert.equal(report.results.length, 2);
    assert.equal(report.results[0].copied, true);
    assert.equal(report.results[1].postInstall.gitignore.status, 'created');
    assert.equal(report.collective.agents.status, 'created');
    assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), AGENTS_BOTH_BLOCK);
  });
});

test('installSelection skips collective agents when disabled', () => {
  withWorkspace((dir) => {
    const report = installSelection({
      rules: [KEEPSECURED],
      cwd: dir,
      collective: { agents: false },
    });

    assert.equal(report.failures.length, 0);
    assert.equal(report.collective.agents, undefined);
    assert.equal(existsSync(path.join(dir, 'AGENTS.md')), false);
  });
});

test('installSelection keeps going after one rule fails', () => {
  withWorkspace((dir) => {
    const missing = {
      ...KEEPSECURED,
      id: 'missing',
      file: 'MISSING.md',
      sourcePath: path.join(dir, 'MISSING.md'),
      postInstall: [],
    };

    const report = installSelection({
      rules: [KEEPTIDY, missing],
      cwd: dir,
      collective: { agents: false },
    });

    assert.equal(report.results.length, 1);
    assert.equal(report.failures.length, 1);
    assert.equal(report.results[0].rule.id, 'keeptidy');
    assert.equal(report.failures[0].rule.id, 'missing');
    assert.equal(existsSync(path.join(dir, 'KEEPTIDY.md')), true);
  });
});
