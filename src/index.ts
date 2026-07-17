import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff, Theme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	applyEditsToNormalizedContent,
	applyEditToNormalizedContent,
	computeEditsDiff,
	computeEditDiff,
	detectLineEnding,
	type EditMatchOptions,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { loadEditToolSettings } from "./settings.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

const MAX_EDITS = 5;
const MAX_EDIT_TEXT_LENGTH = 4_000;
const MAX_TOTAL_EDIT_TEXT_LENGTH = 10_000;

const editItemSchema = Type.Object({
	old_string: Type.String({
		minLength: 1,
		maxLength: MAX_EDIT_TEXT_LENGTH,
		description:
		"The smallest exact text for one replacement. It must be unique in the original file and must not overlap another edit.",
	}),
	new_string: Type.String({
		maxLength: MAX_EDIT_TEXT_LENGTH,
		description: "The replacement text. May be empty to delete old_string.",
	}),
});

const editSchema = Type.Object(
	{
		file_path: Type.String({ description: "The absolute or relative path to the file to modify." }),
		edits: Type.Array(editItemSchema, {
			minItems: 1,
			maxItems: MAX_EDITS,
			description:
				"One to five small replacements matched against the original file, with at most 10,000 characters combined. Do not overlap or nest edits, and merge changes affecting the same or nearby block.",
		}),
		replace_all: Type.Optional(
			Type.Boolean({ description: "Replace every occurrence. Only valid when edits contains one item." }),
		),
	},
	{},
);

export type EditToolInput = Static<typeof editSchema>;

type LegacyEditItemInput = {
	old_string?: unknown;
	new_string?: unknown;
	oldText?: unknown;
	newText?: unknown;
	old_str?: unknown;
	new_str?: unknown;
};

type LegacyEditToolInput = Omit<Partial<EditToolInput>, "edits"> & LegacyEditItemInput & {
	path?: unknown;
	change_all?: unknown;
	edits?: unknown;
};

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/** Matching behavior for exact/fuzzy replacement. Default: fuzzy enabled at 0.95 threshold. */
	matching?: EditMatchOptions;
}

function getLegacyEditItem(input: LegacyEditItemInput): EditToolInput["edits"][number] | null {
	const oldString =
		typeof input.old_string === "string"
			? input.old_string
			: typeof input.old_str === "string"
				? input.old_str
				: typeof input.oldText === "string"
					? input.oldText
					: null;
	const newString =
		typeof input.new_string === "string"
			? input.new_string
			: typeof input.new_str === "string"
				? input.new_str
				: typeof input.newText === "string"
					? input.newText
					: null;

	return oldString === null || newString === null ? null : { old_string: oldString, new_string: newString };
}

function hasTopLevelEdit(args: LegacyEditToolInput): boolean {
	return [args.old_string, args.new_string, args.old_str, args.new_str, args.oldText, args.newText].some(
		(value) => typeof value === "string",
	);
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as LegacyEditToolInput;
	if (Array.isArray(args.edits) && hasTopLevelEdit(args)) {
		throw new Error("Do not provide both edits and top-level old_string/new_string arguments.");
	}

	const filePath =
		typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : undefined;
	const edits = Array.isArray(args.edits)
		? args.edits.map((edit) =>
				edit && typeof edit === "object" ? getLegacyEditItem(edit as LegacyEditItemInput) : null,
			)
		: hasTopLevelEdit(args)
			? [getLegacyEditItem(args)]
			: undefined;
	const replaceAll =
		typeof args.replace_all === "boolean"
			? args.replace_all
			: typeof args.change_all === "boolean"
				? args.change_all
				: undefined;

	return {
		...(filePath !== undefined ? { file_path: filePath } : {}),
		...(edits !== undefined ? { edits } : {}),
		...(replaceAll !== undefined ? { replace_all: replaceAll } : {}),
	} as EditToolInput;
}

type ValidatedEditInput = {
	filePath: string;
	edits: Array<{ oldText: string; newText: string }>;
	replaceAll: boolean;
};

function validateEditInput(input: EditToolInput): ValidatedEditInput {
	if (!input || typeof input !== "object" || typeof input.file_path !== "string") {
		throw new Error("file_path must be a string.");
	}
	if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > MAX_EDITS) {
		throw new Error(`edits must contain between 1 and ${MAX_EDITS} items.`);
	}
	if (input.replace_all !== undefined && typeof input.replace_all !== "boolean") {
		throw new Error("replace_all must be a boolean.");
	}
	if (input.replace_all && input.edits.length !== 1) {
		throw new Error("replace_all is only valid when edits contains one item.");
	}

	let totalLength = 0;
	const edits = input.edits.map((edit, index) => {
		if (!edit || typeof edit.old_string !== "string" || typeof edit.new_string !== "string") {
			throw new Error(`edits[${index}] must contain string old_string and new_string values.`);
		}
		if (edit.old_string.length === 0) {
			throw new Error(`edits[${index}].old_string must not be empty.`);
		}
		if (edit.old_string.length > MAX_EDIT_TEXT_LENGTH || edit.new_string.length > MAX_EDIT_TEXT_LENGTH) {
			throw new Error(`edits[${index}] old_string and new_string must each be at most ${MAX_EDIT_TEXT_LENGTH} characters.`);
		}
		totalLength += edit.old_string.length + edit.new_string.length;
		return { oldText: edit.old_string, newText: edit.new_string };
	});
	if (totalLength > MAX_TOTAL_EDIT_TEXT_LENGTH) {
		throw new Error(`The combined edit text must be at most ${MAX_TOTAL_EDIT_TEXT_LENGTH} characters.`);
	}

	return { filePath: input.file_path, edits, replaceAll: input.replace_all ?? false };
}

type RenderableEditArgs = LegacyEditItemInput & {
	file_path?: string;
	path?: string;
	edits?: unknown;
	replace_all?: boolean;
	change_all?: boolean;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
}

function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = createEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getRenderablePreviewInput(
	args: RenderableEditArgs | undefined,
): { path: string; edits: Array<{ oldText: string; newText: string }>; replaceAll: boolean } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : null;
	if (!path || (Array.isArray(args.edits) && hasTopLevelEdit(args))) {
		return null;
	}

	const editItems = Array.isArray(args.edits)
		? args.edits.map((edit) =>
				edit && typeof edit === "object" ? getLegacyEditItem(edit as LegacyEditItemInput) : null,
			)
		: [getLegacyEditItem(args)];
	if (editItems.length < 1 || editItems.length > MAX_EDITS || editItems.some((edit) => edit === null)) {
		return null;
	}

	const canonicalEdits = editItems as EditToolInput["edits"];
	const totalLength = canonicalEdits.reduce((total, edit) => total + edit.old_string.length + edit.new_string.length, 0);
	if (
		canonicalEdits.some(
			(edit) =>
				edit.old_string.length < 1 ||
				edit.old_string.length > MAX_EDIT_TEXT_LENGTH ||
				edit.new_string.length > MAX_EDIT_TEXT_LENGTH,
		) ||
		totalLength > MAX_TOTAL_EDIT_TEXT_LENGTH
	) {
		return null;
	}

	const edits = canonicalEdits.map((edit) => ({ oldText: edit.old_string, newText: edit.new_string }));
	const replaceAll = args.replace_all ?? args.change_all ?? false;
	if (replaceAll && edits.length !== 1) {
		return null;
	}
	return { path, edits, replaceAll };
}

function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
	}

	return undefined;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) {
			return (text: string) => theme.bg("toolErrorBg", text);
		}
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, cwd), 0, 0));

	if (!component.preview) {
		return component;
	}

	const body =
		"error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	const matching = options?.matching ?? {};
	return {
		name: "edit",
		label: "edit",
		description:
			"Performs one to five small, exact replacements in one file. Each old_string must match a unique, non-overlapping region of the original file. Merge changes affecting the same or nearby block, and do not include large unchanged regions.",
		promptSnippet: "Perform small, exact string replacements in a file",
		promptGuidelines: [
			"Use edit with file_path and an edits array containing one to five small replacements.",
			"When changing multiple separate locations in one file, use one call with multiple edits.",
			"Each old_string must be the smallest unique exact match in the original file, including whitespace and newlines.",
			"Edits must not overlap or nest. Merge edits affecting the same or nearby block.",
			"Do not include large unchanged regions or replace whole files.",
			"Use replace_all only with one edit when every occurrence should change.",
		],
		parameters: editSchema,
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { filePath, edits, replaceAll } = validateEditInput(input);
			const absolutePath = resolveToCwd(filePath, cwd);

			return withFileMutationQueue(absolutePath, async () => {
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${filePath}. ${errorMessage}.`);
				}
				throwIfAborted();

				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent } = replaceAll
					? applyEditToNormalizedContent(normalizedContent, edits[0], filePath, {
							...matching,
							replaceAll: true,
						})
					: applyEditsToNormalizedContent(normalizedContent, edits, filePath, matching);
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(filePath, baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text:
								edits.length === 1
									? `Successfully replaced text in ${filePath}.`
									: `Successfully applied ${edits.length} edits to ${filePath}.`,
						},
					],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			const argsKey = previewInput ? JSON.stringify(previewInput) : undefined;

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
				component.previewPending = true;
				const requestKey = argsKey;
				const previewPromise = previewInput.replaceAll
					? computeEditDiff(
							previewInput.path,
							previewInput.edits[0].oldText,
							previewInput.edits[0].newText,
							context.cwd,
							{ ...matching, replaceAll: true },
						)
					: computeEditsDiff(previewInput.path, previewInput.edits, context.cwd, matching);
				void previewPromise.then((preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				});
			}

			return buildEditCallComponent(component, args, theme, context.cwd);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
			const argsKey = previewInput ? JSON.stringify(previewInput) : undefined;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;
			if (callComponent) {
				if (typeof resultDiff === "string") {
					changed =
						setEditPreview(
							callComponent,
							{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
							argsKey,
						) || changed;
				}
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				if (changed) {
					buildEditCallComponent(
						callComponent,
						context.args as RenderableEditArgs | undefined,
						theme,
						context.cwd,
					);
				}
			}

			const output = formatEditResult(context.args, callComponent?.preview, typedResult, theme, context.isError);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}

export default function editExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const settings = loadEditToolSettings(ctx.cwd);
		pi.registerTool(createEditToolDefinition(ctx.cwd, { matching: settings }));
	});
}
