/**
 * Rules come from the repository, not from the package.
 *
 * A manifest (`rules/index.json`) says which rule files exist, because HTTP
 * cannot list a directory; then each file is fetched. There is no offline copy
 * and no fallback: if the repository cannot be reached, the install stops and
 * says so.
 */

import { loadRules } from './rules.js';

/** Where the rule files live. Branch is `main` on purpose: rules ship faster than releases. */
const BASE = 'https://raw.githubusercontent.com/fb0sh/keeprules/main/rules/';

/** How long any single request may take. */
const TIMEOUT_MS = 3000;

function describe(error, timeoutMs) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return `连接超时（>${timeoutMs / 1000}s）`;
  }
  return error?.message ?? String(error);
}

/** Fetch one URL as text, with a hard timeout. */
async function getText(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Rule file names are plain file names; refuse anything that could escape. */
function assertSafeFileName(file) {
  if (typeof file !== 'string' || !/^[A-Za-z0-9._-]+\.md$/.test(file)) {
    throw new Error(`index.json 中的文件名不合法: ${JSON.stringify(file)}`);
  }
}

/**
 * Fetch the current rules from the repository.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] injectable for tests
 * @param {string} [options.base] injectable for tests
 * @param {number} [options.timeoutMs] injectable for tests
 * @returns {Promise<object[]>} rules, ready to install
 * @throws {Error} with a message suitable for showing the user
 */
export async function fetchRules({
  fetchImpl = globalThis.fetch,
  base = BASE,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前 Node 没有 fetch，需要 Node 18 或更高版本');
  }

  let manifest;

  try {
    manifest = JSON.parse(await getText(`${base}index.json`, fetchImpl, timeoutMs));
  } catch (error) {
    const reason =
      error instanceof SyntaxError
        ? '内容不是合法 JSON'
        : describe(error, timeoutMs);
    throw new Error(`无法读取规则清单（${reason}）`);
  }

  const files = manifest?.files;

  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('规则清单格式不正确：缺少 files 列表');
  }

  files.forEach(assertSafeFileName);

  const contents = await Promise.all(
    files.map(async (file) => {
      try {
        return {
          file,
          content: await getText(`${base}${file}`, fetchImpl, timeoutMs),
        };
      } catch (error) {
        throw new Error(`无法读取 ${file}（${describe(error, timeoutMs)}）`);
      }
    }),
  );

  return loadRules(contents);
}

/** The manifest URL, for error messages. */
export const MANIFEST_URL = `${BASE}index.json`;

/** The repository page, for messages that need a human-legible URL. */
export const REPO_URL = 'https://github.com/fb0sh/keeprules';
