# Live Sanity Suite

Date: 2026-04-15

## Purpose

This suite is for quick live validation of prompt quality, turn handling, tool calling, and dossier contents after harness changes.

Use it when:

- prompt assets change
- model-output parsing changes
- Architect or Engineer loop messaging changes
- tool-feedback shaping changes
- you want a fast real-world check beyond unit and regression tests

These prompts are intentionally small. A healthy run should stay short, converge quickly, and produce easy-to-inspect dossier artifacts.

## How To Run

1. Create a disposable repo with one of the target shapes below.
2. Copy in a working `agent-harness.toml`.
3. Commit the initial repo state and ignore `/.agent-harness/`.
4. Run one prompt with `blueprint run --task "<prompt>"`.
5. Inspect the latest dossier with `blueprint status` and `blueprint inspect`.

Recommended artifact checks:

- `events.jsonl`: prompt shape, message count, tool-call order, and retry behavior
- `engineer-task.md`: Architect-to-Engineer handoff quality
- `checks.json`: required-check sequence
- `architect-plan.md` and `architect-review.md`: plan/review compactness and correctness
- `final-report.md`: convergence summary

## Pass Criteria

For the core suite, a healthy run usually means:

- no broad wandering before the first edit
- no fake plain-text `Tool call:` history
- no malformed `COMPLETE:` / `BLOCKED:` handling
- Architect review prompt stays compact and does not inline large artifacts by default
- required checks are recorded correctly
- final approval matches the actual workspace state

Exact turn counts may vary by model. Focus on behavior, not one exact transcript.

## Core Suite

### 1. Exact File Write

Target repo:

- `package.json` with `"test": "node check.js"`
- `check.js` asserts that `SANITY.md` equals `Sanity check completed.\n`

Prompt:

```text
Create SANITY.md with exactly 'Sanity check completed.' and keep the required check green.
```

Primary signal:

- shortest happy path for direct file creation plus one required check

Good signs:

- Engineer edits before exploring
- Engineer runs the required check once if it gets the content right immediately
- Architect plan is literal and short
- Architect review is compact and may approve directly or after one narrow inspection

Inspect:

- `events.jsonl`: first Engineer action should be `file.write` or at worst one tiny inspection followed immediately by `file.write`
- `checks.json`: usually one passing check

### 2. Check-Guided Repair

Target repo:

- same as case 1, except `check.js` still requires `Sanity check completed.\n`
- task text does not mention the trailing newline

Prompt:

```text
Create SANITY.md with exactly 'Sanity check completed.' and keep the required check green.
```

Primary signal:

- Engineer must use failing command output, repair the file, and rerun the check

Good signs:

- Engineer does not restart repo exploration after the failed check
- Engineer uses the check failure text to make the smallest possible fix
- Architect review does not overreact to historical failed checks if the latest check passes

Inspect:

- `checks.json`: one failed check followed by one passed check
- `events.jsonl`: no broad exploration between failed and passing checks

### 3. Architect Review Inspection

Target repo:

- `package.json` with `"test": "node check.js"`
- `check.js` only verifies that `SANITY.md` exists, not its exact content

Prompt:

```text
Create SANITY.md with exactly 'Sanity check completed.' and do not modify any other file.
```

Primary signal:

- Architect review must decide whether current evidence is enough or request one narrow inspection tool

Good signs:

- Engineer still keeps the run short
- Architect review prompt stays compact
- If Architect inspects, it requests one narrow tool such as `file.read_many`, `file.read`, or `git.status`
- No default inline `checks.json`, diff, or failure-note dumps in the review prompt

Inspect:

- `events.jsonl`: Architect review `messageCount` should stay small
- `architect-review.md`: approval summary should mention exact content and workspace cleanliness only if supported by evidence

### 4. Direct Code Edit

Target repo:

- `src/example.ts` exports `value = 1`
- `check.js` or `npm test` asserts the export becomes `2`

Prompt:

```text
Update src/example.ts so it exports 2 instead of 1 and keep the required check green.
```

Primary signal:

- named-file code edit without unnecessary search or relisting

Good signs:

- Engineer acts directly on `src/example.ts`
- required check runs immediately after the edit
- no repeated rereads of the same file

Inspect:

- `events.jsonl`: first edit should happen quickly
- `final-report.md`: `stepsToFirstEdit` and `stepsToFirstRequiredCheck` should both stay low

### 5. Search-First Narrowing

Target repo:

- two or three small source files under `src/`
- only one file contains a target symbol or string used by the test

Prompt:

```text
Update the implementation of `targetValue` so the required check passes, and keep changes minimal.
```

Primary signal:

- when the exact file is not named, Engineer should search first, then batch-read a tiny set, then edit

Good signs:

- `file.search` before `file.list`
- `file.read_many` after narrowing, not many one-file reads
- no broad root relisting

Inspect:

- `events.jsonl`: `file.search` should appear before any broad directory listing
- `final-report.md`: repeated-read and repeated-listing counters should stay near zero

## Optional Stress Case

### 6. Revise-Cycle Probe

Target repo:

- required test only proves the main change
- prompt also requires one small extra artifact not covered by the test

Prompt:

```text
Create SANITY.md with exactly 'Sanity check completed.' and also create NOTES.md with exactly 'Follow-up captured.' Keep the required check green.
```

Purpose:

- probe whether the Architect can catch a missing non-test-backed acceptance criterion and issue a minimal revise cycle

Important:

- this is a weaker-model stress probe, not a strict deterministic gate
- some Engineer models will complete both artifacts in one pass
- some weaker Engineer models may miss `NOTES.md`, which is the behavior this probe is meant to catch

Good signs if a revise cycle occurs:

- Architect `nextActions` are literal and minimal
- Engineer does not restart broad exploration on the revise pass
- latest passing check state is preserved correctly

Bad signs:

- Architect requests broad investigation instead of one literal fix
- Engineer re-explores the repo instead of making the missing edit
- review loops continue after the missing artifact is fixed

## Suggested Run Order

Run these in order:

1. Exact File Write
2. Check-Guided Repair
3. Architect Review Inspection
4. Direct Code Edit
5. Search-First Narrowing
6. Revise-Cycle Probe

The first four should be reliable fast gates. The fifth validates convergence behavior when exact file paths are unknown. The sixth is a useful weaker-model stress check for Architect review and revise quality.

## What To Record

For each live sanity run, record:

- prompt ID
- run ID
- model pair used
- stop reason
- Engineer attempt count
- review cycle count
- required-check history
- anything surprising in `events.jsonl`

If you do this consistently, prompt regressions become much easier to spot across model or harness changes.
