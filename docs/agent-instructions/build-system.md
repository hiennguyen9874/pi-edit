# Build System

## Purpose

Document the verified commands and package configuration for installing, testing, and packaging this Pi extension.

## Rules

- Use npm; the repository has `package-lock.json` and no pnpm/yarn workspace manifest.
- Do not claim a build, lint, typecheck, or run workflow exists unless `package.json` is updated to add it.
- Keep package entry metadata aligned with Pi extension loading: `package.json` declares `pi.extensions` as `./src/index.ts`.
- Remember published files are constrained by `package.json` `files`: `src`, `README.md`, and `LICENSE`.

## Commands

- `npm install` — install dependencies from `package-lock.json`.
- `npm test` — run Vitest once via `vitest run`.
- `npm run test:watch` — run Vitest in watch mode.
- `npm pack --dry-run` — preview the published tarball contents.
- `npm publish --access public` — publish `pi-multi-edit` to npm (`prepublishOnly` runs `npm test` first).

## Key Paths

- `package.json` — npm scripts, dependency metadata, peer dependency ranges, package files, and Pi extension registration.
- `package-lock.json` — locked npm dependency graph.
- `tsconfig.json` — strict TypeScript config with `noEmit`; includes `src/**/*.ts` and `test/**/*.ts`.
- `vitest.config.ts` — Vitest includes `test/**/*.test.ts` and excludes `profiling/**` and `node_modules/**`.
- `README.md` — user docs; included in package files.

## Gotchas

- There is no `npm run build`; TypeScript is configured with `noEmit`, so a packaging/build step is not represented in repo scripts.
- There is no `npm run lint` or `npm run typecheck`; use only verified commands unless you add and document new scripts.
- The npm package name is `pi-multi-edit`; `exports["."]` and `pi.extensions` both point to raw `./src/index.ts` (no compiled output).
- `@earendil-works/pi-*` packages and `typebox` are peer dependencies for consumers and dev dependencies where needed for local tests/development.

## Related Instructions

- [`testing.md`](testing.md) — test command and test layout.
- [`architecture.md`](architecture.md) — package extension entrypoint and runtime registration.
