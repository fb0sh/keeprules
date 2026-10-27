/**
 * Prompt outcomes.
 *
 * A question can end three ways: answered, declined, or cancelled. clack and
 * the rule picker spell those differently, so this wraps both into one shape the
 * flow can branch on: `{status: 'answered' | 'declined' | 'cancel', value?}`.
 */

import * as p from '@clack/prompts';
import { CANCEL, ruleMultiselect } from './picker.js';

/**
 * @param {object} adapters
 * @param {(options: object) => Promise<unknown>} adapters.confirm
 * @param {(options: object) => Promise<unknown>} adapters.selectRules
 * @param {(value: unknown) => boolean} adapters.isCancel
 */
export function createPrompts({ confirm, selectRules, isCancel }) {
  const normalize = (raw) => {
    if (raw === CANCEL || isCancel(raw)) return { status: 'cancel' };
    if (raw === false) return { status: 'declined' };
    return { status: 'answered', value: raw };
  };

  return {
    confirm: async (options) => normalize(await confirm(options)),
    selectRules: async (options) => normalize(await selectRules(options)),
  };
}

/** The real prompts: clack for yes/no, the custom picker for the rule list. */
export const prompts = createPrompts({
  confirm: (options) => p.confirm(options),
  selectRules: (options) => ruleMultiselect(options),
  isCancel: (value) => p.isCancel(value),
});
