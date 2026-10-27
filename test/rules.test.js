import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadRules,
  parseFrontmatter,
  parseSimpleYaml,
} from '../src/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = path.join(ROOT, 'tmp', 'runs');

function withRulesDir(fn) {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_ROOT, 'keeprules-rules-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parseFrontmatter splits YAML metadata from the Markdown body', () => {
  const parsed = parseFrontmatter(
    [
      '---',
      'id: demo',
      'name: DEMO',
      'description: "Demo rule"',
      'postInstall:',
      '  - gitignore',
      '  - agents',
      '---',
      '',
      '# Demo',
      '',
      'Body text.',
    ].join('\n'),
  );

  assert.equal(parsed.hasFrontmatter, true);
  assert.equal(parsed.data.id, 'demo');
  assert.equal(parsed.data.name, 'DEMO');
  assert.equal(parsed.data.description, 'Demo rule');
  assert.deepEqual(parsed.data.postInstall, ['gitignore', 'agents']);
  assert.match(parsed.body.trimStart(), /^# Demo/);
});

test('parseSimpleYaml accepts inline arrays and ignores comments', () => {
  const data = parseSimpleYaml(
    [
      '# metadata',
      'id: sample',
      'postInstall: [gitignore, agents]',
      'enabled: true',
      'empty:',
    ].join('\n'),
  );

  assert.deepEqual(data.postInstall, ['gitignore', 'agents']);
  assert.equal(data.enabled, true);
  assert.equal(data.empty, null);
});

test('loadRules auto-registers Markdown files and falls back without frontmatter', () => {
  withRulesDir((dir) => {
    writeFileSync(
      path.join(dir, 'B_RULE.md'),
      [
        '---',
        'id: beta',
        'name: BETA',
        'description: Beta description',
        'postInstall:',
        '  - agents',
        '---',
        '',
        '# BETA',
      ].join('\n'),
    );
    writeFileSync(path.join(dir, 'A_RULE.md'), '# Alpha title\n\nBody.\n');
    writeFileSync(path.join(dir, 'IGNORED.txt'), 'not a rule');
    writeFileSync(path.join(dir, '.hidden.md'), '# Hidden');

    const rules = loadRules(dir);

    assert.deepEqual(
      rules.map((rule) => rule.file),
      ['A_RULE.md', 'B_RULE.md'],
    );

    assert.deepEqual(rules[0], {
      id: 'A_RULE',
      name: 'A_RULE',
      description: 'Alpha title',
      file: 'A_RULE.md',
      sourcePath: path.join(dir, 'A_RULE.md'),
      postInstall: [],
    });

    assert.deepEqual(rules[1], {
      id: 'beta',
      name: 'BETA',
      description: 'Beta description',
      file: 'B_RULE.md',
      sourcePath: path.join(dir, 'B_RULE.md'),
      postInstall: ['agents'],
    });
  });
});

test('loadRules rejects duplicate rule ids with a clear error', () => {
  withRulesDir((dir) => {
    const frontmatter = '---\nid: duplicate\nname: DUPLICATE\n---\n# Duplicate\n';
    writeFileSync(path.join(dir, 'ONE.md'), frontmatter);
    writeFileSync(path.join(dir, 'TWO.md'), frontmatter);

    assert.throws(() => loadRules(dir), /规则 id 重复: "duplicate"/);
  });
});

test('loadRules rejects unknown postInstall steps at discovery time', () => {
  withRulesDir((dir) => {
    writeFileSync(
      path.join(dir, 'BROKEN.md'),
      [
        '---',
        'id: broken',
        'name: BROKEN',
        'postInstall:',
        '  - gitignroe',
        '---',
        '# BROKEN',
      ].join('\n'),
    );

    assert.throws(
      () => loadRules(dir),
      /不支持的 postInstall 步骤: "gitignroe"/,
    );
  });
});
