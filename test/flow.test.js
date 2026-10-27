import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RESULT, runFlow } from '../src/flow.js';
import { CANCEL } from '../src/picker.js';
import { createPrompts } from '../src/prompts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = path.join(ROOT, 'tmp', 'runs');

/**
 * A scratch project with two rules on disk, one of which declares opt-in
 * steps. The flow is driven against the real install module, so these tests
 * assert files that actually landed.
 */
async function withProject(fn) {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_ROOT, 'flow-'));
  const source = path.join(dir, 'source');
  const project = path.join(dir, 'project');
  mkdirSync(source);
  mkdirSync(project);

  writeFileSync(path.join(source, 'ALPHA.md'), '# ALPHA\n');
  writeFileSync(path.join(source, 'BETA.md'), '# BETA\n');

  const rules = [
    {
      id: 'alpha',
      name: 'ALPHA',
      description: 'Alpha rule',
      file: 'ALPHA.md',
      sourcePath: path.join(source, 'ALPHA.md'),
      postInstall: ['gitignore', 'agents'],
    },
    {
      id: 'beta',
      name: 'BETA',
      description: 'Beta rule',
      file: 'BETA.md',
      sourcePath: path.join(source, 'BETA.md'),
      postInstall: [],
    },
  ];

  try {
    return await fn({ dir, project, rules, source });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A printer that records what it was asked to show. */
function recorder() {
  const calls = [];

  return {
    calls,
    intro: () => calls.push(['intro']),
    info: (text) => calls.push(['info', text]),
    note: (lines, title) => calls.push(['note', { lines, title }]),
    spinnerStart: (text) => calls.push(['spinnerStart', text]),
    spinnerStop: (text, failed) => calls.push(['spinnerStop', { text, failed }]),
    report: (report) => calls.push(['report', report]),
  };
}

/** Prompt answers from a script; each entry is setRules or a confirm answer. */
function scripted(script) {
  let index = 0;
  const next = () => {
    if (index >= script.length) throw new Error('script ran out of answers');
    return script[index++];
  };

  return createPrompts({
    confirm: async () => next(),
    selectRules: async () => next(),
    isCancel: () => false,
  });
}

function run({ rules, project, script, out = recorder() }) {
  return runFlow({ rules, cwd: project, prompts: scripted(script), out }).then(
    (result) => ({ result, out }),
  );
}

// ── Prompt normalization ────────────────────────────────────────────────────

test('both adapters spell cancellation the same way', async () => {
  const clackCancel = Symbol('clack:cancel');
  const prompts = createPrompts({
    confirm: async () => clackCancel,
    selectRules: async () => CANCEL,
    isCancel: (value) => value === clackCancel,
  });

  assert.deepEqual(await prompts.confirm({}), { status: 'cancel' });
  assert.deepEqual(await prompts.selectRules({}), { status: 'cancel' });
});

test('a "no" answer is declined, and a value is answered', async () => {
  const prompts = createPrompts({
    confirm: async () => false,
    selectRules: async () => ['alpha'],
    isCancel: () => false,
  });

  assert.deepEqual(await prompts.confirm({}), { status: 'declined' });
  assert.deepEqual(await prompts.selectRules({}), {
    status: 'answered',
    value: ['alpha'],
  });
});

// ── Happy paths ─────────────────────────────────────────────────────────────

test('a confirmed install copies the rule and writes both blocks', async () => {
  withProject(async ({ project, rules }) => {
    const { result, out } = await run({
      rules,
      project,
      script: [['alpha'], true, true],
    });

    assert.equal(result, RESULT.installed);
    assert.equal(readFileSync(path.join(project, 'rules/ALPHA.md'), 'utf8'), '# ALPHA\n');
    assert.match(readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), /rules\/ALPHA\.md/);
    assert.match(readFileSync(path.join(project, '.gitignore'), 'utf8'), /\/tmp\//);

    const [report] = out.calls.find(([name]) => name === 'report').slice(1);
    assert.deepEqual(report.failures, []);
    assert.equal(report.outcomes.length, 3, 'copy + gitignore + agents');
  });
});

test('declining the opt-in step installs the rule but writes no reference', async () => {
  withProject(async ({ project, rules }) => {
    const { result, out } = await run({
      rules,
      project,
      script: [['alpha'], false, true],
    });

    assert.equal(result, RESULT.installed);
    assert.equal(existsSync(path.join(project, 'AGENTS.md')), false);
    assert.equal(existsSync(path.join(project, 'rules/ALPHA.md')), true);

    const info = out.calls.filter(([name]) => name === 'info').map(([, text]) => text);
    assert.ok(
      info.some((text) => text.includes('已跳过 AGENTS.md 引用')),
      'the decline is reported',
    );
  });
});

test('the preview lists each rule with the path it will land on', async () => {
  withProject(async ({ project, rules }) => {
    const { out } = await run({ rules, project, script: [['alpha'], true, true] });

    const [, note] = out.calls.find(([name]) => name === 'note');
    assert.deepEqual(note.lines, ['ALPHA → rules/ALPHA.md']);
    assert.equal(note.title, '即将安装');
  });
});

test('a rule with no opt-in steps is only asked for the final confirmation', async () => {
  withProject(async ({ project, rules }) => {
    const asked = [];
    const prompts = createPrompts({
      confirm: async (options) => {
        asked.push(options.message);
        return true;
      },
      selectRules: async () => ['beta'],
      isCancel: () => false,
    });

    const result = await runFlow({
      rules,
      cwd: project,
      prompts,
      out: recorder(),
    });

    assert.equal(result, RESULT.installed);
    assert.equal(asked.length, 1, 'no step question for a rule without steps');
    assert.equal(existsSync(path.join(project, 'AGENTS.md')), false);
  });
});

// ── Every cancel path ───────────────────────────────────────────────────────

test('cancelling the picker installs nothing', async () => {
  withProject(async ({ project, rules }) => {
    const { result } = await run({ rules, project, script: [CANCEL] });

    assert.equal(result, RESULT.cancelled);
    assert.equal(existsSync(path.join(project, 'rules')), false);
  });
});

test('cancelling an opt-in question installs nothing', async () => {
  withProject(async ({ project, rules }) => {
    const { result } = await run({ rules, project, script: [['alpha'], CANCEL] });

    assert.equal(result, RESULT.cancelled);
    assert.equal(existsSync(path.join(project, 'rules')), false);
  });
});

test('cancelling or declining the final confirmation installs nothing', async () => {
  for (const answer of [CANCEL, false]) {
    await withProject(async ({ project, rules }) => {
      const { result } = await run({
        rules,
        project,
        script: [['alpha'], true, answer],
      });

      assert.equal(result, RESULT.cancelled, String(answer));
      assert.equal(existsSync(path.join(project, 'rules')), false);
    });
  }
});

// ── Failure reporting ───────────────────────────────────────────────────────

test('a failure makes the run failed and still reports everything', async () => {
  withProject(async ({ project, rules, source }) => {
    // One rule copies, the other's source disappears before the install.
    const broken = rules.map((rule) =>
      rule.id === 'beta'
        ? { ...rule, sourcePath: path.join(source, 'GONE.md') }
        : rule,
    );

    const { result, out } = await run({
      rules: broken,
      project,
      script: [['alpha', 'beta'], true, true],
    });

    assert.equal(result, RESULT.failed);

    const stop = out.calls.find(([name]) => name === 'spinnerStop');
    assert.deepEqual(stop[1], { text: '安装未完全成功', failed: true });

    const [report] = out.calls.find(([name]) => name === 'report').slice(1);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].subject, 'BETA');
    assert.equal(existsSync(path.join(project, 'rules/ALPHA.md')), true);
  });
});

test('the flow never invents outcomes of its own', async () => {
  withProject(async ({ project, rules }) => {
    const { out } = await run({ rules, project, script: [['alpha'], true, true] });

    const [report] = out.calls.find(([name]) => name === 'report').slice(1);
    for (const outcome of report.outcomes) {
      assert.deepEqual(Object.keys(outcome).sort(), ['level', 'message']);
    }
  });
});
