# GLOSSARY

The domain language of keeprules. These names are load-bearing: use them in
code, tests, and conversation instead of inventing synonyms.

## Rule

One Markdown file in the package's `rules/` directory, describing behaviour a
Coding Agent must follow. A rule's metadata comes from a small YAML frontmatter
subset (`id`, `name`, `description`, `postInstall`); files without frontmatter
still work, falling back to the file name and first Markdown line.

Adding a rule means adding a file. Nothing else changes. This is the project's
best property and the template for everything else.

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
satisfied", `warn` for "skipped". A step returns its own level with its
sentence, so the install module never interprets a step's vocabulary.

## Install flow

The sequence a user experiences: pick rules, answer the opt-in questions,
confirm, install, report. It lives in `src/flow.js` and takes its prompts and printer as arguments, so
it runs without a terminal. It returns one result code: `installed`, `cancelled`, or
`failed`.

## Install

Copying rule files into a target project and then running the steps the
selection opted into. An install never overwrites an existing rule file.

## Outcome

The unit the install reports. One outcome per thing that happened: a rule
copied, a rule skipped, a step wrote a file. It carries exactly two fields —
`level` (`success` / `info` / `warn`) and
`message` — so reporting is a loop rather than a decision tree.

Two fields and no more, because a printer reads only those two. The caller never
needs to know a step's action vocabulary or which step produced a line.

## Failure

Something that prevented an install from completing: a missing rule file, a
name collision, a step that could not write. A failure carries `subject` (what
to name in the log) and `message`. A failure never stops the remaining rules
or steps from running.

## Skip

An existing rule file was left untouched. Because steps assert *project*
invariants rather than a rule's own contents, a skipped rule's steps still run.
The outcome is a `warn` and its message says so, so a skip can never be confused
with a failure.

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
