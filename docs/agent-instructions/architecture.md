# Architecture

## Purpose

Help agents change `pi-edit` behavior without breaking the Pi extension contract, edit matching semantics, or rendered diff output.

## Rules

- Treat `src/index.ts` as the public extension boundary: it registers the tool on `session_start`, defines the user-facing schema, prepares legacy aliases, executes file mutation, and renders previews/results.
- Keep exact replacement semantics centralized in `src/edit-diff.ts`; do not duplicate matching, fuzzy normalization, replacement, or diff generation logic in the extension entrypoint.
- Preserve legacy input compatibility in `prepareEditArguments` unless the task explicitly removes it. Supported aliases include `path`, top-level or nested `oldText`/`newText`, `old_str`/`new_str`, and `change_all`.
- Preserve line-ending and BOM behavior: execution strips BOM before matching, normalizes to LF for edit logic, restores the original dominant line ending, and writes the BOM back when present.
- Use `withFileMutationQueue(absolutePath, ...)` for filesystem mutations to keep edits to the same file serialized.
- Keep preview behavior non-mutating: preview rendering should call diff computation helpers and must not write files.

## Key Paths

- `src/index.ts` — extension entrypoint, tool schema, argument preparation, execution, and TUI renderers.
- `src/edit-diff.ts` — fuzzy matching, replacement application, error messages, display diffs, and unified patches.
- `src/path-utils.ts` — cwd resolution plus read-path fallbacks for macOS screenshot/unicode filename variants.
- `src/paths.ts` — generic path normalization, `~` expansion, file URL handling, and cwd-relative formatting.
- `src/render-utils.ts` — path display/link helpers for TUI output.
- `src/tool-definition-wrapper.ts` — adapters between Pi `ToolDefinition` and core `AgentTool`.
- `examples/` — example JSON schemas for compatible edit tool surfaces.

## Gotchas

- `replace_all` changes duplicate handling: without it, duplicate old text is rejected; with it, every match is replaced.
- Fuzzy matching normalizes trailing whitespace, smart quotes, unicode dashes, and unicode spaces; unchanged line blocks should keep original bytes where possible.
- The exported tool accepts one or more bounded `edits` matched against the original file. Five or fewer is recommended; larger batches succeed with a warning when otherwise valid. `replace_all` is only valid for a single-item array; legacy top-level edit arguments are normalized into that canonical shape.
- Error strings are user-facing and tested indirectly by behavior; avoid casual rewrites unless the task is about UX/errors.

## Related Instructions

- [`testing.md`](testing.md) — add focused regression coverage for matching or replacement behavior changes.
- [`code-style.md`](code-style.md) — follow local TypeScript style when editing source.
