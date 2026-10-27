import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANCELLED,
  createPromptSession,
} from '../src/prompts/prompt-session.js';
import { CANCEL } from '../src/prompts/rule-multiselect.js';

test('clack-style cancels normalize to one outcome', async () => {
  const clackCancel = Symbol('clack:cancel');
  const session = createPromptSession({
    confirm: async () => clackCancel,
    selectRules: async () => [],
    isCancel: (value) => value === clackCancel,
  });

  assert.equal(await session.confirm({}), CANCELLED);
});

test('custom picker cancels normalize to the same outcome', async () => {
  const session = createPromptSession({
    confirm: async () => true,
    selectRules: async () => CANCEL,
    isCancel: () => false,
  });

  assert.equal(await session.selectRules({}), CANCELLED);
});

test('answers pass through without adapter-specific checks', async () => {
  const session = createPromptSession({
    confirm: async () => false,
    selectRules: async () => ['keeptidy'],
    isCancel: () => false,
  });

  assert.equal(await session.confirm({}), false);
  assert.deepEqual(await session.selectRules({}), ['keeptidy']);
});
