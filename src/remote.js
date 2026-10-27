/**
 * Rules come from a GitHub repository, not from the package.
 *
 * The repository's `rules/` directory is listed through the GitHub Contents
 * API (raw HTTP cannot list a directory), then every `.md` file is downloaded.
 * There is no manifest and no offline copy: adding a Markdown file to a
 * repository is enough, and an unreachable repository stops the install.
 */

import { loadRules } from './rules.js';

/** Where rules come from when the user does not name a repository. */
export const DEFAULT_SOURCE = 'fb0sh/keeprules';

/** The branch used when a source does not name one. */
export const DEFAULT_BRANCH = 'main';

/** The official repository page, for messages that need a human-legible URL. */
export const REPO_URL = `https://github.com/${DEFAULT_SOURCE}`;

const API_BASE = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';

/** How long any single request may take. */
const TIMEOUT_MS = 3000;

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
 * one optional ref. Anything else is rejected before a request is made.
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
    // A GitHub URL, but with a path shape we do not accept (for example
    // `github.com/user/repo/tree/main`). Point at the #branch form.
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

function trimSlash(base) {
  return base.replace(/\/+$/, '');
}

function contentsUrl(repo, apiBase) {
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.repo);

  return (
    `${trimSlash(apiBase)}/repos/${owner}/${name}/contents/rules` +
    `?ref=${encodeURIComponent(repo.branch)}`
  );
}

function repositoryApiUrl(repo, apiBase) {
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.repo);

  return `${trimSlash(apiBase)}/repos/${owner}/${name}`;
}

function rawFileUrl(repo, file, rawBase) {
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.repo);
  const ref = repo.branch.split('/').map(encodeURIComponent).join('/');

  return `${trimSlash(rawBase)}/${owner}/${name}/${ref}/rules/${encodeURIComponent(
    file,
  )}`;
}

function describe(error, timeoutMs) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return `连接超时（>${timeoutMs / 1000}s）`;
  }
  return error?.message ?? String(error);
}

/** Attach the token only to the GitHub hosts we actually call. */
function headersFor(url, token, apiBase, rawBase) {
  const headers = { 'User-Agent': 'keeprules' };

  if (url.startsWith(`${trimSlash(apiBase)}/`)) {
    headers.Accept = 'application/vnd.github+json';
    headers['X-GitHub-Api-Version'] = '2022-11-28';
  }

  if (
    token &&
    [apiBase, rawBase].some((base) => url.startsWith(`${trimSlash(base)}/`))
  ) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

/**
 * Fetch one URL as text, with a hard timeout.
 *
 * Non-2xx responses throw an error carrying `status` and `body`; refusing a
 * response is the caller's job, because only the caller knows which sentence
 * makes sense.
 */
async function requestText(
  url,
  { fetchImpl, timeoutMs, token, apiBase, rawBase },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: headersFor(url, token, apiBase, rawBase),
    });

    // The timer stays armed while the body streams: a server that never
    // finishes its response must time out too, not just a slow connect.
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

/** Pull the human-readable message out of a GitHub error body. */
function apiDetail(body) {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.message === 'string' ? parsed.message : '';
  } catch {
    return '';
  }
}

function httpReason(status, body = '') {
  const detail = apiDetail(body);

  if (status === 401) {
    return 'GITHUB_TOKEN 无效或已过期（HTTP 401）';
  }

  if (status === 403 || status === 429) {
    return (
      `GitHub API 速率限制或访问被拒绝（HTTP ${status}）` +
      `${detail ? `：${detail}` : ''}。设置 GITHUB_TOKEN 可提高限额`
    );
  }

  if (status >= 500) {
    return `GitHub 服务异常（HTTP ${status}）`;
  }

  return detail ? `HTTP ${status}（${detail}）` : `HTTP ${status}`;
}

/** Rule file names must stay a plain basename inside `rules/`. */
function assertRuleFileName(file, repo) {
  if (
    typeof file !== 'string' ||
    file === '' ||
    file === '.' ||
    file === '..' ||
    /[\\/\0]/.test(file)
  ) {
    throw new Error(
      `规则文件名不合法: ${JSON.stringify(file)}（${repo.label} 的 rules/ 目录）`,
    );
  }
}

/**
 * Does the repository exist? Called only after `contents/rules` returns 404,
 * because GitHub reports a missing repository and a missing path identically.
 *
 * @returns {Promise<boolean|null>} null when the probe itself was inconclusive
 */
async function repoExists(repo, context) {
  try {
    await requestText(repositoryApiUrl(repo, context.apiBase), context);
    return true;
  } catch (error) {
    return error.status === 404 ? false : null;
  }
}

/** List the direct `.md` file entries in the repository's `rules/` directory. */
async function listRuleEntries(repo, context) {
  const url = contentsUrl(repo, context.apiBase);

  let body;

  try {
    body = await requestText(url, context);
  } catch (error) {
    if (error.status === 404) {
      const exists = await repoExists(repo, context);

      if (exists === false) {
        throw new Error(`仓库不存在或无权访问: ${repo.label}（${repo.url}）`);
      }

      if (exists === true) {
        throw new Error(`仓库 ${repo.label} 中没有 rules/ 目录（${repo.url}）`);
      }

      throw new Error(
        `无法访问 ${repo.label} 的 rules/ 目录（HTTP 404）：` +
          '仓库不存在、私有仓库无权限，或没有 rules/ 目录',
      );
    }

    if (error.status) {
      throw new Error(
        `无法读取 ${repo.label} 的 rules/ 目录（${httpReason(
          error.status,
          error.body,
        )}）`,
      );
    }

    throw new Error(
      `无法访问 ${repo.label} 的 rules/ 目录（${error.message}）`,
    );
  }

  let entries;

  try {
    entries = JSON.parse(body);
  } catch {
    throw new Error(
      `GitHub API 返回的 rules/ 目录内容不是合法 JSON（${repo.label}）`,
    );
  }

  if (!Array.isArray(entries)) {
    throw new Error(
      `${repo.label} 的 rules 不是目录（GitHub Contents API 没有返回文件列表）`,
    );
  }

  return entries
    .filter(
      (item) =>
        item?.type === 'file' &&
        typeof item.name === 'string' &&
        item.name.toLowerCase().endsWith('.md'),
    )
    .sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1))
    .map((item) => {
      assertRuleFileName(item.name, repo);
      return item;
    });
}

/**
 * Fetch and parse the rules from a repository's `rules/` directory.
 *
 * @param {object} [options]
 * @param {string} [options.source] `user/repo`, a GitHub URL, or `user/repo#branch`
 * @param {typeof fetch} [options.fetchImpl] injectable for tests
 * @param {string} [options.apiBase] injectable for tests
 * @param {string} [options.rawBase] injectable for tests
 * @param {number} [options.timeoutMs] injectable for tests
 * @param {string} [options.token] defaults to process.env.GITHUB_TOKEN
 * @returns {Promise<object[]>} rules, ready to install
 * @throws {Error} with a message suitable for showing the user
 */
export async function fetchRules({
  source = DEFAULT_SOURCE,
  fetchImpl = globalThis.fetch,
  apiBase = API_BASE,
  rawBase = RAW_BASE,
  timeoutMs = TIMEOUT_MS,
  token = process.env.GITHUB_TOKEN,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前 Node 没有 fetch，需要 Node 18 或更高版本');
  }

  const repo = parseSource(source);
  const context = { fetchImpl, timeoutMs, token, apiBase, rawBase };

  const entries = await listRuleEntries(repo, context);

  if (entries.length === 0) {
    throw new Error(
      `${repo.label} 的 rules/ 目录下没有 .md 规则文件（${repo.url}）`,
    );
  }

  const contents = await Promise.all(
    entries.map(async (item) => {
      const url =
        typeof item.download_url === 'string' && item.download_url !== ''
          ? item.download_url
          : rawFileUrl(repo, item.name, rawBase);

      try {
        return { file: item.name, content: await requestText(url, context) };
      } catch (error) {
        const reason = error.status
          ? httpReason(error.status, error.body)
          : error.message;

        throw new Error(`无法读取 ${item.name}（${reason}）`);
      }
    }),
  );

  return loadRules(contents);
}
