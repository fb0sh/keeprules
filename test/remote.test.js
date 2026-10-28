import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BRANCH,
  DEFAULT_SOURCE,
  DEFAULT_TIMEOUT_MS,
  REPO_URL,
  cloneRepository,
  fetchRules,
  parseSource,
} from '../src/remote.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = path.join(ROOT, 'tmp', 'runs');
const API = 'https://api.github.com';

const apiDown = async () => {
  throw new Error('API unavailable');
};

function apiReply(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

/** A scratch project plus a sibling area for symlink targets. */
async function withProject(fn) {
  mkdirSync(TMP_ROOT, { recursive: true });
  const workspace = mkdtempSync(path.join(TMP_ROOT, 'remote-'));
  const project = path.join(workspace, 'project');
  mkdirSync(project);

  try {
    return await fn(project, workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** A fake clone that writes the given `rules/` files into the destination. */
function cloneWriting(files, calls = []) {
  const cloneImpl = async (repo, destination, options) => {
    calls.push({ repo, destination, options });

    for (const [name, content] of Object.entries(files)) {
      const dir = path.join(destination, 'rules');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, name), content);
    }
  };

  return { cloneImpl, calls };
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

/** Skip a test when the platform cannot create a symlink. */
function supportsSymlinks(project, t) {
  const target = path.join(project, 'symlink-target');
  const link = path.join(project, 'symlink-probe');
  writeFileSync(target, '');

  try {
    symlinkSync(target, link, 'file');
    rmSync(link, { force: true });
    return true;
  } catch {
    t.skip('symlinks are not available on this platform');
    return false;
  }
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
  assert.equal(DEFAULT_TIMEOUT_MS, 15000);
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

// ── API raw ────────────────────────────────────────────────────────────────

test('fetchRules prefers API raw content over cloning', async () => {
  await withProject(async (project) => {
    const listing =
      `${API}/repos/user/repo/contents/rules?ref=dev`;
    const file =
      `${API}/repos/user/repo/contents/rules/DEMO.md?ref=dev`;
    const calls = [];
    let cloned = false;

    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, headers: init.headers ?? {} });

      if (url === listing) {
        return apiReply(
          JSON.stringify([{ type: 'file', name: 'DEMO.md', url: file }]),
        );
      }

      if (url === file) return apiReply('# DEMO\n');
      return apiReply('{"message":"Not Found"}', 404);
    };

    const rules = await fetchRules({
      cwd: project,
      fetchImpl,
      cloneImpl: async () => {
        cloned = true;
      },
      source: 'user/repo#dev',
      token: null,
    });

    assert.equal(rules[0].id, 'DEMO');
    assert.equal(cloned, false);
    assert.equal(existsSync(path.join(project, 'tmp')), false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.Accept, 'application/vnd.github+json');
    assert.equal(calls[1].headers.Accept, 'application/vnd.github.raw');
    assert.equal(calls[0].headers.Authorization, undefined);
  });
});

test('the API path sends GITHUB_TOKEN', async () => {
  await withProject(async (project) => {
    const listing =
      `${API}/repos/user/repo/contents/rules?ref=main`;
    const file =
      `${API}/repos/user/repo/contents/rules/DEMO.md?ref=main`;
    const calls = [];

    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, headers: init.headers ?? {} });
      if (url === listing) {
        return apiReply(
          JSON.stringify([{ type: 'file', name: 'DEMO.md', url: file }]),
        );
      }
      return apiReply('# DEMO\n');
    };

    await fetchRules({
      cwd: project,
      fetchImpl,
      cloneImpl: async () => {
        throw new Error('clone should not run');
      },
      source: 'user/repo',
      token: 'secret-token',
    });

    for (const call of calls) {
      assert.equal(call.headers.Authorization, 'Bearer secret-token');
    }
  });
});

// ── fetch: clone + read rules/ ──────────────────────────────────────────────

test('fetchRules clones the default source and reads rules/', async () => {
  await withProject(async (project) => {
    const calls = [];
    const { cloneImpl } = cloneWriting(
      { 'KEEPSECURED.md': SECURED, 'KEEPTIDY.md': TIDY },
      calls,
    );

    const rules = await fetchRules({ cwd: project, cloneImpl, fetchImpl: apiDown, token: null });

    assert.deepEqual(
      rules.map((rule) => rule.id),
      ['keepsecured', 'keeptidy'],
    );
    assert.deepEqual(rules[1].postInstall, ['gitignore', 'agents']);
    assert.equal(rules[1].content, TIDY);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].repo.label, DEFAULT_SOURCE);
    assert.equal(calls[0].repo.branch, DEFAULT_BRANCH);
    assert.equal(calls[0].options.token, null);
    assert.equal(calls[0].options.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.ok(
      calls[0].destination.startsWith(`${path.join(project, 'tmp')}${path.sep}`),
      'the clone lives under the project temp directory',
    );
    assert.equal(existsSync(path.join(project, 'tmp')), false, 'temp dir is cleaned');
  });
});

test('a third-party repository and branch are handed to git', async () => {
  await withProject(async (project) => {
    const calls = [];
    const { cloneImpl } = cloneWriting({ 'DEMO.md': '# DEMO\n' }, calls);

    const rules = await fetchRules({
      cwd: project,
      cloneImpl,
      fetchImpl: apiDown,
      source: 'user/repo#dev',
      token: null,
    });

    assert.equal(rules[0].id, 'DEMO');
    assert.equal(calls[0].repo.owner, 'user');
    assert.equal(calls[0].repo.repo, 'repo');
    assert.equal(calls[0].repo.branch, 'dev');
    assert.equal(calls[0].repo.label, 'user/repo#dev');
  });
});

test('a full GitHub URL is accepted by fetchRules', async () => {
  await withProject(async (project) => {
    const calls = [];
    const { cloneImpl } = cloneWriting({ 'DEMO.md': '# DEMO\n' }, calls);

    await fetchRules({
      cwd: project,
      cloneImpl,
      fetchImpl: apiDown,
      source: 'https://github.com/user/repo',
      token: null,
    });

    assert.equal(calls[0].repo.label, 'user/repo');
  });
});

test('GITHUB_TOKEN in the environment is passed to the clone', async () => {
  const before = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'env-token';

  try {
    await withProject(async (project) => {
      const calls = [];
      const { cloneImpl } = cloneWriting({ 'DEMO.md': '# DEMO\n' }, calls);

      await fetchRules({ cwd: project, cloneImpl, fetchImpl: apiDown });

      assert.equal(calls[0].options.token, 'env-token');
    });
  } finally {
    if (before === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = before;
  }
});

test('a repository without a rules/ directory is rejected', async () => {
  await withProject(async (project) => {
    const calls = [];
    const { cloneImpl } = cloneWriting({}, calls);

    await assert.rejects(
      fetchRules({
        cwd: project,
        cloneImpl,
        fetchImpl: apiDown,
        source: 'user/repo',
        token: null,
      }),
      /仓库 user\/repo 中没有 rules\/ 目录/,
    );
    assert.equal(existsSync(path.join(project, 'tmp')), false);
  });
});

test('a rules path that is a file is rejected', async () => {
  await withProject(async (project) => {
    const cloneImpl = async (_repo, destination) => {
      writeFileSync(path.join(destination, 'rules'), 'NOT A DIRECTORY\n');
    };

    await assert.rejects(
      fetchRules({
        cwd: project,
        cloneImpl,
        fetchImpl: apiDown,
        source: 'user/repo',
        token: null,
      }),
      /rules\/ 不是目录/,
    );
  });
});

test('an empty rules/ directory is rejected', async () => {
  await withProject(async (project) => {
    const { cloneImpl } = cloneWriting({ 'README.txt': 'not a rule' });

    await assert.rejects(
      fetchRules({
        cwd: project,
        cloneImpl,
        fetchImpl: apiDown,
        source: 'user/repo',
        token: null,
      }),
      /没有 \.md 规则文件/,
    );
  });
});

test('a symlinked rule file is refused and never read', async (t) => {
  await withProject(async (project) => {
    if (!supportsSymlinks(project, t)) return;

    const outside = path.join(project, 'outside.md');
    writeFileSync(outside, '# OUTSIDE\n');
    const cloneImpl = async (_repo, destination) => {
      const rules = path.join(destination, 'rules');
      mkdirSync(rules);
      symlinkSync(outside, path.join(rules, 'LINK.md'), 'file');
    };

    await assert.rejects(
      fetchRules({
        cwd: project,
        cloneImpl,
        fetchImpl: apiDown,
        source: 'user/repo',
        token: null,
      }),
      /符号链接/,
    );
  });
});

test('a symlinked project tmp/ directory is refused before cloning', async (t) => {
  await withProject(async (project, workspace) => {
    if (!supportsSymlinks(project, t)) return;

    const outside = path.join(workspace, 'outside-tmp');
    mkdirSync(outside);
    symlinkSync(outside, path.join(project, 'tmp'), 'dir');

    let cloned = false;
    const cloneImpl = async () => {
      cloned = true;
    };

    await assert.rejects(
      fetchRules({
        cwd: project,
        cloneImpl,
        fetchImpl: apiDown,
        source: 'user/repo',
        token: null,
      }),
      /tmp\/ 是符号链接/,
    );
    assert.equal(cloned, false);
    assert.deepEqual(readdirSync(outside), []);
  });
});

test('a clone failure leaves no temporary directory behind', async () => {
  await withProject(async (project) => {
    const cloneImpl = async () => {
      throw new Error('仓库不存在或无权访问: user/repo');
    };

    await assert.rejects(
      fetchRules({
        cwd: project,
        cloneImpl,
        fetchImpl: apiDown,
        source: 'user/repo',
        token: null,
      }),
      /仓库不存在或无权访问/,
    );
    assert.equal(existsSync(path.join(project, 'tmp')), false);
  });
});

test('an invalid source is rejected before creating a temp directory', async () => {
  await withProject(async (project) => {
    let cloned = false;
    const cloneImpl = async () => {
      cloned = true;
    };

    await assert.rejects(
      fetchRules({
        cwd: project,
        cloneImpl,
        fetchImpl: apiDown,
        source: 'user/repo/extra',
        token: null,
      }),
      /无法识别的规则来源/,
    );
    assert.equal(cloned, false);
    assert.equal(existsSync(path.join(project, 'tmp')), false);
  });
});

test('fetchRules falls back from API to SSH clone before HTTPS', async () => {
  await withProject(async (project) => {
    const protocols = [];
    const cloneImpl = async (_repo, destination, options) => {
      protocols.push(options.protocol);

      if (options.protocol === 'ssh') {
        throw new Error('ssh clone unavailable');
      }

      mkdirSync(path.join(destination, 'rules'), { recursive: true });
      writeFileSync(path.join(destination, 'rules', 'DEMO.md'), '# DEMO\n');
    };

    const rules = await fetchRules({
      cwd: project,
      cloneImpl,
      fetchImpl: apiDown,
      source: 'user/repo',
      token: null,
    });

    assert.equal(rules[0].id, 'DEMO');
    assert.deepEqual(protocols, ['ssh', 'https']);
    assert.equal(existsSync(path.join(project, 'tmp')), false);
  });
});

test('fetchRules reports both API and clone failures', async () => {
  await withProject(async (project) => {
    const cloneImpl = async () => {
      throw new Error('clone unavailable');
    };

    await assert.rejects(
      fetchRules({
        cwd: project,
        cloneImpl,
        fetchImpl: apiDown,
        source: 'user/repo',
        token: null,
      }),
      /API unavailable.*clone 回退失败.*clone unavailable/s,
    );
  });
});

// ── clone command and errors ────────────────────────────────────────────────

test('cloneRepository performs a shallow sparse clone with token auth', async () => {
  const calls = [];
  const destination = path.join(ROOT, 'tmp', 'runs', 'fake-clone');
  const execFileImpl = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: '', stderr: '' };
  };

  await cloneRepository(parseSource('user/repo#dev'), destination, {
    execFileImpl,
    token: 'secret-token',
    timeoutMs: 1234,
  });

  assert.equal(calls.length, 2);

  const [clone, sparse] = calls;
  assert.equal(clone.file, 'git');
  assert.equal(clone.args[0], 'clone');
  assert.equal(clone.args[clone.args.indexOf('--branch') + 1], 'dev');
  assert.ok(clone.args.includes('--depth'));
  assert.ok(clone.args.includes('--single-branch'));
  assert.ok(clone.args.includes('--filter=blob:none'));
  assert.ok(clone.args.includes('--sparse'));
  assert.ok(clone.args.includes('https://github.com/user/repo.git'));
  assert.equal(clone.args.at(-1), destination);
  assert.equal(clone.options.timeout, 1234);
  assert.equal(clone.options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(clone.options.env.GIT_LFS_SKIP_SMUDGE, '1');
  assert.equal(
    clone.options.env.GIT_CONFIG_VALUE_0,
    `Authorization: basic ${Buffer.from('x-access-token:secret-token').toString('base64')}`,
  );
  assert.deepEqual(sparse.args, [
    '-C',
    destination,
    'sparse-checkout',
    'set',
    'rules',
  ]);
});

test('cloneRepository can use the SSH transport', async () => {
  const calls = [];
  const execFileImpl = async (_file, args, options) => {
    calls.push({ args, options });
    return { stdout: '', stderr: '' };
  };

  await cloneRepository(parseSource('user/repo'), '/tmp/fake-clone', {
    protocol: 'ssh',
    execFileImpl,
    token: null,
  });

  assert.ok(calls[0].args.includes('ssh://git@github.com/user/repo.git'));
  assert.equal(calls[0].options.env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
  assert.equal(calls[0].options.env.GIT_CONFIG_COUNT, undefined);
});

test('cloneRepository omits auth when no token is available', async () => {
  const calls = [];
  const execFileImpl = async (_file, _args, options) => {
    calls.push(options);
    return { stdout: '', stderr: '' };
  };

  await cloneRepository(parseSource('user/repo'), '/tmp/fake-clone', {
    execFileImpl,
    token: null,
  });

  assert.equal(calls[0].env.GIT_CONFIG_COUNT, undefined);
});

test('cloneRepository explains common git failures', async () => {
  const repo = parseSource('user/repo#dev');
  const destination = path.join(ROOT, 'tmp', 'runs', 'fake-clone');

  const cases = [
    [{ code: 'ENOENT' }, /未找到 git/],
    [{ stderr: 'remote: Repository not found.\nfatal: unable' }, /仓库不存在或无权访问/],
    [{ stderr: 'fatal: Authentication failed for repo' }, /认证失败/],
    [{ stderr: 'fatal: Remote branch dev not found in upstream origin' }, /分支不存在.*dev/],
    [{ killed: true, signal: 'SIGTERM' }, /超时/],
    [
      { stderr: 'fatal: unable to access repo: Could not resolve host: github.com' },
      /无法连接 GitHub/,
    ],
  ];

  for (const [error, expected] of cases) {
    const execFileImpl = async () => {
      throw error;
    };

    await assert.rejects(
      cloneRepository(repo, destination, {
        execFileImpl,
        token: null,
        timeoutMs: 15000,
      }),
      expected,
    );
  }
});
