/**
 * The interactive install flow.
 *
 * Pick rules → ask about opt-in steps → confirm → install → report. Prompts and
 * printing are passed in, so this runs without a terminal; the shell in bin/
 * supplies the real ones.
 *
 * Three outcomes: installed, cancelled, failed. Cancellation is decided once,
 * here, no matter which question the user escaped from.
 */

import {
  agentsNotes,
  installSelection,
  promptSteps,
  ruleTargetPath,
} from './install.js';

/** What the flow reports back to its caller. */
export const RESULT = Object.freeze({
  installed: 'installed',
  cancelled: 'cancelled',
  failed: 'failed',
});

/**
 * @param {object} options
 * @param {object[]} options.rules every available rule
 * @param {string} options.cwd target project
 * @param {object} options.prompts { selectRules, confirm } — both resolve to
 *   `{status: 'answered' | 'declined' | 'cancel', value?}`
 * @param {object} options.out { intro, info, note, spinnerStart, spinnerStop,
 *   report }
 * @returns {Promise<string>} one of RESULT
 */
export async function runFlow({ rules, cwd, prompts, out }) {
  const value = (answer) =>
    answer.status === 'answered' ? answer.value : undefined;

  out.intro();
  out.info(`安装目标: ${cwd}`);

  const selection = await prompts.selectRules({
    message: '选择要安装的规则',
    items: rules.map((rule) => ({
      value: rule.id,
      label: rule.name,
      description: rule.description,
    })),
    // Nothing is selected by default; users opt in explicitly.
    initialSelected: [],
    required: true,
  });

  if (selection.status === 'cancel') return RESULT.cancelled;

  const chosen = new Set(value(selection) ?? []);
  const selected = rules.filter((rule) => chosen.has(rule.id));

  // Only opt-in steps that a selected rule actually declares are worth asking.
  const confirmed = [];

  for (const step of promptSteps(selected)) {
    const answer = await prompts.confirm({
      message: step.prompt,
      initialValue: true,
    });

    if (answer.status === 'cancel') return RESULT.cancelled;

    if (value(answer) === true) {
      confirmed.push(step.name);
    } else {
      out.info(step.declined);
    }
  }

  out.note(
    selected.map((rule) => `${rule.name} → ${ruleTargetPath(rule)}`),
    '即将安装',
  );

  // The agents step rewrites AGENTS.md. Show the lines rules inject there, so a
  // third-party rule's text is reviewed before the install rather than after.
  if (confirmed.includes('agents')) {
    const injected = selected.flatMap((rule) => {
      try {
        const notes = agentsNotes(rule.content, `规则 ${rule.file}`);

        return notes.length === 0
          ? []
          : [
              `${rule.name}:`,
              ...notes.map((line) => (line === '' ? '' : `  ${line}`)),
            ];
      } catch (error) {
        // The message already names the rule file; the install will fail on it.
        return [error.message];
      }
    });

    if (injected.length > 0) {
      out.note(injected, 'AGENTS.md 将追加的核心约束');
    }
  }

  const go = await prompts.confirm({
    message: `确认安装以上 ${selected.length} 个规则？`,
    initialValue: true,
  });

  if (go.status !== 'answered' || go.value !== true) return RESULT.cancelled;

  out.spinnerStart('正在安装规则...');

  const report = installSelection({ rules: selected, cwd, confirmed });

  const failed = report.failures.length > 0;
  out.spinnerStop(failed ? '安装未完全成功' : '规则安装完成', failed);
  out.report(report);

  return failed ? RESULT.failed : RESULT.installed;
}
