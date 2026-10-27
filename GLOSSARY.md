# GLOSSARY

The domain language of keeprules. These names are load-bearing: use them in
code, tests, and conversation instead of inventing synonyms.

## Rule

One Markdown file in the repository's `rules/` directory, describing behaviour a
Coding Agent must follow. A rule's metadata comes from a small YAML frontmatter
subset (`id`, `name`, `description`, `postInstall`); files without frontmatter
still work, falling back to the file name and first Markdown line.

Adding a rule means adding one file under `rules/`. Nothing else changes, and
no release is needed: rules are fetched at install time.

## Rule source

A GitHub repository with a `rules/` directory. The official repository
(`fb0sh/keeprules`) is used when the user names no source; `add user/repo`,
`add https://github.com/user/repo`, and `add user/repo#branch` select any other
repository and ref. The default ref is `main`.

The npm package ships no rules, so an install always reflects the repository as
it is right now — and an install with no network fails rather than silently
using an older set.

The Contents API lists `rules/` (HTTP cannot list a directory over raw
downloads); there is no manifest. A third-party repository is valid as soon as
its `rules/` contains a `.md` file, and `GITHUB_TOKEN` can be supplied for rate
limits and private repositories.

## Rule file

The copy of a rule that lands in the target project at `rules/<file>`. The
destination is always posix so the link written into `AGENTS.md` works in
Markdown regardless of host platform.

## Step

A project-level side effect that an install performs once, no matter how many
rules ask for it. The two steps — `.gitignore` and the `AGENTS.md` reference
block — live in `src/install.js`, keyed by the name a rule writes in
`postInstall`.

A step declares its whole self:

- **automatic** — runs whenever a selected rule declares it (`gitignore`)
- **opt-in** — runs only after the user agrees, and supplies its own `prompt`
  and `declined` note (`agents`)

A step owns its own file format and its own sentences. Nothing outside it knows
how its file is laid out.

## Level

How loudly an outcome is reported: `success` for a write, `info` for "already
current", `warn` for a non-fatal warning. A step returns its own level with its
sentence, so the install module never interprets a step's vocabulary.

## Install flow

The sequence a user experiences: pick rules, answer the opt-in questions,
confirm, install, report. It lives in `src/flow.js` and takes its prompts and printer as arguments, so
it runs without a terminal. It returns one result code: `installed`, `cancelled`, or
`failed`.

## Remote always wins

The install policy: every selected rule ends up with the content fetched in this
run. Local edits, older versions, and an existing file do not block the write;
the only exception is identical content, which is not rewritten. There is no
merge, version comparison, or update confirmation.

## Install

Copying the fetched rule files into a target project and then running the steps
the selection opted into. All selected payloads are validated before the first
write. Each changed or new rule is staged to a temp file inside `rules/` and
atomically renamed over the target, so a failed write leaves the old file in
place. `AGENTS.md` and `.gitignore` use the same atomic replace, preserve their
existing BOM and line endings, and are not rewritten when their content is
already current.

## Outcome

The unit the install reports. One outcome per thing that happened: a rule
created, a rule overwritten, a rule already current, a step wrote a file. It
carries exactly two fields — `level` (`success` / `info` / `warn`) and
`message` — so reporting is a loop rather than a decision tree.

Two fields and no more, because a printer reads only those two. The caller never
needs to know a step's action vocabulary or which step produced a line.

## Failure

Something that prevented an install from completing: missing or empty content,
an unknown step, an unsafe target, a symlink, or a write that could not
complete. A failure carries `subject` (what to name in the log) and `message`.
A validation failure stops the whole batch before any file write; a write
failure never stops the remaining rules or steps.

## Unchanged

A selected rule whose local content already equals the fetched content. Its file
is not rewritten, so the run stays idempotent. Because steps assert *project*
invariants rather than a rule's own contents, an unchanged rule's steps still
run. The outcome is `info` with the message `已是最新`.

## Install target

The directory the user runs the CLI from. Rules land in `<target>/rules/`,
never in `<target>` itself.

## Reference block

The marked region in `AGENTS.md` (`<!-- keeprules:start -->` /
`<!-- keeprules:end -->`) listing the installed rules. It is rewritten in
place on every run: rules referenced by an earlier run are preserved, and
root-level links written by keeprules 0.1.1 are corrected to `rules/<file>`.

## Prompt outcome

Every interactive question ends one of three ways, and the seam normalizes the
answer, not just the sentinel:

- **cancel** — the user aborted; nothing should happen
- **declined** — the user answered no; the flow continues without the step
- **answered** — the user's value, already unwrapped
