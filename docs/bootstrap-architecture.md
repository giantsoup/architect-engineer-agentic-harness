# Bootstrap Architecture Notes

Date: 2026-04-13

Milestone 0 establishes the runtime shape without implementing harness behavior.

## Runtime Baseline

- Node target: Node.js 22+
- Module format: ESM
- Package target: npm-distributed CLI package
- Build tool: `tsup`
- Local TypeScript execution: `tsx`

This keeps the contributor workflow simple while staying aligned with modern Node CLI distribution.

## Tooling Baseline

- Type checking: `tsc --noEmit`
- Linting: ESLint flat config with `typescript-eslint`
- Formatting: Prettier
- Tests: Vitest

Vitest fixtures live under `test/fixtures/` so later milestones can add repo-shaped samples without changing test conventions.

## Initial Code Layout

The `src/` tree mirrors the planned backlog areas, but only the CLI shell is implemented in Milestone 0.

- `src/cli/` contains the executable entrypoint and command skeleton.
- `src/` sibling directories exist to make later milestones additive rather than structural rewrites.
- `prompts/` and `schemas/` live at the repo root as versioned assets that future runtime code can load directly from disk.
