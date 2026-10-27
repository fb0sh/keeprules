import test from 'node:test';
import assert from 'node:assert/strict';

import { loadRules } from '../src/rules.js';

/** Build the `{file, content}` entries the loader expects. */
const files = (...pairs) => pairs.map(([file, content]) => ({ file, content }));

const frontmatter = (body, fm) => `---\n${fm}\n---\n${body}`;

test('frontmatter drives the rule record, and the body is ignored', () => {
  const [rule] = loadRules(
    files([
      'DEMO.md',
      frontmatter(
        '\n# Demo\n\nBody text.',
        [
          'id: demo',
          'name: DEMO',
          'description: "Demo rule"',
          'postInstall:',
          '  - gitignore',
          '  - agents',
        ].join('\n'),
      ),
    ]),
  );

  assert.equal(rule.id, 'demo');
  assert.equal(rule.name, 'DEMO');
  assert.equal(rule.description, 'Demo rule');
  assert.deepEqual(rule.postInstall, ['gitignore', 'agents']);
  assert.equal(rule.file, 'DEMO.md');
});

test('frontmatter accepts inline arrays and ignores comments', () => {
  const [rule] = loadRules(
    files([
      'INLINE.md',
      frontmatter('# Inline', ['# metadata', 'id: inline', 'postInstall: [gitignore, agents]'].join('\n')),
    ]),
  );

  assert.deepEqual(rule.postInstall, ['gitignore', 'agents']);
});

test('a file without frontmatter still becomes a rule', () => {
  const [rule] = loadRules(files(['BARE.md', '# Bare title\n\nBody.\n']));

  assert.deepEqual(rule, {
    id: 'BARE',
    name: 'BARE',
    description: 'Bare title',
    file: 'BARE.md',
    content: '# Bare title\n\nBody.\n',
    postInstall: [],
  });
});

test('the body first line is skipped when it is a comment', () => {
  const [rule] = loadRules(files(['X.md', '<!-- note -->\n# Real title\n']));

  assert.equal(rule.description, 'Real title');
});

test('postInstall is kept as written; the install module validates the names', () => {
  const [rule] = loadRules(
    files(['BROKEN.md', frontmatter('# BROKEN', 'postInstall:\n  - gitignroe')]),
  );

  assert.deepEqual(rule.postInstall, ['gitignroe']);
});

test('rules are ordered by code point, the same on every host', () => {
  const rules = loadRules(
    files(['beta.md', '# b'], ['ALPHA.md', '# a'], ['gamma.md', '# g']),
  );

  assert.deepEqual(rules.map((rule) => rule.file), ['ALPHA.md', 'beta.md', 'gamma.md']);
});

test('non-Markdown entries are ignored', () => {
  const rules = loadRules(
    files(['README.md.bak', '# Backup'], ['REAL.md', '# Real']),
  );

  assert.deepEqual(rules.map((rule) => rule.file), ['REAL.md']);
});

test('duplicate ids are rejected with both file names', () => {
  const duplicate = frontmatter('# D', 'id: duplicate');

  assert.throws(
    () => loadRules(files(['ONE.md', duplicate], ['TWO.md', duplicate])),
    /规则 id 重复: "duplicate"（TWO\.md 与 ONE\.md）/,
  );
});

test('file names that differ only by case are rejected', () => {
  assert.throws(
    () => loadRules(files(['RULE.md', '# a'], ['rule.md', '# b'])),
    /大小写冲突: "RULE\.md" 与 "rule\.md"/,
  );
});

test('a byte-order mark does not break frontmatter', () => {
  const [rule] = loadRules(
    files(['BOM.md', `\uFEFF${frontmatter('# B', 'id: bom')}`]),
  );

  assert.equal(rule.id, 'bom');
});

test('single-quoted scalars unescape doubled quotes', () => {
  const [rule] = loadRules(
    files(['Q.md', frontmatter('# Q', "description: 'it''s fine'")]),
  );

  assert.equal(rule.description, "it's fine");
});

test('CRLF frontmatter parses the same as LF', () => {
  const [rule] = loadRules(
    files(['CRLF.md', '---\r\nid: crlf\r\nname: CRLF\r\n---\r\n# Body\r\n']),
  );

  assert.equal(rule.id, 'crlf');
  assert.equal(rule.name, 'CRLF');
});
