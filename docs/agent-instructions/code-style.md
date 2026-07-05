# Code Style

## Purpose

Capture local TypeScript conventions that are visible in this repository and matter when editing code.

## Rules

- Use TypeScript ESM imports with explicit `.ts` extensions for local modules, matching existing `src/**/*.ts` files.
- Keep strict typing; avoid weakening exported types or adding `any` except where an existing adapter boundary already uses it.
- Preserve tabs for indentation in `src/` files. `vitest.config.ts` currently uses two-space indentation; match the file being edited.
- Keep public contracts exported from `src/index.ts` and `src/edit-diff.ts` stable unless the task explicitly changes API shape.
- Prefer small pure helpers in `src/edit-diff.ts` for matching/replacement logic and keep filesystem or TUI concerns in `src/index.ts`.
- Do not add dependencies unless the task requires them and `package.json` is updated intentionally.

## Key Paths

- `src/index.ts` — public tool and extension types plus runtime integration.
- `src/edit-diff.ts` — pure edit/diff logic with exported helper types.
- `tsconfig.json` — strict compiler options and included source/test globs.

## Gotchas

- Local imports use `.ts` suffixes because `moduleResolution` is `bundler`.
- Some user-facing descriptions mention exact matching even though fuzzy matching exists internally as a fallback; preserve wording unless changing the user contract intentionally.

## Related Instructions

- [`architecture.md`](architecture.md) — module responsibilities and behavior contracts.
- [`testing.md`](testing.md) — regression test expectations.
