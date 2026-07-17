# Testing

## Purpose

Help agents add or run focused tests for edit matching and replacement behavior.

## Rules

- Use Vitest for tests; current tests live under `test/**/*.test.ts`.
- Add regression tests near the behavior being changed, usually `test/edit-diff.test.ts` for replacement semantics.
- Prefer testing pure helpers from `src/edit-diff.ts` when changing matching/replacement behavior; avoid filesystem/TUI tests unless the task touches integration behavior.
- Verify user-visible invariants, not implementation text. Examples: duplicate rejection, `replaceAll` behavior, empty old text rejection, fuzzy match preservation, line ending/BOM behavior.

## Commands

- `npm test` — run the test suite once.
- `npm run test:watch` — run Vitest in watch mode while iterating.

## Key Paths

- `test/edit-diff.test.ts` — existing tests for `applyEditToNormalizedContent`.
- `src/edit-diff.ts` — pure edit and diff helpers that are easiest to test directly.
- `vitest.config.ts` — test file include/exclude patterns.

## Gotchas

- There is no dedicated typecheck or coverage script in `package.json`.
- The edit tool schema and `src/edit-diff.ts` both support multi-edit input; test the schema, execution, or pure helper layer that owns the changed behavior.

## Related Instructions

- [`architecture.md`](architecture.md) — edit matching and execution data flow.
- [`build-system.md`](build-system.md) — verified npm scripts.
