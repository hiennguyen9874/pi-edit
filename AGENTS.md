# AGENTS.md

`pi-edit` is a TypeScript Pi coding-agent extension that registers an exact string replacement edit tool with diff preview/rendering support.

## Quick Reference

- Install: `npm install`
- Run: Unknown; no run script is defined in `package.json`.
- Test: `npm test`
- Test watch: `npm run test:watch`
- Build: Unknown; no build script is defined in `package.json` and `tsconfig.json` uses `noEmit`.
- Full checks: Unknown; no aggregate lint/typecheck/build script is defined in `package.json`.

## Mini Repo Map

- `src/index.ts` — Pi extension entrypoint, edit tool schema, execution, and TUI rendering.
- `src/edit-diff.ts` — edit matching, fuzzy normalization, replacement application, and diff generation.
- `src/paths.ts`, `src/path-utils.ts` — path normalization and cwd-relative resolution helpers.
- `src/render-utils.ts`, `src/tool-definition-wrapper.ts` — rendering helpers and `ToolDefinition`/`AgentTool` adapters.
- `test/` — Vitest tests for edit replacement behavior.
- `examples/` — example JSON tool definitions for compatible edit schemas.

## Instruction Index

Read these only when task matches scope:

| File | Read when | Contains |
|---|---|---|
| `docs/agent-instructions/architecture.md` | You change tool behavior, matching/replacement logic, rendering, path handling, or public extension APIs | Component map, data flow, contracts, gotchas |
| `docs/agent-instructions/build-system.md` | You need install, test, packaging, or command details beyond quick reference | npm scripts, TypeScript/Vitest config, package metadata |
| `docs/agent-instructions/testing.md` | You add/change tests or debug failures | Test command, framework, current coverage focus |
| `docs/agent-instructions/code-style.md` | You edit TypeScript and need project-specific conventions | Formatting, imports, API/style rules |

## Critical Rules

- Do not invent unavailable workflows: this repo currently has tests but no `build`, `lint`, `typecheck`, or `run` script in `package.json`.
- Preserve the edit tool contract: callers must provide exact replacement text, uniqueness is required unless `replace_all` is true, and legacy argument aliases are intentionally supported.
- Keep detailed agent guidance under `docs/agent-instructions/`; keep this root file concise.
