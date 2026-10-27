#!/usr/bin/env node

/**
 * Regenerate rules/index.json from the rule files in rules/.
 *
 * The manifest exists because HTTP cannot list a directory: the CLI fetches
 * `rules/index.json` from the repository and then fetches exactly the files it
 * names. Run this after adding or removing a rule; a test fails if the manifest
 * drifts from the directory.
 */

import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'rules',
);

const files = readdirSync(RULES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => entry.name)
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

writeFileSync(
  path.join(RULES_DIR, 'index.json'),
  `${JSON.stringify({ files }, null, 2)}\n`,
  'utf8',
);

console.log(`rules/index.json: ${files.length} rule(s)`);
