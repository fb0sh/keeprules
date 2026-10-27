import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRules } from '../src/rules.js';
import {
  RULES_DIR,
  installSelection,
  promptSteps,
  ruleTargetPath,
} from '../src/install.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = path.join(ROOT, 'tmp', 'runs');

/**
 * A rule fixture, built through the same record shape `loadRules` produces.
 * Tests assert through the interface, so they describe rules rather than
 * copying the implementation's rendering.
 */
function ruleFixture(dir, { file, name, postInstall = [] }) {
  const sourcePath = path.join(dir, file);
  writeFileSync(sourcePath, `# ${name}\n`);

  return {
    id: name.toLowerCase(),
    name,
    description: `${name} rule`,
    file,
    sourcePath,
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

// ── Never overwrite ─────────────────────────────────────────────────────────

test('an existing rule file is reported skipped and left untouched', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, { file: 'RULE.md', name: 'RULE' });
    mkdirSync(path.join(project, 'rules'));
    writeFileSync(path.join(project, 'rules', 'RULE.md'), 'USER COPY\n');

    const report = installSelection({ rules: [rule], cwd: project });

    assert.deepEqual(
      report.outcomes.map((outcome) => outcome.level),
      ['warn'],
    );
    assert.match(report.outcomes[0].message, /已存在，已跳过/);
    assert.equal(read(project, 'rules/RULE.md'), 'USER COPY\n');
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

test('a second run reports the step as already satisfied', () => {
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
      ['warn', 'info'],
    );
    assert.match(again.outcomes[0].message, /已跳过/);
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
        '<!-- keeprules:start -->',
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

// ── Failure isolation ───────────────────────────────────────────────────────

test('a missing source is reported and the other rules still install', () => {
  projectWith(({ sourceDir, project }) => {
    const good = ruleFixture(sourceDir, { file: 'GOOD.md', name: 'GOOD' });
    const missing = {
      ...good,
      id: 'missing',
      name: 'MISSING',
      file: 'MISSING.md',
      sourcePath: path.join(sourceDir, 'MISSING.md'),
    };

    const report = installSelection({ rules: [missing, good], cwd: project });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /规则文件缺失/);
    assert.equal(report.failures[0].subject, 'MISSING');
    assert.equal(exists(project, 'rules/GOOD.md'), true);
  });
});

test('failures carry a subject and a message, never a rule object', () => {
  projectWith(({ project }) => {
    const report = installSelection({
      rules: [
        {
          id: 'broken',
          name: 'BROKEN',
          file: 'BROKEN.md',
          sourcePath: '/nonexistent/BROKEN.md',
          postInstall: [],
        },
      ],
      cwd: project,
    });

    assert.deepEqual(Object.keys(report.failures[0]).sort(), ['message', 'subject']);
  });
});

test('a failed rule is never referenced from AGENTS.md', () => {
  projectWith(({ sourceDir, project }) => {
    const good = ruleFixture(sourceDir, { file: 'GOOD.md', name: 'GOOD', postInstall: ['agents'] });
    const bad = {
      ...good,
      id: 'bad',
      name: 'BAD',
      file: 'BAD.md',
      sourcePath: path.join(sourceDir, 'BAD.md'),
    };

    installSelection({ rules: [good, bad], cwd: project, confirmed: ['agents'] });

    const agents = read(project, 'AGENTS.md');
    assert.ok(agents.includes('[rules/GOOD.md](./rules/GOOD.md)'));
    assert.ok(!agents.includes('BAD.md'));
  });
});

test('rules whose targets differ only by case are reported as a conflict', () => {
  projectWith(({ sourceDir, project }) => {
    const upper = ruleFixture(sourceDir, { file: 'RULE.md', name: 'UPPER' });
    const lower = ruleFixture(sourceDir, { file: 'rule.md', name: 'LOWER' });

    const report = installSelection({ rules: [upper, lower], cwd: project });

    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].message, /目标文件冲突/);
    assert.equal(report.outcomes.length, 1);
    // readdirSync keeps the on-disk casing; existsSync would report the second
    // name as present on a case-insensitive filesystem.
    assert.deepEqual(readdirSync(path.join(project, 'rules')), ['RULE.md']);
  });
});

// ── Discovery still feeds the install ───────────────────────────────────────

test('rules loaded from disk install correctly end to end', () => {
  withWorkspace((project) => {
    const rules = loadRules(path.join(ROOT, 'rules'));

    const report = installSelection({
      rules,
      cwd: project,
      confirmed: ['agents'],
    });

    assert.deepEqual(report.failures, []);
    assert.deepEqual(readdirSync(path.join(project, 'rules')).sort(), [
      'KEEPSECURED.md',
      'KEEPTIDY.md',
    ]);
    assert.equal(read(project, '.gitignore'), '# keeprules: 临时目录\n/tmp/\n');
    assert.ok(read(project, 'AGENTS.md').includes('rules/KEEPTIDY.md'));
  });
});

// ── Skip policy ─────────────────────────────────────────────────────────────

test('a skipped rule still runs its project-level steps', () => {
  // Policy: an existing rule file is never overwritten, but the project
  // invariants its rule declares (.gitignore, AGENTS.md) are not the rule's
  // contents, so they are still asserted.
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['gitignore', 'agents'],
    });
    mkdirSync(path.join(project, 'rules'));
    writeFileSync(path.join(project, 'rules', 'RULE.md'), 'USER COPY\n');

    const report = installSelection({
      rules: [rule],
      cwd: project,
      confirmed: ['agents'],
    });

    assert.deepEqual(
      report.outcomes.map((outcome) => [outcome.level, outcome.message.split(' ')[0]]),
      [
        ['warn', 'rules/RULE.md'],
        ['success', '已创建'],
        ['success', '已创建'],
      ],
      'file skipped, both steps still ran',
    );
    assert.equal(read(project, 'rules/RULE.md'), 'USER COPY\n');
    assert.equal(read(project, '.gitignore'), '# keeprules: 临时目录\n/tmp/\n');
    assert.ok(read(project, 'AGENTS.md').includes('[rules/RULE.md](./rules/RULE.md)'));
  });
});

test('a skipped rule reports why the steps still ran', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, { file: 'RULE.md', name: 'RULE' });
    mkdirSync(path.join(project, 'rules'));
    writeFileSync(path.join(project, 'rules', 'RULE.md'), 'USER COPY\n');

    const report = installSelection({ rules: [rule], cwd: project });
    const [outcome] = report.outcomes;

    assert.equal(outcome.level, 'warn');
    assert.match(outcome.message, /未覆盖现有文件/);
    assert.match(outcome.message, /项目级规则步骤照常执行/);
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

test('the agents step reports when nothing installed can be referenced', () => {
  projectWith(({ sourceDir, project }) => {
    const rule = ruleFixture(sourceDir, {
      file: 'RULE.md',
      name: 'RULE',
      postInstall: ['agents'],
    });
    const broken = { ...rule, sourcePath: path.join(sourceDir, 'GONE.md') };

    const report = installSelection({
      rules: [broken],
      cwd: project,
      confirmed: ['agents'],
    });

    assert.equal(exists(project, 'AGENTS.md'), false);
    assert.ok(report.outcomes.some((outcome) => /跳过 AGENTS\.md/.test(outcome.message)));
  });
});

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
