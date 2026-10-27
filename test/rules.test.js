import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRules } from '../src/rules.js';

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

test('frontmatter drives the rule record, and the body is ignored', () => {
  withRulesDir((dir) => {
    writeFileSync(
      path.join(dir, 'DEMO.md'),
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

    const [rule] = loadRules(dir);

    assert.equal(rule.id, 'demo');
    assert.equal(rule.name, 'DEMO');
    assert.equal(rule.description, 'Demo rule');
    assert.deepEqual(rule.postInstall, ['gitignore', 'agents']);
  });
});

test('frontmatter accepts inline arrays and ignores comments', () => {
  withRulesDir((dir) => {
    writeFileSync(
      path.join(dir, 'INLINE.md'),
      [
        '---',
        '# metadata',
        'id: inline',
        'postInstall: [gitignore, agents]',
        '---',
        '# Inline',
      ].join('\n'),
    );

    assert.deepEqual(loadRules(dir)[0].postInstall, ['gitignore', 'agents']);
  });
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

test('loadRules reports postInstall as written; the shell validates the names', () => {
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

    // Discovery stays independent of the install module; the unknown name is
    // caught by bin at startup (see cli.test.js).
    assert.deepEqual(loadRules(dir)[0].postInstall, ['gitignroe']);
  });
});

test('loadRules accepts distinctly named rule files', () => {
  withRulesDir((dir) => {
    writeFileSync(
      path.join(dir, 'UPPER.md'),
      '---\nid: upper\nname: UPPER\n---\n# UPPER\n',
    );
    writeFileSync(
      path.join(dir, 'lower.md'),
      '---\nid: lower\nname: LOWER\n---\n# LOWER\n',
    );

    // The collision itself is covered by the pure file-name check below,
    // because a case-insensitive filesystem cannot even hold both files.
    assert.deepEqual(
      loadRules(dir).map((rule) => rule.id),
      ['upper', 'lower'],
    );
  });
});

test('loadRules orders rules the same way on every host', () => {
  withRulesDir((dir) => {
    for (const file of ['beta.md', 'ALPHA.md', 'gamma.md']) {
      writeFileSync(path.join(dir, file), `# ${file}\n`);
    }

    // Code point order, not locale order: uppercase sorts before lowercase.
    assert.deepEqual(
      loadRules(dir).map((rule) => rule.file),
      ['ALPHA.md', 'beta.md', 'gamma.md'],
    );
  });
});

test('loadRules rejects rule files that collide on case-insensitive filesystems', () => {
  withRulesDir((dir) => {
    // A case-insensitive filesystem cannot hold both names, so the collision is
    // asserted by listing the names the scan would see rather than by creating
    // two files that macOS and Windows would silently merge.
    writeFileSync(path.join(dir, 'RULE.md'), '# UPPER\n');

    assert.throws(
      () => loadRules(dir, { fileNames: ['RULE.md', 'rule.md'] }),
      /大小写冲突: "RULE.md" 与 "rule.md"/,
    );
  });
});
