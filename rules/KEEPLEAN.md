---
id: keeplean
name: KEEPLEAN
description: Coding Agent minimal-change rules (assumptions surfaced before coding, necessity assessment, reuse first, smallest correct change, surgical edits, goal-driven verification)
postInstall:
  - agents
---

# KEEPLEAN — Minimal-Change Engineering Rules

Applies to Coding Agents working in the current project and any Subagents they delegate work to.

**Core principle: surface assumptions before coding, implement only what the current task requires, reuse proven solutions first, and deliver verifiable results through the smallest maintainable change.**

**MUST** indicates a mandatory requirement; **MUST NOT** indicates a prohibition; **SHOULD** indicates the default behavior, which may be adjusted for a justified reason.

## 1. Decision Process Before Implementation

### 1.1 Surface assumptions first

**MUST** resolve ambiguity with the user before writing code, because a silently chosen interpretation is the most expensive kind of rework.

- **MUST** state the assumptions the implementation depends on. If uncertain, ask.
- **MUST** present the interpretations you see when more than one is plausible; **MUST NOT** pick one silently.
- **MUST** say so when a simpler approach exists, and push back on the request when the tradeoff warrants it.
- **MUST** stop and name the specific confusion when the requirement is unclear, rather than guessing and proceeding.
- **SHOULD** keep this brief. For a small, well-specified change one or two sentences suffice; a standalone analysis document is not required and is usually counterproductive.

### 1.2 Then evaluate what to build

Before adding code, dependencies, abstractions, or configuration, **MUST** evaluate the following in order:

1. **Necessity:** Does the current task actually require this capability? If not, skip it; otherwise, continue.
2. **Project reuse:** Can existing functions, components, services, tools, or conventions reasonably meet the requirement? If so, reuse them first.
3. **Platform reuse:** Can the language standard library, runtime, or platform-native capabilities reasonably meet the requirement? If so, prefer them.
4. **Dependency reuse:** Can an existing installed dependency reasonably meet the requirement? If so, prefer it.
5. **Necessary additions:** If the preceding options are insufficient, choose the smallest reasonable solution between a custom implementation and a mature dependency, considering security, correctness, complexity, and maintenance cost.

- **MUST** conclude this decision process only after identifying an approach that satisfies functional, correctness, security, and maintainability requirements.
- **MUST NOT** add abstraction layers, extension points, plugin systems, or configuration options prematurely merely because they "might be useful later."
- **MUST NOT** build features beyond what was asked, and **MUST NOT** add "flexibility" or configurability that was not requested.

## 2. Change Scope and the Smallest Maintainable Implementation

- **MUST** limit changes to the reasonable scope of the current task and necessary supporting work.
- **MUST** follow the project's existing architecture, interfaces, dependency management, and code style, including formatting and naming, even where you would have chosen differently.
- **MUST NOT** undertake unrelated refactoring, repository-wide formatting, bulk renaming, or major dependency upgrades without authorization.
- **MUST NOT** "improve" adjacent code, comments, or formatting as a side effect of an unrelated task.
- **MUST** update necessary callers, compatibility constraints, tests, and documentation when changing public interfaces.
- **MUST** be able to trace every changed line directly to the user's request; **MUST** revert any line that cannot be traced.
- **MUST** remove imports, variables, and functions that your own changes made unused.
- **MUST NOT** delete pre-existing dead code unless asked; mention it instead.
- **SHOULD** favor implementations with fewer concepts that are easy to understand, verify, and maintain.
- **SHOULD** record issues discovered outside the task as follow-up items rather than expanding the scope opportunistically.
- **SHOULD** apply a size check to your own output: if the implementation is far longer than the problem requires, rewrite it smaller before delivering.
- If a minimal local change would materially compromise correctness, consistency, or future maintainability, **MUST** implement the necessary complete supporting changes and explain their scope of impact.

## 3. Reuse and Dependency Selection

- **MUST** check existing implementations, standard libraries, and installed dependencies first.
- **MUST NOT** introduce a new production dependency for a small amount of code without a clear benefit.
- **MUST** prioritize evaluation of mature, actively maintained implementations or libraries suitable for the project in security-sensitive areas (such as cryptography, authentication, authorization, and protocol parsing).
- When adding a dependency, **MUST** evaluate maintenance status, license, supply-chain risks, size, compatibility, and lockfile changes.
- **MUST NOT** reimplement error-prone, security-critical algorithms or protocols merely to achieve zero dependencies.
- **SHOULD** avoid rebuilding infrastructure that the project already provides.

## 4. Correctness, Security, and Engineering Baselines

Simplification may reduce only unnecessary complexity. The following are non-negotiable implementation baselines, and they take precedence over any instruction elsewhere in this rule to write less code.

- **MUST** preserve necessary input validation, output encoding, authorization checks, and trust-boundary protections.
- **MUST** preserve necessary handling of data integrity, concurrency consistency, and external failures.
- **MUST** cover normal flows explicitly requested by the user, critical failure paths, and important edge cases.
- **MUST NOT** dismiss a failure path as "impossible" when it is reachable from untrusted input, another module's contract, external systems, concurrency, or persistence. A scenario is only exempt from handling when it is genuinely unreachable and that unreachability is evident at the call site.
- **MUST NOT** conceal problems through silent fallbacks, swallowed errors, fake placeholder implementations, or fabricated results.
- **MUST NOT** remove, skip, or weaken existing tests to manufacture passing results.
- **MUST** respect the security requirements in `KEEPSECURED.md` and the environment and resource boundaries in `KEEPTIDY.md`.

## 5. Goal-Driven Verification

### 5.1 Define verifiable success criteria

**MUST** convert the task into a checkable goal before implementing, so that the work can be completed without repeated clarification.

- **MUST** rewrite a vague instruction into an observable outcome, for example:
  - "Add validation" → "Write tests for the invalid inputs, then make them pass."
  - "Fix the bug" → "Write a test that reproduces it, then make it pass."
  - "Refactor X" → "Confirm tests pass before and after."
- **SHOULD** state a short plan for multi-step tasks, with a check attached to each step:

  ```
  1. [Step] → verify: [check]
  2. [Step] → verify: [check]
  ```

- **MUST** treat a weak criterion ("make it work") as a signal to clarify rather than to guess.

### 5.2 Run the verification

- **MUST** run appropriate formatting checks, static analysis, and relevant tests based on the impact of the change; explicitly identify verification blocked by environmental constraints.
- **MUST** accurately report the commands actually run, their results, and any unverified scope.
- **SHOULD** test the affected scope first, then expand regression coverage according to change risk.
- **SHOULD** prefer a failing test first where the project already has a test harness for the affected code, or where adding one is trivial.
- **SHOULD** provide minimal effective verification for nontrivial logic involving branching, loops, data transformations, permissions, persistence, or external side effects.
- **SHOULD** reuse existing testing infrastructure instead of adding a complex toolchain for a one-off check; when no harness exists and a manual check is used instead, **MUST** say so explicitly.

## 6. Intentional Simplifications and Exceptions

- When an implementation has a defined scale limit, performance threshold, or known failure condition, **SHOULD** document that boundary and the conditions that would trigger an upgrade near the relevant code or in existing design documentation.
- **MUST** disclose simplifications that materially affect externally observable behavior, performance, security, or compatibility.
- **SHOULD** avoid repetitive technical-debt comments on ordinary, self-evident code.
- When work outside the original scope becomes necessary, **MUST** first determine whether it is essential supporting work for the task; significant scope expansions require appropriate authorization.

## 7. Delivery Checklist

- [ ] Surfaced assumptions and ambiguities before implementing; did not silently choose an interpretation.
- [ ] Confirmed the task's necessity and reviewed existing opportunities for reuse.
- [ ] Used the smallest reasonable implementation that satisfies security, correctness, and maintainability requirements.
- [ ] Traced every changed line to the user's request; removed orphans created by these changes only.
- [ ] Made no unauthorized unrelated refactors, dependency upgrades, or feature expansions.
- [ ] Ran necessary tests and disclosed any unexecuted checks and reasons.
- [ ] Disclosed known simplification boundaries and important trade-offs in proportion to their impact.

Final delivery should focus on **what was completed, how it was verified, and which practical limitations remain**. Routine small tasks do not require a lengthy account of the decision-making process.

## Summary for `AGENTS.md`

The `agents` step injects the marked region below into the project's `AGENTS.md`, so the constraints that decide what gets built travel with the reference instead of requiring the whole rule. Keep it behavioral and short.

<!-- keeprules:agents -->
### Minimal-change principles

- State assumptions and ambiguities before coding; never silently pick an interpretation.
- Assess necessity and reuse existing code before adding new implementations or dependencies.
- Prefer the smallest correct, secure, and maintainable change.
- Avoid unrelated refactoring, premature abstractions, and unrequested features or configuration.
- Trace every changed line to the request; clean up only orphans your own change created.
- Preserve essential validation, error handling, and security checks.
- Convert the task into a checkable goal, run relevant tests, and report actual verification results.
<!-- /keeprules:agents -->
