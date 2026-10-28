/**
 * Rules come from a GitHub repository, not from the package.
 *
 * The repository is shallow-cloned into the project's `tmp/` directory with a
 * sparse checkout, so only `rules/` is materialized. This avoids the raw CDN
 * entirely while preserving branch semantics and private-repository support.
 */

import { execFile } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadRules } from './rules.js';

/** Where rules come from when the user does not name a repository. */
export const DEFAULT_SOURCE = 'fb0sh/keeprules';

/** The branch used when a source does not name one. */
export const DEFAULT_BRANCH = 'main';

/** How long a git clone or sparse-checkout may take. */
export const DEFAULT_TIMEOUT_MS = 15000;

/** The official repository page, for messages that need a human-legible URL. */
export const REPO_URL = `https://github.com/${DEFAULT_SOURCE}`;

const RULES_DIR = 'rules';
const API_BASE = 'https://api.github.com';
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const execFileAsync = promisify(execFile);

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPO = /^[A-Za-z0-9._-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

function invalidSource(input) {
  return new Error(
    `无法识别的规则来源: ${JSON.stringify(input)}。` +
      '请使用 user/repo、https://github.com/user/repo 或 user/repo#branch。',
  );
}

/**
 * Parse `user/repo`, a GitHub URL, or `user/repo#branch`.
 *
 * The accepted surface is intentionally small: only GitHub, one repository,
 * one optional ref. Anything else is rejected before a clone is attempted.
 *
 * @param {string} [input] source, defaulting to the official repository
 * @returns {{owner: string, repo: string, branch: string, label: string, url: string}}
 * @throws {Error} with a message suitable for showing the user
 */
export function parseSource(input = DEFAULT_SOURCE) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw invalidSource(input);
  }

  let text = input.trim();
  let branch = DEFAULT_BRANCH;

  const hash = text.lastIndexOf('#');
  if (hash !== -1) {
    branch = text.slice(hash + 1).trim();
    text = text.slice(0, hash).trim();

    if (
      branch === '' ||
      !BRANCH.test(branch) ||
      branch.includes('..') ||
      branch.startsWith('/') ||
      branch.endsWith('/')
    ) {
      throw invalidSource(input);
    }
  }

  text = text.replace(/\/+$/, '');
  if (/\.git$/i.test(text)) text = text.slice(0, -4);

  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(text);
  const web = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)$/i.exec(
    text,
  );

  let owner;
  let repo;

  if (ssh) {
    [, owner, repo] = ssh;
  } else if (web) {
    [, owner, repo] = web;
  } else if (/^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(text)) {
    throw invalidSource(input);
  } else if (text.includes('://') || text.includes(':')) {
    throw new Error(
      `只支持 GitHub 仓库: ${JSON.stringify(input)}。` +
        '请使用 user/repo、https://github.com/user/repo 或 user/repo#branch。',
    );
  } else {
    const parts = text.split('/');
    if (parts.length !== 2) throw invalidSource(input);
    [owner, repo] = parts;
  }

  if (
    !OWNER.test(owner) ||
    owner.length > 39 ||
    !REPO.test(repo) ||
    repo === '.' ||
    repo === '..'
  ) {
    throw invalidSource(input);
  }

  return {
    owner,
    repo,
    branch,
    label:
      branch === DEFAULT_BRANCH
        ? `${owner}/${repo}`
        : `${owner}/${repo}#${branch}`,
    url: `https://github.com/${owner}/${repo}`,
  };
}

// ── API raw fallback ─────────────────────────────────────────────────────────

function describe(error, timeoutMs) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return `连接超时（>${timeoutMs / 1000}s）`;
  }
  return error?.message ?? String(error);
}

function apiHeaders(token, accept) {
  const headers = {
    Accept: accept,
    'User-Agent': 'keeprules',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Fetch one URL as text, keeping the timeout armed through the body. */
async function requestText(url, { fetchImpl, timeoutMs, token, accept }) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前 Node 没有 fetch，需要 Node 18 或更高版本');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: apiHeaders(token, accept),
    });
    const body = await response.text();

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return body;
  } catch (error) {
    if (error.status) throw error;
    throw new Error(describe(error, timeoutMs));
  } finally {
    clearTimeout(timer);
  }
}

function apiDetail(body) {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.message === 'string' ? parsed.message : '';
  } catch {
    return '';
  }
}

function apiReason(status, body = '') {
  const detail = apiDetail(body);

  if (status === 401) return 'GITHUB_TOKEN 无效或已过期（HTTP 401）';
  if (status === 403 || status === 429) {
    return `GitHub API 速率限制或访问被拒绝（HTTP ${status}）${
      detail ? `：${detail}` : ''
    }。可设置 GITHUB_TOKEN`;
  }
  if (status === 404) return '仓库或 rules/ 目录不存在（HTTP 404）';
  if (status >= 500) return `GitHub 服务异常（HTTP ${status}）`;
  return detail ? `HTTP ${status}（${detail}）` : `HTTP ${status}`;
}

/** Download rules through api.github.com using the raw media type. */
async function fetchViaApi(repo, { fetchImpl, token, timeoutMs }) {
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.repo);
  const listingUrl =
    `${API_BASE}/repos/${owner}/${name}/contents/rules` +
    `?ref=${encodeURIComponent(repo.branch)}`;

  let body;

  try {
    body = await requestText(listingUrl, {
      fetchImpl,
      timeoutMs,
      token,
      accept: 'application/vnd.github+json',
    });
  } catch (error) {
    const reason = error.status
      ? apiReason(error.status, error.body)
      : error.message;
    throw new Error(`API 读取 ${repo.label} 的 rules/ 失败（${reason}）`);
  }

  let entries;

  try {
    entries = JSON.parse(body);
  } catch {
    throw new Error(`GitHub API 返回的 rules/ 内容不是合法 JSON（${repo.label}）`);
  }

  if (!Array.isArray(entries)) {
    throw new Error(`${repo.label} 的 rules 不是目录`);
  }

  const ruleEntries = entries.filter(
    (entry) =>
      entry?.type === 'file' &&
      typeof entry.name === 'string' &&
      entry.name.toLowerCase().endsWith('.md'),
  );

  if (ruleEntries.length === 0) {
    throw new Error(`${repo.label} 的 rules/ 目录下没有 .md 规则文件`);
  }

  const files = await Promise.all(
    ruleEntries.map(async (entry) => {
      const url =
        typeof entry.url === 'string' && entry.url !== ''
          ? entry.url
          : `${API_BASE}/repos/${owner}/${name}/contents/rules/${encodeURIComponent(
              entry.name,
            )}?ref=${encodeURIComponent(repo.branch)}`;

      try {
        return {
          file: entry.name,
          content: await requestText(url, {
            fetchImpl,
            timeoutMs,
            token,
            accept: 'application/vnd.github.raw',
          }),
        };
      } catch (error) {
        const reason = error.status
          ? apiReason(error.status, error.body)
          : error.message;
        throw new Error(`API 读取 ${entry.name} 失败（${reason}）`);
      }
    }),
  );

  return loadRules(files);
}

// ── filesystem helpers ──────────────────────────────────────────────────────

/** `lstat`, or null when the path does not exist. */
function lstatOrNull(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** Is `candidate` `root` itself or below it? Both must be absolute. */
function isInsideOrEqual(root, candidate) {
  const relative = path.relative(root, candidate);

  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Prepare `PROJECT_ROOT/tmp` without following a symlink out of the project.
 * The caller removes the directory again if it created it and it stays empty.
 */
function prepareTmp(cwd) {
  let root;

  try {
    root = realpathSync(cwd);
  } catch (error) {
    throw new Error(`无法解析安装目录（${error.message}）`);
  }

  const tmp = path.join(root, 'tmp');
  const stat = lstatOrNull(tmp);

  if (!stat) {
    try {
      mkdirSync(tmp);
    } catch (error) {
      throw new Error(`无法创建项目 tmp/ 目录（${error.message}）`);
    }

    return { tmp, created: true };
  }

  if (stat.isSymbolicLink()) {
    throw new Error('项目 tmp/ 是符号链接，拒绝写入');
  }

  if (!stat.isDirectory()) {
    throw new Error('项目 tmp 不是目录');
  }

  if (!isInsideOrEqual(root, realpathSync(tmp))) {
    throw new Error('项目 tmp/ 位于项目目录之外，拒绝写入');
  }

  return { tmp, created: false };
}

/** Read the direct `.md` files from a cloned `rules/` directory. */
function readClonedRules(destination, repo) {
  const rulesDir = path.join(destination, RULES_DIR);
  const stat = lstatOrNull(rulesDir);

  if (!stat) {
    throw new Error(`仓库 ${repo.label} 中没有 rules/ 目录`);
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`仓库 ${repo.label} 的 rules/ 是符号链接，拒绝读取`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`仓库 ${repo.label} 的 rules/ 不是目录`);
  }

  const files = [];

  for (const entry of readdirSync(rulesDir, { withFileTypes: true })) {
    if (!entry.name.toLowerCase().endsWith('.md')) continue;

    if (entry.isSymbolicLink()) {
      throw new Error(`规则文件是符号链接，拒绝读取: ${entry.name}`);
    }

    if (!entry.isFile()) {
      throw new Error(`规则路径不是普通文件: ${entry.name}`);
    }

    files.push({
      file: entry.name,
      content: readFileSync(path.join(rulesDir, entry.name), 'utf8'),
    });
  }

  if (files.length === 0) {
    throw new Error(`仓库 ${repo.label} 的 rules/ 目录下没有 .md 规则文件`);
  }

  return files;
}

// ── git clone ───────────────────────────────────────────────────────────────

/** Give git a bearer token without putting it in argv or the URL. */
function gitEnvironment(token, protocol) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  };

  if (protocol === 'ssh' && !env.GIT_SSH_COMMAND) {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  }

  if (!token || protocol !== 'https') return env;

  const current = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const index = Number.isInteger(current) && current >= 0 ? current : 0;

  env.GIT_CONFIG_COUNT = String(index + 1);
  env[`GIT_CONFIG_KEY_${index}`] = 'http.extraHeader';
  env[`GIT_CONFIG_VALUE_${index}`] =
    `Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString(
      'base64',
    )}`;

  return env;
}

/** Turn a git process failure into a sentence for the CLI. */
function cloneFailure(error, repo, action, timeoutMs) {
  if (error?.code === 'ENOENT') {
    return new Error('未找到 git 命令，请先安装 git 后重试');
  }

  if (error?.killed || error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT') {
    return new Error(`${action}超时（>${timeoutMs / 1000}s）`);
  }

  const text = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${
    error?.message ?? ''
  }`;
  const detail =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1)
      ?.replace(/^fatal:\s*/i, '') ?? '';

  if (/Repository not found|remote: Not Found|does not appear to be a git repository/i.test(text)) {
    return new Error(`仓库不存在或无权访问: ${repo.label}（${repo.url}）`);
  }

  if (
    /Authentication failed|could not read Username|terminal prompts disabled|Permission denied|not authorized|Invalid username or password/i.test(
      text,
    )
  ) {
    return new Error(
      `认证失败: ${repo.label}。私有仓库请设置 GITHUB_TOKEN 或配置 git 凭据`,
    );
  }

  if (/Remote branch .* not found|Could not find remote branch|branch .* not found/i.test(text)) {
    return new Error(`分支不存在: ${repo.label}（分支: ${repo.branch}）`);
  }

  if (
    /Could not resolve host|Failed to connect|Connection timed out|unable to access|Network is unreachable|Connection reset/i.test(
      text,
    )
  ) {
    return new Error(
      `无法连接 GitHub: ${repo.label}（${detail || '网络错误'}）`,
    );
  }

  return new Error(
    `${action}失败: ${repo.label}${detail ? `（${detail}）` : ''}`,
  );
}

/**
 * Shallow-clone one branch and sparse-checkout only `rules/`.
 *
 * @param {ReturnType<typeof parseSource>} repo parsed source
 * @param {string} destination empty directory created by fetchRules
 * @param {object} [options]
 * @param {string} [options.token] defaults to process.env.GITHUB_TOKEN
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.execFileImpl] injectable for tests
 */
export async function cloneRepository(
  repo,
  destination,
  {
    token = process.env.GITHUB_TOKEN,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    protocol = 'https',
    execFileImpl = execFileAsync,
  } = {},
) {
  const url =
    protocol === 'ssh'
      ? `ssh://git@github.com/${repo.owner}/${repo.repo}.git`
      : `https://github.com/${repo.owner}/${repo.repo}.git`;
  const options = {
    env: gitEnvironment(token, protocol),
    timeout: timeoutMs,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
  };

  try {
    await execFileImpl(
      'git',
      [
        'clone',
        '--depth',
        '1',
        '--branch',
        repo.branch,
        '--single-branch',
        '--filter=blob:none',
        '--sparse',
        '--no-tags',
        url,
        destination,
      ],
      options,
    );
  } catch (error) {
    throw cloneFailure(error, repo, '克隆仓库', timeoutMs);
  }

  try {
    await execFileImpl(
      'git',
      ['-C', destination, 'sparse-checkout', 'set', RULES_DIR],
      options,
    );
  } catch (error) {
    throw cloneFailure(error, repo, '检出 rules/', timeoutMs);
  }
}

// ── public fetch ────────────────────────────────────────────────────────────

/** Clone once with a protocol, then read the rules out of the temp checkout. */
async function cloneOnce(
  repo,
  protocol,
  { cwd, token, timeoutMs, cloneImpl },
) {
  const tmpState = prepareTmp(cwd);
  let destination;

  try {
    try {
      destination = mkdtempSync(path.join(tmpState.tmp, 'keeprules-'));
    } catch (error) {
      throw new Error(`无法创建临时克隆目录（${error.message}）`);
    }

    await cloneImpl(repo, destination, { token, timeoutMs, protocol });
    return loadRules(readClonedRules(destination, repo));
  } finally {
    if (destination) {
      try {
        rmSync(destination, { recursive: true, force: true });
      } catch {
        // A leftover temp clone is harmless; never mask the real result.
      }
    }

    if (tmpState.created) {
      try {
        rmdirSync(tmpState.tmp);
      } catch {
        // Kept only when something else already uses it.
      }
    }
  }
}

/** Try SSH clone first, then HTTPS clone. */
async function fetchViaClone(repo, options) {
  const failures = [];

  for (const protocol of ['ssh', 'https']) {
    try {
      return await cloneOnce(repo, protocol, options);
    } catch (error) {
      failures.push(error);
    }
  }

  throw new Error(
    `clone 回退失败（${failures.map((failure) => failure.message).join('；')}）`,
  );
}

/**
 * Fetch rules with a transport ladder: API raw, SSH clone, HTTPS clone.
 *
 * @param {object} [options]
 * @param {string} [options.source] `user/repo`, a GitHub URL, or `user/repo#branch`
 * @param {string} [options.cwd] target project (defaults to process.cwd())
 * @param {Function} [options.cloneImpl] injectable for tests
 * @param {typeof fetch} [options.fetchImpl] injectable for tests
 * @param {string} [options.token] defaults to process.env.GITHUB_TOKEN
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object[]>} rules, ready to install
 * @throws {Error} with a message suitable for showing the user
 */
export async function fetchRules({
  source = DEFAULT_SOURCE,
  cwd = process.cwd(),
  cloneImpl = cloneRepository,
  fetchImpl = globalThis.fetch,
  token = process.env.GITHUB_TOKEN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const repo = parseSource(source);
  let apiError;

  try {
    return await fetchViaApi(repo, { fetchImpl, token, timeoutMs });
  } catch (error) {
    apiError = error;
  }

  try {
    return await fetchViaClone(repo, {
      cwd,
      token,
      timeoutMs,
      cloneImpl,
    });
  } catch (cloneError) {
    throw new Error(`${apiError.message}；${cloneError.message}`);
  }
}
