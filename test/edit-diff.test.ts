import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { applyEditToNormalizedContent, computeEditDiff } from "../src/edit-diff.ts";
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

describe("edit tool matching options", () => {
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
				{ file_path: filePath, old_string: 'const label = "Save"', new_string: 'const label = "Saved"' },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("Fuzzy matching is disabled");
		expect(await readFile(filePath, "utf-8")).toBe("const label = “Save”\n");
	});
});
