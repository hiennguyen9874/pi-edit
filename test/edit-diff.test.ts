import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyEditsToNormalizedContent,
	applyEditToNormalizedContent,
	computeEditDiff,
	computeEditsDiff,
} from "../src/edit-diff.ts";
import { createEditToolDefinition } from "../src/index.ts";

describe("applyEditToNormalizedContent", () => {
	it("replaces one unique occurrence by default", () => {
		const result = applyEditToNormalizedContent("one two three\n", { oldText: "two", newText: "2" }, "file.txt");

		expect(result.newContent).toBe("one 2 three\n");
	});

	it("rejects duplicate occurrences by default", () => {
		expect(() =>
			applyEditToNormalizedContent("one two two\n", { oldText: "two", newText: "2" }, "file.txt"),
		).toThrow("Found 2 occurrences");
	});

	it("replaces every occurrence when replaceAll is true", () => {
		const result = applyEditToNormalizedContent(
			"one two two\n",
			{ oldText: "two", newText: "2" },
			"file.txt",
			{ replaceAll: true },
		);

		expect(result.newContent).toBe("one 2 2\n");
	});

	it("rejects empty old text", () => {
		expect(() =>
			applyEditToNormalizedContent("one two\n", { oldText: "", newText: "2" }, "file.txt", {
				replaceAll: true,
			}),
		).toThrow("oldText must not be empty");
	});

	it("rejects normalized-only matches when fuzzy matching is disabled", () => {
		expect(() =>
			applyEditToNormalizedContent(
				"const label = “Save”\n",
				{ oldText: 'const label = "Save"', newText: 'const label = "Saved"' },
				"file.txt",
				{ allowFuzzy: false },
			),
		).toThrow("Fuzzy matching is disabled");
	});

	it("preserves smart quote and unicode normalization behavior when fuzzy matching is enabled", () => {
		const result = applyEditToNormalizedContent(
			"const label = “Save”\n",
			{ oldText: 'const label = "Save"', newText: 'const label = "Saved"' },
			"file.txt",
		);

		expect(result.newContent).toBe('const label = "Saved"\n');
	});

	it("replaces a high-confidence typo match using line-window fuzzy matching", () => {
		const result = applyEditToNormalizedContent(
			"function greet() {\n\treturn \"hello\";\n}\n",
			{ oldText: "function greet() {\n\tretun \"hello\";\n}", newText: "function greet() {\n\treturn \"hi\";\n}" },
			"file.ts",
		);

		expect(result.newContent).toBe("function greet() {\n\treturn \"hi\";\n}\n");
	});

	it("rejects true fuzzy matches below the threshold", () => {
		expect(() =>
			applyEditToNormalizedContent(
				"function alpha() {\n\treturn 1;\n}\n",
				{ oldText: "function beta() {\n\treturn 2;\n}", newText: "changed" },
				"file.ts",
				{ fuzzyThreshold: 0.99 },
			),
		).toThrow("below the 99% similarity threshold");
	});

	it("rejects ambiguous high-confidence fuzzy candidates", () => {
		expect(() =>
			applyEditToNormalizedContent(
				"const item1 = true;\nconst item2 = true;\nconst item3 = true;\n",
				{ oldText: "const itemX = true;", newText: "const itemX = false;" },
				"file.ts",
				{ fuzzyThreshold: 0.8 },
			),
		).toThrow("high-confidence matches");
	});

	it("accepts a dominant fuzzy match when multiple candidates are above threshold", () => {
		const result = applyEditToNormalizedContent(
			"const userIdentifier = true;\nconst item1 = true;\nconst item2 = true;\n",
			{ oldText: "const userIdentifer = true;", newText: "const userIdentifier = false;" },
			"file.ts",
			{ fuzzyThreshold: 0.8 },
		);

		expect(result.newContent).toBe(
			"const userIdentifier = false;\nconst item1 = true;\nconst item2 = true;\n",
		);
	});
});

describe("applyEditsToNormalizedContent", () => {
	it("applies disjoint edits matched against the original content", () => {
		const result = applyEditsToNormalizedContent(
			"const first = 1;\nconst second = 2;\n",
			[
				{ oldText: "first = 1", newText: "first = 10" },
				{ oldText: "second = 2", newText: "second = 20" },
			],
			"file.ts",
		);

		expect(result.newContent).toBe("const first = 10;\nconst second = 20;\n");
	});

	it("rejects overlapping edits", () => {
		expect(() =>
			applyEditsToNormalizedContent(
				"const value = 1;\n",
				[
					{ oldText: "const value = 1;", newText: "const value = 2;" },
					{ oldText: "value = 1", newText: "value = 3" },
				],
				"file.ts",
			),
		).toThrow("overlap");
	});
});

describe("edit tool input", () => {
	let tempDir: string | undefined;

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("uses the same matching options for preview and execute", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-edit-"));
		const filePath = join(tempDir, "file.ts");
		await writeFile(filePath, "const label = “Save”\n", "utf-8");
		const matching = { allowFuzzy: false };

		const preview = await computeEditDiff(
			filePath,
			'const label = "Save"',
			'const label = "Saved"',
			tempDir,
			matching,
		);
		const tool = createEditToolDefinition(tempDir, { matching });

		expect(preview).toEqual({ error: expect.stringContaining("Fuzzy matching is disabled") });
		await expect(
			tool.execute(
				"call-id",
				{
					file_path: filePath,
					edits: [{ old_string: 'const label = "Save"', new_string: 'const label = "Saved"' }],
				},
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("Fuzzy matching is disabled");
		expect(await readFile(filePath, "utf-8")).toBe("const label = “Save”\n");
	});

	it("applies multiple edits and produces the same preview diff", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-edit-"));
		const filePath = join(tempDir, "file.ts");
		await writeFile(filePath, "const first = 1;\nconst second = 2;\n", "utf-8");
		const internalEdits = [
			{ oldText: "first = 1", newText: "first = 10" },
			{ oldText: "second = 2", newText: "second = 20" },
		];
		const preview = await computeEditsDiff(filePath, internalEdits, tempDir);
		const tool = createEditToolDefinition(tempDir);

		const result = await tool.execute(
			"call-id",
			{
				file_path: filePath,
				edits: internalEdits.map((edit) => ({ old_string: edit.oldText, new_string: edit.newText })),
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(await readFile(filePath, "utf-8")).toBe("const first = 10;\nconst second = 20;\n");
		expect(preview).not.toHaveProperty("error");
		expect(result.details?.diff).toBe("diff" in preview ? preview.diff : undefined);
	});

	it("does not write when any edit fails", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-edit-"));
		const filePath = join(tempDir, "file.ts");
		const original = "const first = 1;\nconst second = 2;\n";
		await writeFile(filePath, original, "utf-8");
		const tool = createEditToolDefinition(tempDir);

		await expect(
			tool.execute(
				"call-id",
				{
					file_path: filePath,
					edits: [
						{ old_string: "first = 1", new_string: "first = 10" },
						{ old_string: "missing = 2", new_string: "missing = 20" },
					],
				},
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("edits[1]");
		expect(await readFile(filePath, "utf-8")).toBe(original);
	});

	it("accepts more than five edits with a warning", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-edit-"));
		const filePath = join(tempDir, "file.txt");
		const original = "one two three four five six\n";
		await writeFile(filePath, original, "utf-8");
		const tool = createEditToolDefinition(tempDir);
		const edits = ["one", "two", "three", "four", "five", "six"].map((text) => ({
			old_string: text,
			new_string: text.toUpperCase(),
		}));

		expect(tool.parameters.properties.edits).not.toHaveProperty("maxItems");
		const fiveEditResult = await tool.execute(
			"call-id",
			{ file_path: filePath, edits: edits.slice(0, 5) },
			undefined,
			undefined,
			undefined as never,
		);
		expect(fiveEditResult.details?.warning).toBeUndefined();

		await writeFile(filePath, original, "utf-8");
		const sixEditResult = await tool.execute(
			"call-id",
			{ file_path: filePath, edits },
			undefined,
			undefined,
			undefined as never,
		);

		expect(await readFile(filePath, "utf-8")).toBe("ONE TWO THREE FOUR FIVE SIX\n");
		expect(sixEditResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Warning: this call contains 6 edits; prefer 5 or fewer per call."),
		});
		expect(sixEditResult.details?.warning).toBe(
			"Warning: this call contains 6 edits; prefer 5 or fewer per call.",
		);
	});

	it("enforces individual and aggregate edit size limits", async () => {
		const tool = createEditToolDefinition(tmpdir());
		const execute = (edits: Array<{ old_string: string; new_string: string }>) =>
			tool.execute("call-id", { file_path: "file.txt", edits }, undefined, undefined, undefined as never);

		await expect(execute([{ old_string: "a".repeat(4_001), new_string: "b" }])).rejects.toThrow(
			"at most 4000 characters",
		);
		await expect(
			execute([
				{ old_string: "a".repeat(3_000), new_string: "b".repeat(3_000) },
				{ old_string: "c".repeat(3_000), new_string: "d".repeat(2_000) },
			]),
		).rejects.toThrow("at most 10000 characters");
	});

	it("rejects replace_all with multiple edits", async () => {
		const tool = createEditToolDefinition(tmpdir());

		await expect(
			tool.execute(
				"call-id",
				{
					file_path: "file.txt",
					edits: [
						{ old_string: "one", new_string: "ONE" },
						{ old_string: "two", new_string: "TWO" },
					],
					replace_all: true,
				},
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("only valid when edits contains one item");
	});

	it("normalizes legacy top-level arguments and replace_all", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-edit-"));
		const filePath = join(tempDir, "file.txt");
		await writeFile(filePath, "old old\n", "utf-8");
		const tool = createEditToolDefinition(tempDir);
		const prepared = tool.prepareArguments?.({
			path: filePath,
			oldText: "old",
			newText: "new",
			change_all: true,
		});

		expect(prepared).toEqual({
			file_path: filePath,
			edits: [{ old_string: "old", new_string: "new" }],
			replace_all: true,
		});
		await tool.execute("call-id", prepared!, undefined, undefined, undefined as never);
		expect(await readFile(filePath, "utf-8")).toBe("new new\n");
	});

	it("normalizes legacy camel-case edit arrays", () => {
		const tool = createEditToolDefinition(tmpdir());

		expect(
			tool.prepareArguments?.({
				path: "file.txt",
				edits: [
					{ oldText: "one", newText: "ONE" },
					{ oldText: "two", newText: "TWO" },
				],
			}),
		).toEqual({
			file_path: "file.txt",
			edits: [
				{ old_string: "one", new_string: "ONE" },
				{ old_string: "two", new_string: "TWO" },
			],
		});
	});

	it("preserves BOM and CRLF when applying multiple edits", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-edit-"));
		const filePath = join(tempDir, "file.txt");
		await writeFile(filePath, "\uFEFFone\r\ntwo\r\n", "utf-8");
		const tool = createEditToolDefinition(tempDir);

		await tool.execute(
			"call-id",
			{
				file_path: filePath,
				edits: [
					{ old_string: "one", new_string: "ONE" },
					{ old_string: "two", new_string: "TWO" },
				],
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(await readFile(filePath, "utf-8")).toBe("\uFEFFONE\r\nTWO\r\n");
	});
});
