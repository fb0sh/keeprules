import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BRANCH,
  DEFAULT_SOURCE,
  REPO_URL,
  fetchRules,
  parseSource,
} from '../src/remote.js';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

const contentsUrl = (source, branch = 'main') =>
  `${API}/repos/${source}/contents/rules?ref=${encodeURIComponent(branch)}`;

const repoUrl = (source) => `${API}/repos/${source}`;

const rawUrl = (source, file, branch = 'main') =>
  `${RAW}/${source}/${branch}/rules/${file}`;

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/** A fake GitHub API. Every request is recorded; unknown URLs are 404. */
function github(routes) {
  const calls = [];

  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} });
    const route = routes[url];

    if (route === undefined) return reply(404, '{"message":"Not Found"}');
    return typeof route === 'function' ? route(url, init) : route;
  };

  return { fetchImpl, calls };
}

function entry(name, source = 'fb0sh/keeprules', branch = 'main') {
  return {
    type: 'file',
    name,
    download_url: `${RAW}/${source}/${branch}/rules/${name}`,
  };
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

/** The happy path: a directory listing plus two rule files. */
function healthy(source = 'fb0sh/keeprules', branch = 'main') {
  return github({
    [contentsUrl(source, branch)]: reply(
      200,
      JSON.stringify([
        entry('KEEPTIDY.md', source, branch),
        entry('KEEPSECURED.md', source, branch),
        { type: 'dir', name: 'nested', download_url: null },
        {
          type: 'file',
          name: 'index.json',
          download_url: `${RAW}/${source}/${branch}/rules/index.json`,
        },
      ]),
    ),
    [rawUrl(source, 'KEEPSECURED.md', branch)]: reply(200, SECURED),
    [rawUrl(source, 'KEEPTIDY.md', branch)]: reply(200, TIDY),
  });
}

// ── source parsing ──────────────────────────────────────────────────────────

test('the default source is the official repository on main', () => {
  assert.deepEqual(parseSource(), {
    owner: 'fb0sh',
    repo: 'keeprules',
    branch: 'main',
    label: 'fb0sh/keeprules',
    url: 'https://github.com/fb0sh/keeprules',
  });
  assert.equal(DEFAULT_SOURCE, 'fb0sh/keeprules');
  assert.equal(DEFAULT_BRANCH, 'main');
  assert.equal(REPO_URL, 'https://github.com/fb0sh/keeprules');
});

test('all documented source forms resolve to the same repository and branch', () => {
  const forms = [
    'user/repo',
    'user/repo/',
    'user/repo.git',
    'https://github.com/user/repo',
    'https://github.com/user/repo/',
    'https://github.com/user/repo.git',
    'http://www.github.com/user/repo',
    'github.com/user/repo',
    'git@github.com:user/repo.git',
  ];

  for (const source of forms) {
    assert.deepEqual(
      parseSource(source),
      {
        owner: 'user',
        repo: 'repo',
        branch: 'main',
        label: 'user/repo',
        url: 'https://github.com/user/repo',
      },
      source,
    );
  }
});

test('a #branch fragment selects the ref, including branches with slashes', () => {
  for (const [source, branch] of [
    ['user/repo#dev', 'dev'],
    ['https://github.com/user/repo#dev', 'dev'],
    ['https://github.com/user/repo.git#release/1.0', 'release/1.0'],
  ]) {
    const parsed = parseSource(source);

    assert.equal(parsed.branch, branch, source);
    assert.equal(parsed.label, `user/repo#${branch}`, source);
  }
});

test('unrecognized sources are rejected with the accepted forms', () => {
  for (const source of [
    '',
    '   ',
    'user',
    'user/repo/extra',
    'https://gitlab.com/user/repo',
    'https://github.com/user/repo/tree/dev',
    'user/repo#',
    'user/repo#bad branch',
    'user/repo?tab=readme',
  ]) {
    assert.throws(
      () => parseSource(source),
      /无法识别的规则来源|只支持 GitHub 仓库/,
      source,
    );
  }
});

// ── happy path ──────────────────────────────────────────────────────────────

test('the Contents API listing drives which files are fetched and parsed', async () => {
  const { fetchImpl, calls } = healthy();

  const rules = await fetchRules({ fetchImpl, token: null });

  assert.deepEqual(
    rules.map((rule) => rule.id),
    ['keepsecured', 'keeptidy'],
  );
  assert.deepEqual(rules[1].postInstall, ['gitignore', 'agents']);
  assert.equal(rules[1].content, TIDY, 'the raw content is kept, ready to write');

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      contentsUrl('fb0sh/keeprules'),
      rawUrl('fb0sh/keeprules', 'KEEPSECURED.md'),
      rawUrl('fb0sh/keeprules', 'KEEPTIDY.md'),
    ],
  );
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('a third-party repository and branch are fetched from their own URLs', async () => {
  const { fetchImpl, calls } = healthy('user/repo', 'dev');

  const rules = await fetchRules({ fetchImpl, source: 'user/repo#dev', token: null });

  assert.deepEqual(
    rules.map((rule) => rule.id),
    ['keepsecured', 'keeptidy'],
  );
  assert.equal(calls[0].url, contentsUrl('user/repo', 'dev'));
  assert.equal(calls[0].url, `${API}/repos/user/repo/contents/rules?ref=dev`);
});

test('an https source is accepted by fetchRules', async () => {
  const { fetchImpl, calls } = healthy('user/repo');

  const rules = await fetchRules({
    fetchImpl,
    source: 'https://github.com/user/repo',
    token: null,
  });

  assert.equal(rules.length, 2);
  assert.equal(calls[0].url, contentsUrl('user/repo'));
});

test('a missing download_url falls back to raw.githubusercontent.com', async () => {
  const source = 'fb0sh/keeprules';
  const file = 'BARE.md';
  const { fetchImpl, calls } = github({
    [contentsUrl(source)]: reply(200, JSON.stringify([{ type: 'file', name: file }])),
    [rawUrl(source, file)]: reply(200, '# Bare title\n\nBody.\n'),
  });

  const [rule] = await fetchRules({ fetchImpl, token: null });

  assert.deepEqual(calls.map((call) => call.url), [
    contentsUrl(source),
    rawUrl(source, file),
  ]);
  assert.equal(rule.id, 'BARE');
  assert.equal(rule.description, 'Bare title');
});

test('a GITHUB_TOKEN is sent to both the API and raw downloads', async () => {
  const { fetchImpl, calls } = healthy();

  await fetchRules({ fetchImpl, token: 'secret-token' });

  assert.equal(calls.length, 3);
  for (const { headers } of calls) {
    assert.equal(headers.Authorization, 'Bearer secret-token');
  }
});

test('GITHUB_TOKEN in the environment is used by default', async () => {
  const before = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'env-token';

  try {
    const { fetchImpl, calls } = healthy();
    await fetchRules({ fetchImpl });

    assert.equal(calls[0].headers.Authorization, 'Bearer env-token');
  } finally {
    if (before === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = before;
  }
});

// ── repository and directory failures ───────────────────────────────────────

test('a missing repository is reported as missing, after a repo probe', async () => {
  const { fetchImpl, calls } = github({
    [contentsUrl('user/repo')]: reply(404, '{"message":"Not Found"}'),
    [repoUrl('user/repo')]: reply(404, '{"message":"Not Found"}'),
  });

  await assert.rejects(
    fetchRules({ fetchImpl, source: 'user/repo', token: null }),
    /仓库不存在或无权访问: user\/repo/,
  );
  assert.deepEqual(calls.map((call) => call.url), [
    contentsUrl('user/repo'),
    repoUrl('user/repo'),
  ]);
});

test('a repository without rules/ says so, after a repo probe', async () => {
  const { fetchImpl } = github({
    [contentsUrl('user/repo')]: reply(404, '{"message":"Not Found"}'),
    [repoUrl('user/repo')]: reply(200, '{"full_name":"user/repo"}'),
  });

  await assert.rejects(
    fetchRules({ fetchImpl, source: 'user/repo', token: null }),
    /仓库 user\/repo 中没有 rules\/ 目录/,
  );
});

test('the rules path being a file is not treated as a directory', async () => {
  const { fetchImpl } = github({
    [contentsUrl('user/repo')]: reply(
      200,
      JSON.stringify({ type: 'file', name: 'rules' }),
    ),
  });

  await assert.rejects(
    fetchRules({ fetchImpl, source: 'user/repo', token: null }),
    /不是目录/,
  );
});

test('an empty rules/ directory is rejected', async () => {
  const { fetchImpl } = github({
    [contentsUrl('user/repo')]: reply(
      200,
      JSON.stringify([{ type: 'dir', name: 'nested' }]),
    ),
  });

  await assert.rejects(
    fetchRules({ fetchImpl, source: 'user/repo', token: null }),
    /没有 \.md 规则文件/,
  );
});

test('HTML instead of JSON is reported as a bad API response', async () => {
  const { fetchImpl } = github({
    [contentsUrl('fb0sh/keeprules')]: reply(200, '<html>oops</html>'),
  });

  await assert.rejects(fetchRules({ fetchImpl, token: null }), /不是合法 JSON/);
});

// ── HTTP and network failures ───────────────────────────────────────────────

test('rate limiting suggests GITHUB_TOKEN', async () => {
  const { fetchImpl } = github({
    [contentsUrl('fb0sh/keeprules')]: reply(
      403,
      '{"message":"API rate limit exceeded"}',
    ),
  });

  await assert.rejects(
    fetchRules({ fetchImpl, token: null }),
    /速率限制.*GITHUB_TOKEN/,
  );
});

test('a bad token is named as the problem', async () => {
  const { fetchImpl } = github({
    [contentsUrl('fb0sh/keeprules')]: reply(401, '{"message":"Bad credentials"}'),
  });

  await assert.rejects(
    fetchRules({ fetchImpl, token: 'bad' }),
    /GITHUB_TOKEN 无效或已过期/,
  );
});

test('an unreachable repository fails with a readable reason', async () => {
  const refusing = async () => {
    throw new TypeError('fetch failed');
  };

  await assert.rejects(
    fetchRules({ fetchImpl: refusing, token: null }),
    /无法访问 fb0sh\/keeprules 的 rules\/ 目录（fetch failed）/,
  );
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
    fetchRules({ fetchImpl: hanging, timeoutMs: 20, token: null }),
    /连接超时（>0\.02s）/,
  );
});

test(
  'a response body that never finishes also times out',
  { timeout: 1000 },
  async () => {
    const hangingBody = (_url, { signal }) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      });

    await assert.rejects(
      fetchRules({ fetchImpl: hangingBody, timeoutMs: 20, token: null }),
      /连接超时（>0\.02s）/,
    );
  },
);

test('a rule file that cannot be fetched names the file', async () => {
  const source = 'fb0sh/keeprules';
  const { fetchImpl } = github({
    [contentsUrl(source)]: reply(200, JSON.stringify([entry('MISSING.md')])),
    [rawUrl(source, 'MISSING.md')]: reply(500, ''),
  });

  await assert.rejects(
    fetchRules({ fetchImpl, token: null }),
    /无法读取 MISSING\.md（GitHub 服务异常（HTTP 500））/,
  );
});

test('a file name that could escape the rules directory is refused', async () => {
  const { fetchImpl } = github({
    [contentsUrl('user/repo')]: reply(
      200,
      JSON.stringify([{ type: 'file', name: '../secret.md' }]),
    ),
  });

  await assert.rejects(
    fetchRules({ fetchImpl, source: 'user/repo', token: null }),
    /规则文件名不合法/,
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
