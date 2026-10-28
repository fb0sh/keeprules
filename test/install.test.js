import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRules } from '../src/rules.js';
import {
  RULES_DIR,
  agentsNotes,
  installSelection,
  promptSteps,
  ruleTargetPath,
} from '../src/install.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = path.join(ROOT, 'tmp', 'runs');

/**
 * A rule fixture in the shape `loadRules` produces: content in memory, ready to
 * be written. Tests assert through the interface, so they describe rules rather
 * than copying the implementation's rendering.
 */
function ruleFixture(_dir, { file, name, postInstall = [], content }) {
  return {
    id: name.toLowerCase(),
    name,
    description: `${name} rule`,
    file,
    content: content ?? `# ${name}\n`,
    postInstall,
  };
}

function withWorkspace(fn) {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_ROOT, 'keeprules-install-'));

  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Install into a scratch project and return its directory. */
function projectWith(fn) {
  return withWorkspace((dir) => {
    const sourceDir = path.join(dir, 'source');
    const project = path.join(dir, 'project');
    mkdirSync(sourceDir);
    mkdirSync(project);

    return fn({ sourceDir, project });
  });
}

const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8');
const exists = (dir, file) => {
  try {
    read(dir, file);
    return true;
  } catch {
    return false;
  }
};

// ── Rules land in rules/, never the project root ─────────────────────────────

test('rules are installed under rules/ and keep their content', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, { file: 'KEEPTIDY.md', name: 'KEEPTIDY' });

    const report = installSelection({ rules: [rule], cwd: project });

    assert.deepEqual(report.failures, []);
    assert.deepEqual(readdirSync(path.join(project, 'rules')), ['KEEPTIDY.md']);
    assert.equal(read(project, 'rules/KEEPTIDY.md'), '# KEEPTIDY\n');
    assert.equal(exists(project, 'KEEPTIDY.md'), false, 'nothing lands in the root');
  });
});

test('ruleTargetPath is the one place the destination is decided', () => {
  assert.equal(
    ruleTargetPath({ file: 'KEEPTIDY.md' }),
    'rules/KEEPTIDY.md',
    'always posix so the link works in Markdown',
  );
});

// ── Remote always wins ──────────────────────────────────────────────────────

test('a changed local rule is overwritten with the remote content', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      content: '# RULE remote\n',
    });
    mkdirSync(path.join(project, 'rules'));
    writeFileSync(path.join(project, 'rules', 'RULE.md'), 'USER COPY\n');

    const report = installSelection({ rules: [rule], cwd: project });

    assert.deepEqual(report.failures, []);
    assert.deepEqual(
      report.outcomes.map((outcome) => outcome.level),
      ['success'],
    );
    assert.match(report.outcomes[0].message, /已更新（远程覆盖）/);
    assert.equal(read(project, 'rules/RULE.md'), '# RULE remote\n');
  });
});

test('a new rule is created and reported as installed', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, { file: 'RULE.md', name: 'RULE' });

    const report = installSelection({ rules: [rule], cwd: project });

    assert.deepEqual(report.failures, []);
    assert.equal(report.outcomes[0].level, 'success');
    assert.match(report.outcomes[0].message, /已安装/);
    assert.equal(read(project, 'rules/RULE.md'), '# RULE\n');
  });
});

test('identical remote and local content is not written again', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, { file: 'RULE.md', name: 'RULE' });
    const rulesDir = path.join(project, 'rules');
    const target = path.join(rulesDir, 'RULE.md');
    mkdirSync(rulesDir);
    writeFileSync(target, rule.content);

    const old = new Date('2000-01-01T00:00:00Z');
    utimesSync(target, old, old);
    const before = statSync(target).mtimeMs;

    const report = installSelection({ rules: [rule], cwd: project });

    assert.deepEqual(report.failures, []);
    assert.equal(report.outcomes[0].level, 'info');
    assert.match(report.outcomes[0].message, /已是最新/);
    assert.equal(statSync(target).mtimeMs, before, 'the file was not rewritten');
  });
});

test('a rule that is not selected keeps its local content', () => {
  projectWith(({ sourceDir, project }) => {
    const selected = ruleFixture(sourceDir, { file: 'SELECTED.md', name: 'SELECTED' });
    const rulesDir = path.join(project, 'rules');
    mkdirSync(rulesDir);
    writeFileSync(path.join(rulesDir, 'LOCAL.md'), 'LOCAL ONLY\n');

    installSelection({ rules: [selected], cwd: project });

    assert.equal(read(project, 'rules/LOCAL.md'), 'LOCAL ONLY\n');
    assert.equal(read(project, 'rules/SELECTED.md'), '# SELECTED\n');
  });
});

test('a multi-rule install reports new, updated, and current rules separately', () => {
  projectWith(({ sourceDir, project }) => {
    const rulesDir = path.join(project, 'rules');
    mkdirSync(rulesDir);

    const created = ruleFixture(sourceDir, { file: 'NEW.md', name: 'NEW' });
    const updated = ruleFixture(sourceDir, {
      file: 'CHANGED.md',
      name: 'CHANGED',
      content: '# CHANGED remote\n',
    });
    const current = ruleFixture(sourceDir, { file: 'CURRENT.md', name: 'CURRENT' });

    writeFileSync(path.join(rulesDir, 'CHANGED.md'), 'OLD LOCAL\n');
    writeFileSync(path.join(rulesDir, 'CURRENT.md'), current.content);
    writeFileSync(path.join(rulesDir, 'UNTOUCHED.md'), 'UNTOUCHED\n');

    const report = installSelection({
      rules: [created, updated, current],
      cwd: project,
    });

    assert.deepEqual(report.failures, []);
    assert.deepEqual(
      report.outcomes.map((outcome) => outcome.message),
      [
        'NEW → rules/NEW.md 已安装',
        'CHANGED → rules/CHANGED.md 已更新（远程覆盖）',
        'CURRENT → rules/CURRENT.md 已是最新',
      ],
    );
    assert.equal(read(project, 'rules/NEW.md'), '# NEW\n');
    assert.equal(read(project, 'rules/CHANGED.md'), '# CHANGED remote\n');
    assert.equal(read(project, 'rules/CURRENT.md'), current.content);
    assert.equal(read(project, 'rules/UNTOUCHED.md'), 'UNTOUCHED\n');
  });
});

// ── Outcomes describe themselves ────────────────────────────────────────────

test('every outcome carries a level and a sentence the caller can print', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['gitignore'],
    });

    const report = installSelection({ rules: [rule], cwd: project });

    assert.equal(report.outcomes.length, 2, 'one for the file, one for the step');

    // The interface is exactly what a printer reads: a level and a sentence.
    for (const outcome of report.outcomes) {
      assert.deepEqual(Object.keys(outcome).sort(), ['level', 'message']);
      assert.ok(['success', 'info', 'warn'].includes(outcome.level), outcome.level);
      assert.ok(outcome.message.length > 0, 'no outcome prints nothing');
    }

    assert.match(report.outcomes[0].message, /RULE/);
    assert.match(report.outcomes[1].message, /gitignore/);
  });
});

test('a second run reports the rule and the step as already satisfied', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['gitignore'],
    });

    installSelection({ rules: [rule], cwd: project });
    const again = installSelection({ rules: [rule], cwd: project });

    assert.deepEqual(
      again.outcomes.map((outcome) => outcome.level),
      ['info', 'info'],
    );
    assert.match(again.outcomes[0].message, /已是最新/);
    assert.match(again.outcomes[1].message, /无需修改/);
  });
});

// ── Steps ───────────────────────────────────────────────────────────────────

test('the gitignore step adds the tmp rule once', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['gitignore'],
    });

    installSelection({ rules: [rule], cwd: project });

    assert.equal(read(project, '.gitignore'), '# keeprules: 临时目录\n/tmp/\n');
  });
});

test('the gitignore step preserves existing ignore rules', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['gitignore'],
    });
    writeFileSync(path.join(project, '.gitignore'), 'node_modules\n*.log');

    installSelection({ rules: [rule], cwd: project });

    const content = read(project, '.gitignore');
    assert.ok(content.startsWith('node_modules\n*.log\n'));
    assert.ok(content.endsWith('# keeprules: 临时目录\n/tmp/\n'));
  });
});

test('existing line endings are preserved', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['gitignore', 'agents'],
    });
    writeFileSync(path.join(project, '.gitignore'), 'node_modules\r\n');
    writeFileSync(path.join(project, 'AGENTS.md'), '# Existing\r\n');

    installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    assert.equal(
      read(project, '.gitignore'),
      'node_modules\r\n\r\n# keeprules: 临时目录\r\n/tmp/\r\n',
    );
    assert.ok(read(project, 'AGENTS.md').includes('\r\n## RULE\r\n'));
  });
});

test('UTF-8 BOMs and CRLF survive AGENTS.md and .gitignore rewrites', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['gitignore', 'agents'],
    });
    writeFileSync(path.join(project, '.gitignore'), '\uFEFFnode_modules\r\n');
    writeFileSync(path.join(project, 'AGENTS.md'), '\uFEFF# Mine\r\n');

    installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    const ignore = read(project, '.gitignore');
    assert.ok(ignore.startsWith('\uFEFFnode_modules\r\n'), 'BOM and CRLF stay at the start');
    assert.ok(ignore.includes('\r\n# keeprules: 临时目录\r\n/tmp/\r\n'));

    const agents = read(project, 'AGENTS.md');
    assert.ok(agents.startsWith('\uFEFF# Mine\r\n'), 'BOM and CRLF stay at the start');
    assert.ok(agents.includes('\r\n## RULE\r\n'));
  });
});

test('repeated add does not rewrite AGENTS.md or .gitignore', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['gitignore', 'agents'],
    });

    installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    const ignorePath = path.join(project, '.gitignore');
    const agentsPath = path.join(project, 'AGENTS.md');
    const old = new Date('2000-01-01T00:00:00Z');
    utimesSync(ignorePath, old, old);
    utimesSync(agentsPath, old, old);
    const ignoreTime = statSync(ignorePath).mtimeMs;
    const agentsTime = statSync(agentsPath).mtimeMs;

    const again = installSelection({
      rules: [rule],
      cwd: project,
      confirmed: ['agents'],
    });

    assert.deepEqual(again.failures, []);
    assert.ok(again.outcomes.every((outcome) => outcome.level === 'info'));
    assert.equal(statSync(ignorePath).mtimeMs, ignoreTime, '.gitignore was not rewritten');
    assert.equal(statSync(agentsPath).mtimeMs, agentsTime, 'AGENTS.md was not rewritten');
    assert.deepEqual(
      readdirSync(project).filter((name) => name.startsWith('.keeprules-')),
      [],
      'no temporary file is left in the project root',
    );
  });
});

test('the agents step references the installed path, not the project root', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['agents'],
    });

    installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    const agents = read(project, 'AGENTS.md');
    assert.ok(agents.includes('[rules/RULE.md](./rules/RULE.md)'));
    assert.ok(!agents.includes('](./RULE.md)'), 'no root-level link survives');
  });
});

test('the agents step preserves content outside its block', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['agents'],
    });
    writeFileSync(path.join(project, 'AGENTS.md'), '# Mine\n\nKeep me.\n');

    installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    const agents = read(project, 'AGENTS.md');
    assert.ok(agents.startsWith('# Mine\n\nKeep me.\n\n'));
    assert.ok(agents.includes('[rules/RULE.md](./rules/RULE.md)'));
  });
});

test('the agents step merges instead of duplicating across runs', () => {
  projectWith(({ sourceDir, project }) => {
    const first = ruleFixture(sourceDir, { file: 'A.md', name: 'A', postInstall: ['agents'] });
    const second = ruleFixture(sourceDir, { file: 'B.md', name: 'B', postInstall: ['agents'] });

    installSelection({ rules: [first], cwd: project, confirmed: ['agents'] });
    installSelection({ rules: [second], cwd: project, confirmed: ['agents'] });

    const agents = read(project, 'AGENTS.md');
    assert.equal(agents.split('<!-- keeprules:start -->').length - 1, 1, 'one block');
    assert.ok(agents.includes('[rules/A.md](./rules/A.md)'), 'A is still referenced');
    assert.ok(agents.includes('[rules/B.md](./rules/B.md)'));
  });
});

test('a legacy root-level reference is corrected in place', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'LEGACY.md',
      name: 'LEGACY',
      postInstall: ['agents'],
    });
    writeFileSync(
      path.join(project, 'AGENTS.md'),
      [
        '\uFEFF<!-- keeprules:start -->',
        '## LEGACY',
        '',
        'Follow the LEGACY rules defined in [LEGACY.md](./LEGACY.md).',
        '',
        'These rules are mandatory for all Coding Agents working in this repository.',
        '<!-- keeprules:end -->',
        '',
      ].join('\n'),
    );

    installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    const agents = read(project, 'AGENTS.md');
    assert.ok(agents.startsWith('\uFEFF'), 'BOM survives the in-place rewrite');
    assert.ok(agents.includes('[rules/LEGACY.md](./rules/LEGACY.md)'));
    assert.ok(!agents.includes('](./LEGACY.md)'));
  });
});

test('a confirmed step does not run unless the caller opts in', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['agents'],
    });

    const report = installSelection({ rules: [rule], cwd: project });

    assert.equal(exists(project, 'AGENTS.md'), false);
    assert.equal(report.outcomes.length, 1, 'only the file, no step outcome');
    assert.equal(report.outcomes[0].level, 'success');
  });
});

test('a misspelled opt-in step is rejected instead of silently ignored', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['agents'],
    });

    assert.throws(
      () => installSelection({ rules: [rule], cwd: project, confirmed: ['agent'] }),
      /不支持的 postInstall 步骤: "agent"/,
    );
  });
});

// ── Notes a rule injects into its AGENTS.md section ─────────────────────────

/** A rule whose body declares the region the agents step injects. */
function notedRule({ file = 'RULE.md', name = 'RULE', notes = [], postInstall = ['agents'] }) {
  const content = [
    `# ${name}`,
    '',
    '<!-- keeprules:agents -->',
    ...notes,
    '<!-- /keeprules:agents -->',
    '',
  ].join('\n');

  return { id: name.toLowerCase(), description: '', file, name, content, postInstall };
}

const SECTION_LINK = 'Follow the RULE rules defined in [rules/RULE.md](./rules/RULE.md).';

test('a marked region is rendered after the heading and its link', () => {
  projectWith(({ project }) => {
    const rule = notedRule({ notes: ['### Issue capture', '- Refine the description.'] });

    installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    const agents = read(project, 'AGENTS.md');
    const link = agents.indexOf(SECTION_LINK);
    const notesAt = agents.indexOf('### Issue capture');

    assert.ok(link !== -1, 'the generated link is kept');
    assert.ok(notesAt > link, 'the injected lines follow the link');
    assert.ok(agents.includes('- Refine the description.'));
    assert.equal(agents.split('<!-- keeprules:start -->').length - 1, 1, 'one block');
  });
});

test('a rule without a region keeps the one-line section', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['agents'],
    });

    installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    assert.ok(
      read(project, 'AGENTS.md').includes(`${SECTION_LINK}\n\nThese rules are mandatory`),
      'nothing is injected between the link and the footer',
    );
  });
});

test('an empty region is the same as no region', () => {
  projectWith(({ project }) => {
    const rule = notedRule({ notes: ['', ''] });

    const report = installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    assert.deepEqual(report.failures, []);
    assert.ok(read(project, 'AGENTS.md').includes(`${SECTION_LINK}\n\nThese rules`));
  });
});

test('spacing inside the markers does not matter', () => {
  projectWith(({ project }) => {
    const rule = {
      ...notedRule({}),
      content: [
        '# RULE',
        '',
        '<!--keeprules:agents -->',
        '- Tight marker.',
        '<!--  /keeprules:agents-->',
        '',
      ].join('\n'),
    };

    installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    assert.ok(read(project, 'AGENTS.md').includes('- Tight marker.'));
  });
});

test('a malformed region is refused even without the agents step', () => {
  projectWith(({ project }) => {
    const rule = {
      id: 'rule',
      description: '',
      file: 'RULE.md',
      name: 'RULE',
      content: [
        '# RULE',
        '<!-- keeprules:agents -->',
        '## Too deep',
        '<!-- /keeprules:agents -->',
        '',
      ].join('\n'),
      postInstall: [],
    };

    const report = installSelection({ rules: [rule], cwd: project });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /不能包含一级或二级标题/);
    assert.equal(exists(project, 'rules/RULE.md'), false, 'nothing was written');
  });
});

test('notes are written whenever the block lists the rule', () => {
  projectWith(({ sourceDir, project }) => {
    // A rule that never declares the step still lands in the block when another
    // selected rule asks for it, so its notes are rendered too.
    const noted = { ...notedRule({ notes: ['- Noted line.'] }), postInstall: [] };
    const trigger = ruleFixture(sourceDir, {
      file: 'TRIGGER.md',
      name: 'TRIGGER',
      postInstall: ['agents'],
    });

    installSelection({ rules: [noted, trigger], cwd: project, confirmed: ['agents'] });

    const agents = read(project, 'AGENTS.md');
    assert.ok(agents.includes('- Noted line.'));
    assert.ok(agents.includes('[rules/RULE.md](./rules/RULE.md)'));
  });
});

test('the injected lines keep the file line-ending convention', () => {
  projectWith(({ project }) => {
    writeFileSync(path.join(project, 'AGENTS.md'), '# Mine\r\n');

    installSelection({
      rules: [notedRule({ notes: ['### Issue capture', '- CRLF line.'] })],
      cwd: project,
      confirmed: ['agents'],
    });

    const agents = read(project, 'AGENTS.md');
    assert.ok(agents.includes('### Issue capture\r\n- CRLF line.\r\n'));
    assert.equal(agents.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF');
  });
});

test('a rule with notes is not rewritten on the next run', () => {
  projectWith(({ project }) => {
    const rule = notedRule({ notes: ['### Issue capture', '- Stable line.'] });
    const agentsPath = path.join(project, 'AGENTS.md');

    installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    const old = new Date('2000-01-01T00:00:00Z');
    utimesSync(agentsPath, old, old);
    const agentsTime = statSync(agentsPath).mtimeMs;

    const again = installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    assert.deepEqual(again.failures, []);
    assert.ok(again.outcomes.every((outcome) => outcome.level === 'info'));
    assert.equal(statSync(agentsPath).mtimeMs, agentsTime, 'AGENTS.md was not rewritten');
    assert.equal(
      read(project, 'AGENTS.md').split('- Stable line.').length - 1,
      1,
      'the lines are not duplicated',
    );
  });
});

test('updated notes replace the previous ones', () => {
  projectWith(({ project }) => {
    installSelection({
      rules: [notedRule({ notes: ['- First wording.'] })],
      cwd: project,
      confirmed: ['agents'],
    });
    installSelection({
      rules: [notedRule({ notes: ['- Second wording.'] })],
      cwd: project,
      confirmed: ['agents'],
    });

    const agents = read(project, 'AGENTS.md');
    assert.ok(agents.includes('- Second wording.'));
    assert.equal(agents.includes('- First wording.'), false, 'no stale line survives');
    assert.equal(agents.split('<!-- keeprules:start -->').length - 1, 1, 'one block');
  });
});

test('removing the region removes the injected lines', () => {
  projectWith(({ sourceDir, project }) => {
    installSelection({
      rules: [notedRule({ notes: ['- Temporary line.'] })],
      cwd: project,
      confirmed: ['agents'],
    });

    const plain = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['agents'],
    });
    installSelection({ rules: [plain], cwd: project, confirmed: ['agents'] });

    const agents = read(project, 'AGENTS.md');
    assert.equal(agents.includes('- Temporary line.'), false, 'no residue');
    assert.ok(agents.includes(SECTION_LINK), 'the reference stays');
  });
});

test('notes and other rules keep their own sections', () => {
  projectWith(({ sourceDir, project }) => {
    const noted = notedRule({ notes: ['- Noted line.'] });
    const other = ruleFixture(sourceDir, {
      file: 'OTHER.md',
      name: 'OTHER',
      postInstall: ['agents'],
    });

    installSelection({ rules: [noted, other], cwd: project, confirmed: ['agents'] });

    const agents = read(project, 'AGENTS.md');
    assert.ok(agents.includes('[rules/OTHER.md](./rules/OTHER.md)'));
    assert.ok(agents.includes('- Noted line.'));
    assert.equal(agents.split('\n## ').length - 1, 2, 'two sections');
  });
});

for (const [label, notes, pattern] of [
  ['a level-2 heading', ['## Too deep', '- line'], /不能包含一级或二级标题/],
  ['a level-1 heading', ['# Too deep'], /不能包含一级或二级标题/],
  ['an unterminated region', null, /缺少结束标记/],
  ['a block marker', ['- <!-- keeprules:start -->'], /keeprules 的块标记/],
  ['too many lines', Array.from({ length: 41 }, (_, i) => `- line ${i}`), /最多 40 行/],
  ['too many characters', ['- ' + 'x'.repeat(2001)], /最多 2000 字符/],
]) {
  test(`${label} in the region is refused before any write`, () => {
    projectWith(({ project }) => {
      const rule = notes
        ? notedRule({ notes })
        : {
            ...notedRule({}),
            content: '# RULE\n\n<!-- keeprules:agents -->\n- dangling\n',
          };

      const report = installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

      assert.equal(report.failures.length, 1);
      assert.match(report.failures[0].message, pattern);
      assert.equal(exists(project, 'rules/RULE.md'), false, 'no rule file was written');
      assert.equal(exists(project, 'AGENTS.md'), false, 'AGENTS.md was not touched');
    });
  });
}

test('a rule may declare only one region', () => {
  projectWith(({ project }) => {
    const rule = {
      ...notedRule({ notes: ['- first'] }),
      content: [
        '# RULE',
        '<!-- keeprules:agents -->',
        '- first',
        '<!-- /keeprules:agents -->',
        '<!-- keeprules:agents -->',
        '- second',
        '<!-- /keeprules:agents -->',
        '',
      ].join('\n'),
    };

    const report = installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /只能有一个标记区/);
  });
});

// ── Preflight validation and path safety ────────────────────────────────────

const canRestrictDirectory =
  process.platform !== 'win32' &&
  (typeof process.getuid !== 'function' || process.getuid() !== 0);

test('incomplete content blocks every selected rule from being written', () => {
  projectWith(({ sourceDir, project }) => {
    const good = ruleFixture(sourceDir, { file: 'GOOD.md', name: 'GOOD' });
    const missing = {
      ...good,
      id: 'missing',
      name: 'MISSING',
      file: 'MISSING.md',
      content: undefined,
    };

    mkdirSync(path.join(project, 'rules'));
    writeFileSync(path.join(project, 'rules', 'GOOD.md'), 'LOCAL GOOD\n');
    writeFileSync(path.join(project, 'rules', 'MISSING.md'), 'LOCAL MISSING\n');

    const report = installSelection({ rules: [missing, good], cwd: project });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /规则内容缺失/);
    assert.equal(report.failures[0].subject, 'MISSING');
    assert.equal(report.outcomes.length, 0);
    assert.equal(read(project, 'rules/GOOD.md'), 'LOCAL GOOD\n');
    assert.equal(read(project, 'rules/MISSING.md'), 'LOCAL MISSING\n');
  });
});

test('empty content blocks every selected rule from being written', () => {
  projectWith(({ sourceDir, project }) => {
    const good = ruleFixture(sourceDir, { file: 'GOOD.md', name: 'GOOD' });
    const empty = ruleFixture(sourceDir, {
      file: 'EMPTY.md',
      name: 'EMPTY',
      content: '   \n',
    });

    const report = installSelection({ rules: [good, empty], cwd: project });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /规则内容为空/);
    assert.equal(exists(project, 'rules/GOOD.md'), false);
  });
});

test('an unknown postInstall step blocks every write before anything lands', () => {
  projectWith(({ sourceDir, project }) => {
    const good = ruleFixture(sourceDir, { file: 'GOOD.md', name: 'GOOD' });
    const bad = ruleFixture(sourceDir, {
      file: 'BAD.md',
      name: 'BAD',
      postInstall: ['not-a-step'],
    });

    const report = installSelection({ rules: [good, bad], cwd: project });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /不支持的 postInstall 步骤/);
    assert.equal(exists(project, 'rules/GOOD.md'), false);
  });
});

test('a file name that is not portable to Windows is refused', () => {
  projectWith(({ sourceDir, project }) => {
    const good = ruleFixture(sourceDir, { file: 'GOOD.md', name: 'GOOD' });
    const reserved = ruleFixture(sourceDir, { file: 'CON.md', name: 'CON' });
    const colon = ruleFixture(sourceDir, { file: 'bad:name.md', name: 'COLON' });

    for (const rule of [reserved, colon]) {
      const report = installSelection({ rules: [good, rule], cwd: project });

      assert.equal(report.failures.length, 1, rule.file);
      assert.match(report.failures[0].message, /规则文件名不合法/, rule.file);
      assert.equal(exists(project, 'rules/GOOD.md'), false, rule.file);
    }
  });
});

test('a file name that would escape rules/ is refused before writing', () => {
  projectWith(({ sourceDir, project }) => {
    const good = ruleFixture(sourceDir, { file: 'GOOD.md', name: 'GOOD' });
    const escape = ruleFixture(sourceDir, {
      file: '../escape.md',
      name: 'ESCAPE',
    });

    const report = installSelection({ rules: [good, escape], cwd: project });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /规则文件名不合法/);
    assert.equal(exists(project, 'rules/GOOD.md'), false);
    assert.equal(exists(project, '../escape.md'), false);
  });
});

test('a malformed rule record is reported instead of throwing', () => {
  projectWith(({ project }) => {
    const report = installSelection({
      rules: [{ name: 'BROKEN', file: undefined, content: '# BROKEN\n', postInstall: [] }],
      cwd: project,
    });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /规则文件名不合法/);
    assert.equal(exists(project, 'rules'), false);
  });
});

test('a rules path that is a file is refused and left untouched', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, { file: 'RULE.md', name: 'RULE' });
    writeFileSync(path.join(project, 'rules'), 'NOT A DIRECTORY\n');

    const report = installSelection({ rules: [rule], cwd: project });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /不是目录/);
    assert.equal(read(project, 'rules'), 'NOT A DIRECTORY\n');
  });
});

test('an existing directory at the target path is refused', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, { file: 'RULE.md', name: 'RULE' });
    mkdirSync(path.join(project, 'rules', 'RULE.md'), { recursive: true });

    const report = installSelection({ rules: [rule], cwd: project });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /不是普通文件/);
  });
});

test('a symlinked rules directory is refused and the outside path is untouched', (t) => {
  projectWith(({ sourceDir, project }) => {
    const outside = path.join(project, '..', 'outside-rules');
    mkdirSync(outside);

    try {
      symlinkSync(outside, path.join(project, 'rules'), 'dir');
    } catch {
      t.skip('symlinks are not available on this platform');
      return;
    }

    const rule = ruleFixture(sourceDir, { file: 'RULE.md', name: 'RULE' });
    const report = installSelection({ rules: [rule], cwd: project });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /符号链接/);
    assert.equal(exists(outside, 'RULE.md'), false);
  });
});

test('a symlinked target file is refused and the outside file is untouched', (t) => {
  projectWith(({ sourceDir, project }) => {
    const rulesDir = path.join(project, 'rules');
    const outside = path.join(project, '..', 'victim.md');
    mkdirSync(rulesDir);
    writeFileSync(outside, 'ORIGINAL\n');

    try {
      symlinkSync(outside, path.join(rulesDir, 'RULE.md'), 'file');
    } catch {
      t.skip('symlinks are not available on this platform');
      return;
    }

    const rule = ruleFixture(sourceDir, { file: 'RULE.md', name: 'RULE' });
    const report = installSelection({ rules: [rule], cwd: project });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /符号链接/);
    assert.equal(readFileSync(outside, 'utf8'), 'ORIGINAL\n');
    assert.deepEqual(
      readdirSync(rulesDir).filter((name) => name.startsWith('.keeprules-')),
      [],
      'no temporary file is left behind',
    );
  });
});

test(
  'an overwritten rule keeps the existing file mode',
  { skip: process.platform === 'win32' ? 'POSIX file modes are not used here' : false },
  () => {
    projectWith(({ sourceDir, project }) => {
      const target = path.join(project, 'rules', 'RULE.md');
      const rule = ruleFixture(sourceDir, {
        file: 'RULE.md',
        name: 'RULE',
        content: '# REMOTE\n',
      });
      mkdirSync(path.join(project, 'rules'));
      writeFileSync(target, 'OLD LOCAL\n');
      chmodSync(target, 0o600);

      const report = installSelection({ rules: [rule], cwd: project });

      assert.deepEqual(report.failures, []);
      assert.equal(statSync(target).mode & 0o777, 0o600);
      assert.equal(readFileSync(target, 'utf8'), '# REMOTE\n');
    });
  },
);

test('symlinked AGENTS.md and .gitignore are refused without outside writes', (t) => {
  projectWith(({ sourceDir, project }) => {
    const outsideAgents = path.join(project, '..', 'outside-agents.md');
    const outsideIgnore = path.join(project, '..', 'outside-gitignore');
    writeFileSync(outsideAgents, '# OUTSIDE AGENTS\n');
    writeFileSync(outsideIgnore, 'outside-ignore\n');

    try {
      symlinkSync(outsideAgents, path.join(project, 'AGENTS.md'), 'file');
      symlinkSync(outsideIgnore, path.join(project, '.gitignore'), 'file');
    } catch {
      t.skip('symlinks are not available on this platform');
      return;
    }

    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['gitignore', 'agents'],
    });
    const report = installSelection({
      rules: [rule],
      cwd: project,
      confirmed: ['agents'],
    });

    assert.equal(report.failures.length, 2);
    assert.deepEqual(
      report.failures.map((failure) => failure.subject).sort(),
      ['agents', 'gitignore'],
    );
    assert.match(
      report.failures.map((failure) => failure.message).join('\n'),
      /符号链接/,
    );
    assert.equal(readFileSync(outsideAgents, 'utf8'), '# OUTSIDE AGENTS\n');
    assert.equal(readFileSync(outsideIgnore, 'utf8'), 'outside-ignore\n');
    assert.deepEqual(
      readdirSync(project).filter((name) => name.startsWith('.keeprules-')),
      [],
      'no temporary file is left in the project root',
    );
  });
});

test(
  'a write failure keeps the old file, reports the reason, and cleans up',
  { skip: canRestrictDirectory ? false : 'directory permissions are not testable here' },
  () => {
    projectWith(({ sourceDir, project }) => {
      const rulesDir = path.join(project, 'rules');
      const target = path.join(rulesDir, 'RULE.md');
      const rule = ruleFixture(sourceDir, {
        file: 'RULE.md',
        name: 'RULE',
        content: '# REMOTE\n',
      });
      mkdirSync(rulesDir);
      writeFileSync(target, 'OLD LOCAL\n');

      chmodSync(rulesDir, 0o555);

      try {
        const report = installSelection({ rules: [rule], cwd: project });

        assert.equal(report.failures.length, 1);
        assert.match(report.failures[0].message, /无法写入/);
        assert.equal(readFileSync(target, 'utf8'), 'OLD LOCAL\n');
        assert.deepEqual(
          readdirSync(rulesDir).filter((name) => name.startsWith('.keeprules-')),
          [],
          'the temporary file is removed',
        );
      } finally {
        chmodSync(rulesDir, 0o755);
      }
    });
  },
);

test(
  'failed AGENTS.md and .gitignore writes keep their original content',
  { skip: canRestrictDirectory ? false : 'directory permissions are not testable here' },
  () => {
    projectWith(({ sourceDir, project }) => {
      const rulesDir = path.join(project, 'rules');
      const rule = ruleFixture(sourceDir, {
        file: 'RULE.md',
        name: 'RULE',
        postInstall: ['gitignore', 'agents'],
      });
      mkdirSync(rulesDir);
      writeFileSync(path.join(rulesDir, 'RULE.md'), rule.content);
      writeFileSync(path.join(project, '.gitignore'), 'node_modules\n');
      writeFileSync(path.join(project, 'AGENTS.md'), '# Mine\n');

      chmodSync(project, 0o555);

      try {
        const report = installSelection({
          rules: [rule],
          cwd: project,
          confirmed: ['agents'],
        });

        assert.equal(report.failures.length, 2);
        assert.deepEqual(
          report.failures.map((failure) => failure.subject).sort(),
          ['agents', 'gitignore'],
        );
        assert.equal(read(project, '.gitignore'), 'node_modules\n');
        assert.equal(read(project, 'AGENTS.md'), '# Mine\n');
        assert.deepEqual(
          readdirSync(project).filter((name) => name.startsWith('.keeprules-')),
          [],
          'temporary files are cleaned up',
        );
      } finally {
        chmodSync(project, 0o755);
      }
    });
  },
);

test('a failed rule is never referenced from AGENTS.md', () => {
  projectWith(({ sourceDir, project }) => {
    const good = ruleFixture(sourceDir, { file: 'GOOD.md', name: 'GOOD', postInstall: ['agents'] });
    const bad = {
      ...good,
      id: 'bad',
      name: 'BAD',
      file: 'BAD.md',
      content: undefined,
    };

    installSelection({ rules: [good, bad], cwd: project, confirmed: ['agents'] });

    assert.equal(exists(project, 'AGENTS.md'), false);
    assert.equal(exists(project, 'rules/GOOD.md'), false);
  });
});

test('rules whose targets differ only by case are reported as a conflict', () => {
  projectWith(({ sourceDir, project }) => {
    const upper = ruleFixture(sourceDir, { file: 'RULE.md', name: 'UPPER' });
    const lower = ruleFixture(sourceDir, { file: 'rule.md', name: 'LOWER' });

    const report = installSelection({ rules: [upper, lower], cwd: project });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /目标文件冲突/);
    assert.equal(report.outcomes.length, 0);
    assert.equal(exists(project, 'rules/RULE.md'), false);
  });
});

// ── Discovery still feeds the install ───────────────────────────────────────

/** The repository's own rules, handed over the way the remote loader would. */
function shippedRules() {
  const rulesDir = path.join(ROOT, 'rules');

  return loadRules(
    readdirSync(rulesDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({
        file,
        content: readFileSync(path.join(rulesDir, file), 'utf8'),
      })),
  );
}

test('the repository rules install correctly end to end', () => {
  withWorkspace((project) => {
    const rules = shippedRules();

    const report = installSelection({
      rules,
      cwd: project,
      confirmed: ['agents'],
    });

    assert.deepEqual(report.failures, []);
    // Derived from the repository, so adding a rule does not break this test.
    assert.deepEqual(
      readdirSync(path.join(project, 'rules')).sort(),
      rules.map((rule) => rule.file).sort(),
    );
    assert.equal(read(project, '.gitignore'), '# keeprules: 临时目录\n/tmp/\n');

    const agents = read(project, 'AGENTS.md');
    assert.equal(agents.split('<!-- keeprules:start -->').length - 1, 1, 'one block');

    for (const rule of rules) {
      assert.ok(agents.includes(ruleTargetPath(rule)), rule.file);
      assert.equal(
        agents.split(`## ${rule.name}\n`).length - 1,
        1,
        `${rule.name} appears once`,
      );

      // Every shipped rule carries the summary an install puts in AGENTS.md.
      const summary = agentsNotes(rule.content, rule.name);

      assert.ok(summary.length > 0, `${rule.file} declares an AGENTS.md summary`);
      for (const line of summary) {
        assert.ok(agents.includes(line), `${rule.name} shows: ${line}`);
      }
    }

    // A second run must leave the block exactly as it is: the summaries are not
    // appended twice and the file is not rewritten.
    const agentsPath = path.join(project, 'AGENTS.md');
    const old = new Date('2000-01-01T00:00:00Z');
    utimesSync(agentsPath, old, old);
    const agentsTime = statSync(agentsPath).mtimeMs;

    const again = installSelection({ rules, cwd: project, confirmed: ['agents'] });

    assert.deepEqual(again.failures, []);
    assert.ok(again.outcomes.every((outcome) => outcome.level === 'info'));
    assert.equal(statSync(agentsPath).mtimeMs, agentsTime, 'AGENTS.md was not rewritten');
    assert.equal(read(project, 'AGENTS.md'), agents, 'the block is idempotent');
  });
});

test('updating one rule summary leaves the other sections alone', () => {
  withWorkspace((project) => {
    const rules = shippedRules();

    installSelection({ rules, cwd: project, confirmed: ['agents'] });

    // Pretend KEEPTRACK's summary changed upstream.
    const edited = rules.map((rule) =>
      rule.name === 'KEEPTRACK'
        ? {
            ...rule,
            content: rule.content.replace(
              "- Refine and clarify the user's description.",
              '- Restate the problem in plain terms.',
            ),
          }
        : rule,
    );

    installSelection({ rules: edited, cwd: project, confirmed: ['agents'] });

    const agents = read(project, 'AGENTS.md');
    assert.ok(agents.includes('- Restate the problem in plain terms.'));
    assert.equal(agents.includes("- Refine and clarify the user's description."), false);
    assert.equal(agents.split('## KEEPTRACK\n').length - 1, 1, 'no duplicate section');

    for (const rule of rules.filter((entry) => entry.name !== 'KEEPTRACK')) {
      for (const line of agentsNotes(rule.content, rule.name)) {
        assert.ok(agents.includes(line), `${rule.name} kept: ${line}`);
      }
    }
  });
});

// ── Unchanged rules still run steps ─────────────────────────────────────────

test('an unchanged rule still runs its project-level steps', () => {
  // The file is already current, but the project invariants its rule declares
  // (.gitignore, AGENTS.md) are not the rule's contents, so they still run.
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['gitignore', 'agents'],
    });
    mkdirSync(path.join(project, 'rules'));
    writeFileSync(path.join(project, 'rules', 'RULE.md'), rule.content);

    const report = installSelection({
      rules: [rule],
      cwd: project,
      confirmed: ['agents'],
    });

    assert.deepEqual(
      report.outcomes.map((outcome) => [outcome.level, outcome.message.split(' ')[0]]),
      [
        ['info', 'RULE'],
        ['success', '已创建'],
        ['success', '已创建'],
      ],
      'file already current, both steps still ran',
    );
    assert.match(report.outcomes[0].message, /已是最新/);
    assert.equal(read(project, 'rules/RULE.md'), rule.content);
    assert.equal(read(project, '.gitignore'), '# keeprules: 临时目录\n/tmp/\n');
    assert.ok(read(project, 'AGENTS.md').includes('[rules/RULE.md](./rules/RULE.md)'));
  });
});

test('an updated rule still runs its project-level steps', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      content: '# REMOTE\n',
      postInstall: ['gitignore'],
    });
    mkdirSync(path.join(project, 'rules'));
    writeFileSync(path.join(project, 'rules', 'RULE.md'), 'USER COPY\n');

    const report = installSelection({ rules: [rule], cwd: project });

    assert.equal(report.failures.length, 0);
    assert.match(report.outcomes[0].message, /已更新（远程覆盖）/);
    assert.equal(read(project, 'rules/RULE.md'), '# REMOTE\n');
    assert.equal(read(project, '.gitignore'), '# keeprules: 临时目录\n/tmp/\n');
  });
});

// ── Steps ───────────────────────────────────────────────────────────────────

test('the gitignore step accepts every equivalent spelling as already done', () => {
  for (const entry of ['/tmp/', 'tmp/', 'tmp', '/tmp', '  /tmp/  ', '\uFEFF/tmp/']) {
    projectWith(({ sourceDir, project }) => {
      const rule = ruleFixture(sourceDir, {
        file: 'RULE.md',
        name: 'RULE',
        postInstall: ['gitignore'],
      });
      writeFileSync(path.join(project, '.gitignore'), `node_modules\n${entry}\n`);
      const before = read(project, '.gitignore');

      installSelection({ rules: [rule], cwd: project });

      assert.equal(read(project, '.gitignore'), before, `left ${JSON.stringify(entry)} alone`);
    });
  }

  for (const entry of ['# /tmp/', '!tmp/', 'not-tmp']) {
    projectWith(({ sourceDir, project }) => {
      const rule = ruleFixture(sourceDir, {
        file: 'RULE.md',
        name: 'RULE',
        postInstall: ['gitignore'],
      });
      writeFileSync(path.join(project, '.gitignore'), `${entry}\n`);

      installSelection({ rules: [rule], cwd: project });

      assert.match(read(project, '.gitignore'), /# keeprules: 临时目录/, `added for ${entry}`);
    });
  }
});

test('the gitignore step keeps a file without a trailing newline readable', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['gitignore'],
    });
    writeFileSync(path.join(project, '.gitignore'), 'node_modules');

    installSelection({ rules: [rule], cwd: project });

    assert.equal(
      read(project, '.gitignore'),
      'node_modules\n\n# keeprules: 临时目录\n/tmp/\n',
    );
  });
});

test('the agents step leaves a half-written block alone', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['agents'],
    });
    const broken = '<!-- keeprules:start -->\n## HALF\n';
    writeFileSync(path.join(project, 'AGENTS.md'), broken);

    installSelection({ rules: [rule], cwd: project, confirmed: ['agents'] });

    assert.equal(read(project, 'AGENTS.md'), broken, 'no second block appended');
  });
});

test(
  'the agents step reports when a write failure leaves nothing to reference',
  { skip: canRestrictDirectory ? false : 'directory permissions are not testable here' },
  () => {
    projectWith(({ sourceDir, project }) => {
      const rulesDir = path.join(project, 'rules');
      const rule = ruleFixture(sourceDir, {
        file: 'RULE.md',
        name: 'RULE',
        postInstall: ['agents'],
      });
      mkdirSync(rulesDir);
      chmodSync(rulesDir, 0o555);

      try {
        const report = installSelection({
          rules: [rule],
          cwd: project,
          confirmed: ['agents'],
        });

        assert.equal(report.failures.length, 1);
        assert.equal(exists(project, 'AGENTS.md'), false);
        assert.ok(
          report.outcomes.some((outcome) => /跳过 AGENTS\.md/.test(outcome.message)),
        );
      } finally {
        chmodSync(rulesDir, 0o755);
      }
    });
  },
);

test('automatic steps run without being confirmed', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['gitignore', 'agents'],
    });

    installSelection({ rules: [rule], cwd: project });

    assert.equal(exists(project, '.gitignore'), true, 'gitignore is automatic');
    assert.equal(exists(project, 'AGENTS.md'), false, 'agents needs confirmation');
  });
});

test('promptSteps only offers opt-in steps the selection declares', () => {
  assert.deepEqual(
    promptSteps([{ postInstall: ['gitignore'] }]),
    [],
    'automatic steps are not asked about',
  );
  assert.deepEqual(
    promptSteps([{ postInstall: ['agents'] }]).map((step) => step.name),
    ['agents'],
  );
  assert.equal(promptSteps([{ postInstall: ['agents'] }])[0].prompt.length > 0, true);
  assert.equal(promptSteps([{ postInstall: ['agents'] }])[0].declined.length > 0, true);
});

test('RULES_DIR is the single spelling of the destination', () => {
  assert.equal(RULES_DIR, 'rules');
  assert.equal(ruleTargetPath({ file: 'X.md' }), `${RULES_DIR}/X.md`);
});
