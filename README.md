# pi-edit

A Pi coding-agent extension that registers an `edit` tool for exact string replacement in files, with fuzzy matching, diff rendering, and TUI preview support.

## Features

- **Exact string replacement** — `old_string` must match exactly, including whitespace and newlines
- **Fuzzy matching** — configurable similarity-based fallback with smart quote / Unicode normalization
- **`replace_all`** — replace every occurrence when desired
- **Diff previews** — async diff computation shown in the TUI before tool execution
- **Unified patch output** — standard unified patch in tool result details
- **Line ending preservation** — auto-detects and preserves `\n` vs `\r\n`
- **BOM preservation** — strips BOM for matching, restores on write
- **Configurable settings** — global (`~/.pi-agent/settings.json`) and project (`.pi/settings.json`)
- **Pluggable file operations** — override read/write/access for remote editing (e.g. SSH)
- **Legacy argument aliases** — supports `path`, `oldText`, `newText`, `old_str`, `new_str`, `change_all`, `edits`
- **Multi-edit support** — apply multiple replacements in a single call with overlap detection
- **macOS path variants** — handles NFD unicode normalization, curly quotes, and narrow no-break spaces in screenshot filenames

## Install

```sh
npm install
```

## Test

```sh
npm test
npm run test:watch
```

## Tool input

```json
{
  "file_path": "src/example.ts",
  "old_string": "text to replace",
  "new_string": "replacement text",
  "replace_all": false
}
```

Legacy aliases are also accepted:

```json
{
  "path": "src/example.ts",
  "oldText": "text to replace",
  "newText": "replacement text",
  "change_all": false
}
```

Or with `edits` array (single edit):

```json
{
  "path": "src/example.ts",
  "edits": [
    { "oldText": "text to replace", "newText": "replacement text" }
  ]
}
```

## Configuration

Settings are loaded from both global and project-level config files. Project settings override global ones.

### `~/.pi-agent/settings.json` (global) and `.pi/settings.json` (project)

```json
{
  "edit": {
    "fuzzyMatch": true,
    "fuzzyThreshold": 0.95
  }
}
```

Or using the `piEdit` namespace:

```json
{
  "piEdit": {
    "fuzzyMatch": false,
    "fuzzyThreshold": 0.9
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `fuzzyMatch` | `boolean` | `true` | Enable fuzzy matching fallback when exact match fails |
| `fuzzyThreshold` | `number` | `0.95` | Similarity threshold for fuzzy matching (0–1) |

## Extension API

### `createEditToolDefinition(cwd, options?)` — `ToolDefinition`

Creates the full tool definition with TUI rendering, suitable for `pi.registerTool()`.

```ts
import { createEditToolDefinition } from "pi-edit";

const definition = createEditToolDefinition(process.cwd(), {
  matching: { allowFuzzy: false, fuzzyThreshold: 0.9 },
  operations: {
    readFile: async (path) => { /* custom read */ },
    writeFile: async (path, content) => { /* custom write */ },
    access: async (path) => { /* custom access check */ },
  },
});
```

### `createEditTool(cwd, options?)` — `AgentTool`

Wraps the tool definition into an `AgentTool` for the core runtime.

### Default extension

```ts
import editExtension from "pi-edit";

// Registers the edit tool on session_start
pi.registerExtension(editExtension);
```

## How matching works

1. **Exact match** — `old_string` is searched literally in the file content
2. **Fuzzy match** (if enabled) — when exact match fails:
   - Normalizes smart quotes (`""→"`, `''→'`), Unicode dashes, special spaces (NFKC + custom)
   - Tries substring match on normalized content
   - Falls back to line-window similarity with relative indent depth awareness
   - Rejects match if ambiguity is high (multiple candidates above threshold, or no dominant winner)
3. **`replace_all`** — finds all occurrences and replaces them, preserving unchanged lines in normalized mode

## Architecture

| File | Purpose |
|---|---|
| `src/index.ts` | Extension entrypoint — tool schema, execution, TUI rendering, argument normalization |
| `src/edit-diff.ts` | Core matching engine — fuzzy search, normalization, replacement application, diff/patch generation |
| `src/settings.ts` | Loads fuzzy match settings from global and project config files |
| `src/paths.ts` | Path normalization, resolution, canonicalization, cloud sync helpers |
| `src/path-utils.ts` | CWD-relative path resolution with macOS-specific fallbacks |
| `src/render-utils.ts` | TUI rendering helpers — path display, hyperlinks, theme-aware formatting |
| `src/tool-definition-wrapper.ts` | Wraps `ToolDefinition` into `AgentTool` for the core runtime |
| `src/child-process.ts` | Cross-platform process spawning with idle-timer-based child process waiting |

## License

MIT
