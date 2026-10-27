import test from 'node:test';
import assert from 'node:assert/strict';

import { MANIFEST_URL, REPO_URL, fetchRules } from '../src/remote.js';

/** A fake fetch over an in-memory file map. No test ever touches the network. */
function server(files) {
  const calls = [];

  const fetchImpl = async (url) => {
    calls.push(url);
    const name = url.replace(/^.*\/rules\//, '');
    const body = files[name];

    if (body === undefined) {
      return { ok: false, status: 404, text: async () => 'Not Found' };
    }

    return { ok: true, status: 200, text: async () => body };
  };

  return { fetchImpl, calls };
}

const TIDY = [
  '---',
  'id: keeptidy',
  'name: KEEPTIDY',
  'description: 工程卫生',
  'postInstall:',
  '  - gitignore',
  '  - agents',
  '---',
  '# KEEPTIDY',
].join('\n');

const SECURED = '---\nid: keepsecured\nname: KEEPSECURED\n---\n# KEEPSECURED\n';

const MANIFEST = JSON.stringify({ files: ['KEEPSECURED.md', 'KEEPTIDY.md'] });

/** The happy path: manifest + two rule files. */
function healthy() {
  return server({
    'index.json': MANIFEST,
    'KEEPSECURED.md': SECURED,
    'KEEPTIDY.md': TIDY,
  });
}

test('the manifest drives which files are fetched, and they parse into rules', async () => {
  const { fetchImpl, calls } = healthy();

  const rules = await fetchRules({ fetchImpl });

  assert.deepEqual(
    rules.map((rule) => rule.id),
    ['keepsecured', 'keeptidy'],
  );
  assert.deepEqual(rules[1].postInstall, ['gitignore', 'agents']);
  assert.equal(rules[1].content, TIDY, 'the raw content is kept, ready to write');

  assert.deepEqual(calls, [
    MANIFEST_URL,
    'https://raw.githubusercontent.com/fb0sh/keeprules/main/rules/KEEPSECURED.md',
    'https://raw.githubusercontent.com/fb0sh/keeprules/main/rules/KEEPTIDY.md',
  ]);
});

test('the message names the repository so a user can check it', () => {
  assert.equal(REPO_URL, 'https://github.com/fb0sh/keeprules');
});

// ── There is no fallback: every failure stops the install ───────────────────

test('an unreachable repository fails with a readable reason', async () => {
  const refusing = async () => {
    throw new TypeError('fetch failed');
  };

  await assert.rejects(fetchRules({ fetchImpl: refusing }), /无法读取规则清单（fetch failed）/);
});

test('a slow repository times out instead of hanging', async () => {
  const hanging = (_url, { signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

  await assert.rejects(
    fetchRules({ fetchImpl: hanging, timeoutMs: 20 }),
    /连接超时（>0\.02s）/,
  );
});

test('a missing manifest is reported as an HTTP status', async () => {
  await assert.rejects(
    fetchRules({ fetchImpl: server({}).fetchImpl }),
    /无法读取规则清单（HTTP 404）/,
  );
});

test('a manifest that is not JSON is reported as such', async () => {
  const broken = async () => ({ ok: true, text: async () => '<html>404</html>' });

  await assert.rejects(fetchRules({ fetchImpl: broken }), /内容不是合法 JSON/);
});

test('an empty or malformed manifest is rejected', async () => {
  for (const body of ['{}', '{"files":[]}', '{"files":"KEEPTIDY.md"}']) {
    const fetchImpl = async () => ({ ok: true, text: async () => body });
    await assert.rejects(fetchRules({ fetchImpl }), /缺少 files 列表/, body);
  }
});

test('a manifest naming a file outside the directory is refused', async () => {
  for (const file of ['../secret.md', 'a/b.md', 'x.json', '']) {
    const fetchImpl = async () => ({
      ok: true,
      text: async () => JSON.stringify({ files: [file] }),
    });

    await assert.rejects(fetchRules({ fetchImpl }), /文件名不合法/, String(file));
  }
});

test('a rule file that cannot be fetched names the file', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('index.json')
      ? { ok: true, text: async () => '{"files":["MISSING.md"]}' }
      : { ok: false, status: 500, text: async () => '' };

  await assert.rejects(
    fetchRules({ fetchImpl }),
    /无法读取 MISSING\.md（HTTP 500）/,
  );
});

test('a platform without fetch says so instead of crashing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = undefined;

  try {
    await assert.rejects(fetchRules(), /需要 Node 18/);
  } finally {
    globalThis.fetch = original;
  }
});
