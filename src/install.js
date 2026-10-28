/**
 * Install: replace the selected rules in the project with the fetched content,
 * then run the project-level steps those rules declare.
 *
 * This is the whole write policy in one place — remote always wins, validation
 * runs before any write, replacement is atomic, and symlinked paths are
 * refused. It also owns where rules land, how the `.gitignore` and `AGENTS.md`
 * blocks are written, and what gets reported. There are exactly two steps, so
 * they are two functions, not a plugin system.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Rules are copied into a dedicated directory, not the project root. */
export const RULES_DIR = 'rules';

/** Project-relative destination for a rule file, e.g. `rules/KEEPTIDY.md`. */
export function ruleTargetPath(rule) {
  return path.posix.join(RULES_DIR, rule.file);
}

// ── file helpers ────────────────────────────────────────────────────────────

/**
 * Read a project file, refusing symlinks and non-regular targets before the
 * read can follow them outside the project.
 */
function open(root, name) {
  const filePath = path.join(root, name);
  const stat = assertSafeFileTarget(root, filePath);
  const content = stat ? readFileSync(filePath, 'utf8') : '';
  const eol = content.includes('\r\n') ? '\r\n' : '\n';

  return {
    path: filePath,
    exists: Boolean(stat),
    content,
    eol,
    mode: stat ? stat.mode & 0o777 : 0o666,
    /** Render `text` (which uses \n) in this file's convention. */
    render: (text) => text.split('\n').join(eol),
  };
}

/** Append rendered text, keeping the file's existing blank-line style. */
function appendText(file, text) {
  const block = file.render(text) + file.eol;

  let separator = '';
  if (file.content.length > 0) {
    if (file.content.endsWith(`${file.eol}${file.eol}`)) separator = '';
    else if (file.content.endsWith('\n')) separator = file.eol;
    else separator = `${file.eol}${file.eol}`;
  }

  return file.content + separator + block;
}

// ── step: .gitignore ────────────────────────────────────────────────────────

const GITIGNORE_BLOCK = ['# keeprules: 临时目录', '/tmp/'];

/** Does this ignore file already cover the project `tmp/` directory? */
function hasTmpEntry(content) {
  return content.split(/\r?\n/).some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) return false;

    return line.replace(/^\/+/, '').replace(/\/+$/, '') === 'tmp';
  });
}

function addTmpIgnore(cwd) {
  const root = realpathSync(cwd);
  const file = open(root, '.gitignore');

  if (hasTmpEntry(file.content)) {
    return { level: 'info', message: '.gitignore 已包含 /tmp/ 规则，无需修改' };
  }

  const next = appendText(file, GITIGNORE_BLOCK.join('\n'));
  writeFileSafely(root, file, next);

  return {
    level: 'success',
    message: file.exists
      ? '已向 .gitignore 补充 /tmp/ 规则'
      : '已创建 .gitignore 并添加 /tmp/ 规则',
  };
}

// ── step: AGENTS.md reference block ─────────────────────────────────────────

const AGENTS_START = '<!-- keeprules:start -->';
const AGENTS_END = '<!-- keeprules:end -->';
const AGENTS_FOOTER =
  'These rules are mandatory for all Coding Agents working in this repository.';

// ── notes a rule may inject into its section ────────────────────────────────

/**
 * A rule may declare extra constraints for `AGENTS.md` inside a marked region
 * of its Markdown body:
 *
 *   <!-- keeprules:agents -->
 *   ### Issue capture
 *   - Refine and clarify the user's description.
 *   <!-- /keeprules:agents -->
 *
 * The heading and link stay the installer's; the region only adds lines under
 * them. Level-1 and level-2 headings are refused because `splitSections` splits
 * the block on `##`: an injected one would survive as a separate section on
 * every later run. The size limits keep a bad third-party rule from bloating
 * `AGENTS.md`.
 */
const NOTES_OPEN = '<!-- keeprules:agents -->';
const NOTES_CLOSE = '<!-- /keeprules:agents -->';
const NOTES_MAX_LINES = 40;
const NOTES_MAX_CHARS = 2000;

/** Marker comparison ignores spacing, so `<!--keeprules:agents-->` counts too. */
const compact = (line) => line.replace(/\s+/g, '');

/**
 * The lines a rule injects into its `AGENTS.md` section.
 *
 * @param {string} content the rule's Markdown
 * @param {string} source what to name in an error, e.g. `规则 KEEPTRACK.md`
 * @returns {string[]} validated lines, empty when the rule declares no region
 * @throws {Error} when the region is malformed, unsafe, or too large
 */
export function agentsNotes(content, source) {
  const notes = [];
  let open = false;
  let regions = 0;

  for (const raw of String(content ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const key = compact(line);

    if (key === compact(NOTES_OPEN)) {
      if (open) throw new Error(`${source}: 标记区不能嵌套`);
      if (regions > 0) throw new Error(`${source}: 只能有一个标记区（${NOTES_OPEN}）`);
      open = true;
      regions += 1;
      continue;
    }

    if (key === compact(NOTES_CLOSE)) {
      if (!open) throw new Error(`${source}: 结束标记 ${NOTES_CLOSE} 缺少对应的开始标记`);
      open = false;
      continue;
    }

    if (open) notes.push(line);
  }

  if (open) throw new Error(`${source}: 标记区缺少结束标记 ${NOTES_CLOSE}`);

  while (notes.length > 0 && notes[0] === '') notes.shift();
  while (notes.length > 0 && notes[notes.length - 1] === '') notes.pop();

  if (notes.length === 0) return [];

  for (const note of notes) {
    if (/^#{1,2}(?:\s|$)/.test(note)) {
      throw new Error(
        `${source}: 标记区不能包含一级或二级标题（"${note}"）；请改用 ###`,
      );
    }

    if (compact(note).includes('keeprules:')) {
      throw new Error(
        `${source}: 标记区不能包含 keeprules 的块标记（"${note}"）`,
      );
    }
  }

  if (notes.length > NOTES_MAX_LINES) {
    throw new Error(
      `${source}: 标记区最多 ${NOTES_MAX_LINES} 行，实际 ${notes.length} 行`,
    );
  }

  const size = notes.join('\n').length;

  if (size > NOTES_MAX_CHARS) {
    throw new Error(
      `${source}: 标记区最多 ${NOTES_MAX_CHARS} 字符，实际 ${size} 字符`,
    );
  }

  return notes;
}

/** One `## NAME` section pointing at the installed rule file. */
function renderSection(rule) {
  const target = ruleTargetPath(rule);
  const notes = agentsNotes(rule.content, `规则 ${rule.file}`);
  const lines = [
    `## ${rule.name}`,
    '',
    `Follow the ${rule.name} rules defined in [${target}](./${target}).`,
  ];

  if (notes.length > 0) lines.push('', ...notes);

  return lines.join('\n');
}

/** The whole marked block, for these rules plus any preserved sections. */
function renderBlock(rules, preserved = []) {
  const sections = [...rules.map(renderSection), ...preserved];

  return [
    AGENTS_START,
    ...sections.flatMap((section, index) =>
      index === 0 ? [section] : ['', section],
    ),
    '',
    AGENTS_FOOTER,
    AGENTS_END,
  ].join('\n');
}

/** Split an existing block body back into its `## NAME` sections. */
function splitSections(body) {
  const sections = [];
  let current = [];

  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === AGENTS_FOOTER) continue;

    if (/^##\s+/.test(line)) {
      if (current.length > 0) sections.push(current.join('\n').trim());
      current = [line];
      continue;
    }

    current.push(line);
  }

  const tail = current.join('\n').trim();
  if (tail) sections.push(tail);

  return sections
    .map((text) => ({
      name: /^##\s+(.+)$/m.exec(text)?.[1].trim() ?? '',
      text,
    }))
    .filter((section) => section.name);
}

/**
 * Correct a root-level rule link (`[X.md](./X.md)`) written by keeprules 0.1.1,
 * which copied rules into the project root.
 */
function normalizeLinks(section) {
  return section.replace(
    /\[([^\]/]+\.md)\]\((?:(\.\/))?([^/)]+\.md)\)/g,
    (match, label, _dot, target) =>
      label === target
        ? `[${RULES_DIR}/${target}](./${RULES_DIR}/${target})`
        : match,
  );
}

function addAgentReferences(rules, cwd) {
  if (rules.length === 0) {
    return {
      level: 'info',
      message: '没有成功安装的规则可引用，已跳过 AGENTS.md',
    };
  }

  const root = realpathSync(cwd);
  const file = open(root, 'AGENTS.md');
  const start = file.content.indexOf(AGENTS_START);
  const end = file.content.indexOf(AGENTS_END);

  // No block yet: append one.
  if (start === -1 || end === -1 || end < start) {
    if (file.content.includes(AGENTS_START)) {
      return { level: 'info', message: 'AGENTS.md 中已存在 keeprules 引用，无需修改' };
    }

    const next = appendText(file, renderBlock(rules));
    writeFileSafely(root, file, next);

    return {
      level: 'success',
      message: file.exists
        ? '已向 AGENTS.md 追加规则引用'
        : '已创建 AGENTS.md 并添加规则引用',
    };
  }

  // Rewrite the block in place, keeping rules an earlier run referenced.
  const selected = new Set(rules.map((rule) => rule.name));
  const preserved = splitSections(
    file.content.slice(start + AGENTS_START.length, end),
  )
    .filter((section) => !selected.has(section.name))
    .map((section) => normalizeLinks(section.text));

  const rendered = file.render(renderBlock(rules, preserved));
  const next =
    file.content.slice(0, start) +
    rendered +
    file.content.slice(end + AGENTS_END.length);

  if (next === file.content) {
    return { level: 'info', message: 'AGENTS.md 中已存在 keeprules 引用，无需修改' };
  }

  writeFileSafely(root, file, next);
  return { level: 'success', message: '已更新 AGENTS.md 中的规则引用' };
}

// ── steps registry ──────────────────────────────────────────────────────────

/**
 * The project-level steps an install can perform, keyed by the name a rule
 * writes in its `postInstall` list.
 *
 * `automatic` steps run whenever a selected rule declares them; a step with a
 * `prompt` runs only after the user agrees.
 */
const STEPS = {
  gitignore: { automatic: true, run: (_rules, cwd) => addTmpIgnore(cwd) },
  agents: {
    prompt: '是否在 AGENTS.md 中添加引用？',
    declined: '已跳过 AGENTS.md 引用',
    run: (rules, cwd) => addAgentReferences(rules, cwd),
  },
};

/** Reject a `postInstall` name no step implements. */
export function assertKnownSteps(names, source) {
  for (const name of names) {
    if (!Object.hasOwn(STEPS, name)) {
      throw new Error(
        `${source} 包含不支持的 postInstall 步骤: "${name}"。支持: ${Object.keys(
          STEPS,
        ).join(', ')}`,
      );
    }
  }
}

/** The steps these rules declare, in registry order. */
function declaredBy(rules) {
  return Object.entries(STEPS)
    .filter(([name]) => rules.some((rule) => rule.postInstall?.includes(name)))
    .map(([name, step]) => ({ name, ...step }));
}

/** The opt-in steps to ask the user about, for this selection. */
export function promptSteps(rules) {
  return declaredBy(rules)
    .filter((step) => step.prompt)
    .map(({ name, prompt, declined }) => ({ name, prompt, declined }));
}

// ── install ─────────────────────────────────────────────────────────────────

/** Fail two rules that would write the same file on a case-insensitive disk. */
function claimTargets(rules) {
  const claimed = new Map();
  const installable = [];
  const failures = [];

  for (const rule of rules) {
    const target = ruleTargetPath(rule);
    const owner = claimed.get(target.toLowerCase());

    if (owner) {
      failures.push({
        subject: rule.name,
        message:
          `目标文件冲突: "${ruleTargetPath(owner)}" 与 "${target}" ` +
          '在大小写不敏感的文件系统上是同一个文件，请重命名其中一个规则。',
      });
      continue;
    }

    claimed.set(target.toLowerCase(), rule);
    installable.push(rule);
  }

  return { installable, failures };
}

// ── preflight ───────────────────────────────────────────────────────────────

/** `lstat`, or null when the path does not exist. */
function lstatOrNull(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** Is `candidate` strictly below `root`? Both must be absolute. */
function isInside(root, candidate) {
  const relative = path.relative(root, candidate);

  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Is `candidate` `root` itself or below it? Both must be absolute. */
function isInsideOrEqual(root, candidate) {
  if (candidate === root) return true;

  return isInside(root, candidate);
}

const WINDOWS_RESERVED =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** A rule file name is a plain basename; it may not choose another path. */
function assertSafeRuleFile(file) {
  if (
    typeof file !== 'string' ||
    file === '' ||
    file === '.' ||
    file === '..' ||
    /[\\/\x00-\x1F<>:"|?*]/.test(file) ||
    WINDOWS_RESERVED.test(file) ||
    !file.toLowerCase().endsWith('.md')
  ) {
    throw new Error(`规则文件名不合法: ${JSON.stringify(file)}`);
  }
}

/**
 * Validate a file target before reading or replacing it: the target and its
 * parent must stay inside the project, and neither may be a symlink.
 *
 * @returns {import('node:fs').Stats|null} the target's lstat, or null if absent
 */
function assertSafeFileTarget(root, target) {
  const relative = path.relative(root, target);

  if (!isInside(root, target)) {
    throw new Error(`目标路径越界: ${relative}`);
  }

  const parent = path.dirname(target);
  const parentStat = lstatOrNull(parent);

  if (!parentStat) {
    throw new Error(`目标目录不存在: ${relative}`);
  }

  if (parentStat.isSymbolicLink()) {
    throw new Error(`目标父目录是符号链接，拒绝写入: ${relative}`);
  }

  if (!parentStat.isDirectory()) {
    throw new Error(`目标父路径不是目录: ${relative}`);
  }

  if (!isInsideOrEqual(root, realpathSync(parent))) {
    throw new Error(`目标父目录位于项目目录之外，拒绝写入: ${relative}`);
  }

  const stat = lstatOrNull(target);

  if (stat?.isSymbolicLink()) {
    throw new Error(`目标文件是符号链接，拒绝写入: ${relative}`);
  }

  if (stat && !stat.isFile()) {
    throw new Error(`目标路径不是普通文件: ${relative}`);
  }

  return stat;
}

/** Refuse a `rules/` path that is a file or a symlink, and verify its real path. */
function assertRulesDirectory(root, rulesDir) {
  const stat = lstatOrNull(rulesDir);

  if (!stat) return null;

  if (stat.isSymbolicLink()) {
    throw new Error(`${RULES_DIR}/ 是符号链接，拒绝写入（请改为普通目录）`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`${RULES_DIR}/ 不是目录`);
  }

  if (!isInside(root, realpathSync(rulesDir))) {
    throw new Error(`${RULES_DIR}/ 解析后位于项目目录之外，拒绝写入`);
  }

  return stat;
}

/** Validate every selected rule's payload, step names, and file name. */
function validateRules(rules) {
  const valid = [];
  const failures = [];

  for (const rule of rules) {
    try {
      assertSafeRuleFile(rule?.file);
      assertKnownSteps(rule.postInstall ?? [], `规则 ${rule.file}`);

      if (typeof rule.content !== 'string') {
        throw new Error(`规则内容缺失: ${rule.file}`);
      }

      if (rule.content.trim() === '') {
        throw new Error(`规则内容为空: ${rule.file}`);
      }

      // A malformed region must fail before the first write, not while the
      // block is being rendered into AGENTS.md.
      agentsNotes(rule.content, `规则 ${rule.file}`);

      valid.push(rule);
    } catch (error) {
      failures.push({
        subject: rule?.name ?? rule?.file ?? '规则',
        message: error.message,
      });
    }
  }

  return { valid, failures };
}

/**
 * Inspect every target after the payloads are validated. Any failure returns no
 * plans, so the caller can preserve every local rule file.
 */
function planTargets(rules, cwd) {
  let root;

  try {
    root = realpathSync(cwd);
  } catch (error) {
    return {
      plans: [],
      failures: [
        {
          subject: RULES_DIR,
          message: `无法解析安装目录（${error.message}）`,
        },
      ],
    };
  }

  const rulesDir = path.join(root, RULES_DIR);
  let dirStat;

  try {
    dirStat = assertRulesDirectory(root, rulesDir);
  } catch (error) {
    return {
      plans: [],
      failures: [{ subject: RULES_DIR, message: error.message }],
    };
  }

  const plans = [];
  const failures = [];

  for (const rule of rules) {
    const relative = ruleTargetPath(rule);
    const target = path.join(rulesDir, rule.file);

    try {
      let status = 'new';
      let mode = 0o666;

      if (dirStat) {
        const stat = assertSafeFileTarget(root, target);

        if (stat) {
          let current;

          try {
            current = readFileSync(target, 'utf8');
          } catch (error) {
            throw new Error(`无法读取现有规则 ${relative}（${error.message}）`);
          }

          status = current === rule.content ? 'unchanged' : 'updated';
          mode = stat.mode & 0o777;
        }
      }

      plans.push({ rule, target, status, mode });
    } catch (error) {
      failures.push({ subject: rule.name, message: error.message });
    }
  }

  if (failures.length > 0) return { plans: [], failures };

  return { plans, failures, root, rulesDir, dirExists: dirStat !== null };
}

// ── atomic write ────────────────────────────────────────────────────────────

let tempSerial = 0;

/**
 * Stage content in `directory` and rename it over the target. The temp file
 * stays in the authorized directory and is removed if anything fails.
 */
function writeAtomically(target, content, directory, mode) {
  const temp = path.join(
    directory,
    `.keeprules-${process.pid}-${Date.now()}-${++tempSerial}.tmp`,
  );

  try {
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx', mode });
    renameSync(temp, target);
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // The target is already safe; a leftover temp file is the only residue.
    }
  }
}

/**
 * Atomically replace a project file (AGENTS.md, .gitignore), preserving its
 * mode and skipping an identical payload.
 *
 * @returns {boolean} true when the disk was written
 */
function writeFileSafely(root, file, content) {
  const stat = assertSafeFileTarget(root, file.path);

  if (stat) {
    const current = readFileSync(file.path, 'utf8');

    if (current === content) return false;
  }

  writeAtomically(
    file.path,
    content,
    path.dirname(file.path),
    stat ? stat.mode & 0o777 : file.mode,
  );

  return true;
}

/** Write one planned rule and describe what happened. */
function installRule(plan, root, rulesDir) {
  const { rule, target, status } = plan;
  const relative = ruleTargetPath(rule);

  if (status === 'unchanged') {
    return {
      level: 'info',
      message: `${rule.name} → ${relative} 已是最新`,
    };
  }

  // Re-check immediately before writing: a symlinked directory or target that
  // appeared since planning must not redirect the write.
  const stat = assertSafeFileTarget(root, target);

  try {
    writeAtomically(
      target,
      rule.content,
      rulesDir,
      stat ? stat.mode & 0o777 : plan.mode,
    );
  } catch (error) {
    throw new Error(`无法写入 ${relative}（${error.message}）；本地文件未改动`);
  }

  return {
    level: 'success',
    message:
      `${rule.name} → ${relative} ` +
      (status === 'new' ? '已安装' : '已更新（远程覆盖）'),
  };
}

/**
 * Install the selected rules, then run the steps they declare.
 *
 * Policy:
 * - Remote always wins: a selected rule always ends up with the fetched
 *   content. An existing file is replaced, not skipped.
 * - Every selected rule is validated before any file is written. A bad
 *   payload, step name, target, or symlink aborts the whole batch with local
 *   files untouched.
 * - Writes use a temp file in `rules/` and an atomic rename; a failed write
 *   keeps the old target and cleans the temp file.
 * - Steps run for every *selected* rule that declares them, even when its file
 *   was already current — they assert project invariants, not the rule's
 *   contents.
 * - `confirmed` names the opt-in steps the user agreed to; a step that was not
 *   confirmed never runs.
 * - One write failure never stops the other rules.
 *
 * @param {object} options
 * @param {object[]} options.rules selected rules
 * @param {string} options.cwd target project
 * @param {string[]} [options.confirmed] opt-in step names the user accepted
 * @returns {{outcomes: {level: string, message: string}[], failures: {subject: string, message: string}[]}}
 */
export function installSelection({ rules, cwd, confirmed = [] }) {
  assertKnownSteps(confirmed, `选项 ${confirmed.join(', ')}`);

  // Payloads first: an invalid rule must not even reach target planning, and a
  // bad file name must not be handed to path helpers.
  const basics = validateRules(rules);

  if (basics.failures.length > 0) {
    return { outcomes: [], failures: basics.failures };
  }

  const claim = claimTargets(basics.valid);

  if (claim.failures.length > 0) {
    return { outcomes: [], failures: claim.failures };
  }

  const preflight = planTargets(claim.installable, cwd);

  if (preflight.failures.length > 0) {
    return { outcomes: [], failures: preflight.failures };
  }

  const outcomes = [];
  const failures = [];

  // Create rules/ only after every selected rule passed validation.
  if (!preflight.dirExists && preflight.plans.length > 0) {
    try {
      mkdirSync(preflight.rulesDir);
    } catch (error) {
      return {
        outcomes,
        failures: [
          {
            subject: RULES_DIR,
            message: `无法创建 ${RULES_DIR}/（${error.message}）`,
          },
        ],
      };
    }
  }

  const installed = [];

  for (const plan of preflight.plans) {
    try {
      outcomes.push(installRule(plan, preflight.root, preflight.rulesDir));
      installed.push(plan.rule);
    } catch (error) {
      failures.push({ subject: plan.rule.name, message: error.message });
    }
  }

  for (const step of declaredBy(rules)) {
    const enabled = step.automatic || confirmed.includes(step.name);
    if (!enabled) continue;

    try {
      outcomes.push(step.run(installed, cwd));
    } catch (error) {
      failures.push({ subject: step.name, message: error.message });
    }
  }

  return { outcomes, failures };
}
