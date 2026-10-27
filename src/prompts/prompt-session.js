/**
 * Normalized prompt outcomes.
 *
 * The custom rule picker and clack prompts have different cancel sentinels.
 * This seam converts both to one CANCELLED outcome so the install flow never
 * branches on adapter-specific cancel details.
 */

import * as p from '@clack/prompts';
import { CANCEL, ruleMultiselect } from './rule-multiselect.js';

export const CANCELLED = Symbol('keeprules:cancelled');

const defaultAdapters = {
  confirm: (options) => p.confirm(options),
  selectRules: (options) => ruleMultiselect(options),
  isCancel: (value) => p.isCancel(value),
};

/**
 * @param {{
 *   confirm: (options: object) => Promise<unknown>,
 *   selectRules: (options: object) => Promise<unknown>,
 *   isCancel: (value: unknown) => boolean,
 * }} adapters
 */
export function createPromptSession(adapters = defaultAdapters) {
  return {
    async confirm(options) {
      const result = await adapters.confirm(options);
      return adapters.isCancel(result) ? CANCELLED : result;
    },

    async selectRules(options) {
      const result = await adapters.selectRules(options);
      return result === CANCEL || adapters.isCancel(result)
        ? CANCELLED
        : result;
    },
  };
}

export const promptSession = createPromptSession();
