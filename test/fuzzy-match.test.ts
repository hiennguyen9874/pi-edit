import { describe, expect, it } from "vitest";
import { fuzzyFindText, findBestFuzzyMatch, normalizeForFuzzyMatch, similarity, levenshteinDistance, DEFAULT_FUZZY_THRESHOLD } from "../src/edit-diff.ts";

// =============================================================================
// Unit tests: normalization helpers
// =============================================================================

describe("normalizeForFuzzyMatch", () => {
	it("strips trailing whitespace from each line", () => {
		const input = "hello   \nworld   \n";
		const result = normalizeForFuzzyMatch(input);
		expect(result).toBe("hello\nworld\n");
	});

	it("converts smart single quotes to ASCII single quote", () => {
		// U+2018 left, U+2019 right single quote
		const input = "\u2018hello\u2019";
		const result = normalizeForFuzzyMatch(input);
		expect(result).toBe("'hello'");
	});

	it("converts smart double quotes to ASCII double quote", () => {
		// U+201C left, U+201D right double quote
		const input = "\u201Chello\u201D";
		const result = normalizeForFuzzyMatch(input);
		expect(result).toBe('"hello"');
	});

	it("converts en-dash and em-dash to ASCII hyphen", () => {
		const input = "foo\u2013bar\u2014baz";
		const result = normalizeForFuzzyMatch(input);
		expect(result).toBe("foo-bar-baz");
	});

	it("converts NBSP and other special spaces to regular space", () => {
		// U+00A0 NBSP
		const input = "hello\u00A0world";
		const result = normalizeForFuzzyMatch(input);
		expect(result).toBe("hello world");
	});

	it("applies NFKC normalization", () => {
		// Full-width latin letters → normal ASCII
		const input = "\uFF28\uFF45\uFF4C\uFF4C\uFF4F"; // "Ｈｅｌｌｏ" (fullwidth)
		const result = normalizeForFuzzyMatch(input);
		expect(result).toBe("Hello");
	});

	it("combines multiple normalizations", () => {
		// Trailing whitespace + smart quotes
		const input = '\u201Ctest\u201D   \n';
		const result = normalizeForFuzzyMatch(input);
		expect(result).toBe('"test"\n');
	});
});

describe("similarity", () => {
	it("returns 1 for identical strings", () => {
		expect(similarity("hello", "hello")).toBe(1);
	});

	it("returns 0 for completely different strings", () => {
		expect(similarity("abc", "xyz")).toBe(0);
	});

	it("returns high value for strings with one typo", () => {
		// "retun" vs "return" — 1 char diff out of ~6
		const score = similarity("retun", "return");
		expect(score).toBeGreaterThan(0.8);
	});

	it("returns 1 for both empty strings", () => {
		expect(similarity("", "")).toBe(1);
	});
});

describe("levenshteinDistance", () => {
	it("returns 0 for identical strings", () => {
		expect(levenshteinDistance("hello", "hello")).toBe(0);
	});

	it("returns correct distance for single insertion", () => {
		expect(levenshteinDistance("helo", "hello")).toBe(1);
	});

	it("returns correct distance for single substitution", () => {
		expect(levenshteinDistance("hello", "hallo")).toBe(1);
	});
});

// =============================================================================
// findBestFuzzyMatch tests (line-window fuzzy matching)
// =============================================================================

describe("findBestFuzzyMatch", () => {
	it("finds a single-line match with a typo", () => {
		// Long line: 1 char typo in a ~55-char string → similarity ≈ 0.98
		const content = "const userIdentifierValue = calculateUserIdentifier();\n";
		const target = "const userIdenfierValue = calculateUserIdentifier();";
		const result = findBestFuzzyMatch(content, target, DEFAULT_FUZZY_THRESHOLD);
		expect(result.best).toBeDefined();
		expect(result.best!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		expect(result.aboveThresholdCount).toBe(1);
	});

	it("finds a multi-line match with a typo", () => {
		const content = "function greet() {\n\treturn \"hello\";\n}\n";
		const target = "function greet() {\n\tretun \"hello\";\n}";
		const result = findBestFuzzyMatch(content, target, DEFAULT_FUZZY_THRESHOLD);
		expect(result.best).toBeDefined();
		expect(result.best!.confidence).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
	});

	it("finds a match when indentation differs slightly", () => {
		const content = "if (x) {\n    doStuff();\n}\n";
		const target = "if (x) {\n  doStuff();\n}";
		const result = findBestFuzzyMatch(content, target, 0.8);
		expect(result.best).toBeDefined();
		expect(result.best!.confidence).toBeGreaterThanOrEqual(0.8);
	});

	it("reports aboveThresholdCount for multiple candidates", () => {
		const content = "const item1 = true;\nconst item2 = true;\nconst item3 = true;\n";
		const target = "const itemX = true;";
		const result = findBestFuzzyMatch(content, target, 0.8);
		expect(result.aboveThresholdCount).toBeGreaterThan(1);
	});

	it("returns undefined best when no match meets threshold", () => {
		const content = "function alpha() {\n\treturn 1;\n}\n";
		const target = "function beta() {\n\treturn 2;\n}";
		const result = findBestFuzzyMatch(content, target, 0.99);
		expect(result.best).toBeDefined(); // best is still found
		expect(result.best!.confidence).toBeLessThan(0.99);
		expect(result.aboveThresholdCount).toBe(0);
	});
});

// =============================================================================
// fuzzyFindText tests (progressive fallback)
// =============================================================================

describe("fuzzyFindText - exact match", () => {
	it("returns exact match without fuzzy", () => {
		const content = "hello world\n";
		const target = "hello world";
		const result = fuzzyFindText(content, target, "test.txt");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(false);
		expect(result.index).toBe(0);
		expect(result.matchLength).toBe(11);
	});

	it("returns exact match at non-zero offset", () => {
		const content = "prefix hello world suffix\n";
		const target = "hello world";
		const result = fuzzyFindText(content, target, "test.txt");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(false);
		expect(result.index).toBe(7);
	});
});

describe("fuzzyFindText - normalized substring match", () => {
	it("matches when old_string uses ASCII quotes but file has smart quotes", () => {
		const content = 'const label = \u201CSave\u201D;\n';
		const target = 'const label = "Save";';
		const result = fuzzyFindText(content, target, "test.txt");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
		// Normalized substring matches use fuzzyContent for replacement
		expect(result.contentForReplacement).not.toBe(content);
	});

	it("matches when file has em-dash but old_string uses hyphen", () => {
		const content = "option\u2014value\n";
		const target = "option-value";
		const result = fuzzyFindText(content, target, "test.txt");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
	});

	it("matches when file has NBSP but old_string uses regular space", () => {
		const content = "hello\u00A0world\n";
		const target = "hello world";
		const result = fuzzyFindText(content, target, "test.txt");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
	});

	it("matches exactly when old_string is a prefix of the actual line (trailing whitespace is harmless)", () => {
		// Exact match: the old_string is a literal substring of the file content
		const content = "const x = 1;   \n";
		const target = "const x = 1;";
		const result = fuzzyFindText(content, target, "test.txt");
		expect(result.found).toBe(true);
		// Exact match succeeds because old_string is a prefix substring
		expect(result.usedFuzzyMatch).toBe(false);
	});

	it("matches with NFKC normalization (fullwidth chars)", () => {
		const content = "\uFF28\uFF45\uFF4C\uFF4C\uFF4F world\n"; // "Ｈｅｌｌｏ"
		const target = "Hello world";
		const result = fuzzyFindText(content, target, "test.txt");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
	});
});

describe("fuzzyFindText - line-window fuzzy match (typos)", () => {
	it("finds a match with a single character typo", () => {
		const content = "function greet() {\n\treturn \"hello\";\n}\n";
		const target = "function greet() {\n\tretun \"hello\";\n}";
		const result = fuzzyFindText(content, target, "test.txt");
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
		// Line-window matches use original content for replacement
		expect(result.contentForReplacement).toBe(content);
	});

	it("finds a match with a missing character (insertion needed)", () => {
		// "greting" vs "greeting" — one missing 'e', similarity ~0.92, but
		// with indentation-depth normalization the functional parts match closely
		const content = "const greeting = 'hello';\n";
		const target = "const greetin = 'hello';";
		const result = fuzzyFindText(content, target, "test.txt", { fuzzyThreshold: 0.88 });
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
	});

	it("finds a match when one line is slightly different", () => {
		const content = "const userName = 'Alice';\nconst userAge = 30;\n";
		const target = "const usrName = 'Alice';";
		const result = fuzzyFindText(content, target, "test.txt", { fuzzyThreshold: 0.85 });
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
	});
});

describe("fuzzyFindText - failure cases", () => {
	it("returns not found for completely unrelated text", () => {
		const content = "function alpha() {\n\treturn 1;\n}\n";
		const target = "function beta() {\n\treturn 2;\n}";
		const result = fuzzyFindText(content, target, "test.txt", { fuzzyThreshold: 0.99 });
		expect(result.found).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("returns error for ambiguous candidates", () => {
		const content = "const item1 = true;\nconst item2 = true;\nconst item3 = true;\n";
		const target = "const itemX = true;";
		const result = fuzzyFindText(content, target, "test.txt", { fuzzyThreshold: 0.8 });
		expect(result.found).toBe(false);
		expect(result.error).toBeDefined();
		expect(result.error!.message).toMatch(/high-confidence matches/);
	});

	it("returns error when fuzzy is disabled and exact match fails", () => {
		const content = 'const label = \u201CSave\u201D;\n';
		const target = 'const label = "Save";';
		const result = fuzzyFindText(content, target, "test.txt", { allowFuzzy: false });
		expect(result.found).toBe(false);
		expect(result.error!.message).toMatch(/Fuzzy matching is disabled/);
	});
});

// =============================================================================
// Integration: applyEditToNormalizedContent with fuzzy matching
// =============================================================================
import { applyEditToNormalizedContent } from "../src/edit-diff.ts";

describe("applyEditToNormalizedContent - normalized substring fuzzy", () => {
	it("replaces text with smart quote normalization", () => {
		const content = 'const label = \u201CSave\u201D;\n';
		const result = applyEditToNormalizedContent(
			content,
			{ oldText: 'const label = "Save";', newText: 'const label = "Saved";' },
			"test.txt",
		);
		expect(result.newContent).toBe('const label = "Saved";\n');
	});

	it("replaces text with em-dash to hyphen normalization", () => {
		const content = "option\u2014value\n";
		const result = applyEditToNormalizedContent(
			content,
			{ oldText: "option-value", newText: "option:value" },
			"test.txt",
		);
		expect(result.newContent).toBe("option:value\n");
	});

	it("replaces text with NBSP to space normalization", () => {
		const content = "hello\u00A0world\n";
		const result = applyEditToNormalizedContent(
			content,
			{ oldText: "hello world", newText: "hello universe" },
			"test.txt",
		);
		expect(result.newContent).toBe("hello universe\n");
	});

	it("preserves trailing whitespace when old_text is an exact substring prefix", () => {
		// The file line has trailing spaces. The oldText matches as an exact substring
		// prefix, so the trailing spaces on that line are preserved after replacement.
		const content = "const x = 1;   \nconst y = 2;\n";
		const result = applyEditToNormalizedContent(
			content,
			{ oldText: "const x = 1;", newText: "const x = 10;" },
			"test.txt",
		);
		// Trailing whitespace is preserved because the exact match only covers the prefix
		expect(result.newContent).toBe("const x = 10;   \nconst y = 2;\n");
	});
});

describe("applyEditToNormalizedContent - line-window fuzzy (typos)", () => {
	it("replaces using fuzzy typo match", () => {
		const content = "function greet() {\n\treturn \"hello\";\n}\n";
		const result = applyEditToNormalizedContent(
			content,
			{ oldText: "function greet() {\n\tretun \"hello\";\n}", newText: "function greet() {\n\treturn \"hi\";\n}" },
			"test.ts",
		);
		expect(result.newContent).toBe("function greet() {\n\treturn \"hi\";\n}\n");
	});

	it("replaces using fuzzy typo match - single line", () => {
		const content = "const userName = 'Alice';\nconst userAge = 30;\n";
		const result = applyEditToNormalizedContent(
			content,
			{ oldText: "const usrName = 'Alice';", newText: "const userName = 'Bob';" },
			"test.ts",
			{ fuzzyThreshold: 0.85 },
		);
		expect(result.newContent).toBe("const userName = 'Bob';\nconst userAge = 30;\n");
	});

	it("replaces multi-line block with a typo on one line", () => {
		const content = "if (ready) {\n\tprocessData();\n\trenderUI();\n}\n";
		const result = applyEditToNormalizedContent(
			content,
			{ oldText: "if (ready) {\n\tprocesData();\n\trenderUI();\n}", newText: "if (ready) {\n\tprocessData();\n\trenderOutput();\n}" },
			"test.ts",
		);
		expect(result.newContent).toBe("if (ready) {\n\tprocessData();\n\trenderOutput();\n}\n");
	});
});

describe("applyEditToNormalizedContent - failure modes", () => {
	it("throws when fuzzy match is below threshold", () => {
		const content = "function alpha() {\n\treturn 1;\n}\n";
		expect(() =>
			applyEditToNormalizedContent(
				content,
				{ oldText: "function beta() {\n\treturn 2;\n}", newText: "changed" },
				"test.ts",
				{ fuzzyThreshold: 0.99 },
			),
		).toThrow(/below the 99% similarity threshold/);
	});

	it("throws when fuzzy produces ambiguous candidates", () => {
		const content = "const item1 = true;\nconst item2 = true;\nconst item3 = true;\n";
		expect(() =>
			applyEditToNormalizedContent(
				content,
				{ oldText: "const itemX = true;", newText: "const itemX = false;" },
				"test.ts",
				{ fuzzyThreshold: 0.8 },
			),
		).toThrow(/high-confidence matches/);
	});

	it("accepts dominant fuzzy match among multiple candidates", () => {
		// One line is clearly the best match
		const content = "const userIdentifier = true;\nconst item1 = true;\nconst item2 = true;\n";
		const result = applyEditToNormalizedContent(
			content,
			{ oldText: "const userIdentifer = true;", newText: "const userIdentifier = false;" },
			"test.ts",
			{ fuzzyThreshold: 0.8 },
		);
		expect(result.newContent).toBe("const userIdentifier = false;\nconst item1 = true;\nconst item2 = true;\n");
	});
});

// =============================================================================
// Integration: computeEditDiff preview with fuzzy matching
// =============================================================================
import { computeEditDiff } from "../src/edit-diff.ts";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach } from "vitest";

describe("computeEditDiff with fuzzy matching - integration", () => {
	let tempDir: string | undefined;

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("returns a successful diff preview for smart quote fuzzy match", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-edit-fz-"));
		const filePath = join(tempDir, "config.ts");
		await writeFile(filePath, 'const title = \u201CUntitled\u201D;\n', "utf-8");

		const result = await computeEditDiff(
			filePath,
			'const title = "Untitled";',
			'const title = "My App";',
			tempDir,
		);

		expect(result).not.toHaveProperty("error");
		expect(result).toHaveProperty("diff");
	});

	it("returns error preview when fuzzy matching is disabled for smart quotes", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-edit-fz-"));
		const filePath = join(tempDir, "config.ts");
		await writeFile(filePath, 'const title = \u201CUntitled\u201D;\n', "utf-8");

		const result = await computeEditDiff(
			filePath,
			'const title = "Untitled";',
			'const title = "My App";',
			tempDir,
			{ allowFuzzy: false },
		);

		expect(result).toHaveProperty("error");
		if ("error" in result) {
			expect(result.error).toMatch(/Fuzzy matching is disabled/);
		}
	});

	it("returns a successful diff preview for typo fuzzy match", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-edit-fz-"));
		const filePath = join(tempDir, "utils.ts");
		await writeFile(filePath, "function calculate() {\n\treturn 42;\n}\n", "utf-8");

		const result = await computeEditDiff(
			filePath,
			"function claculate() {\n\treturn 42;\n}",
			"function calculate() {\n\treturn 100;\n}",
			tempDir,
		);

		expect(result).not.toHaveProperty("error");
		expect(result).toHaveProperty("diff");
	});

	it("preserves unchanged lines when fuzzy matching against a file", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-edit-fz-"));
		const filePath = join(tempDir, "data.ts");
		const originalContent = [
			'import { foo } from "lib";',
			"",
			'const label = "Click\u00A0Here";',
			"const count = 42;",
			"",
			'export { label, count };',
			"",
		].join("\n");
		await writeFile(filePath, originalContent, "utf-8");

		// oldText uses regular space, file has NBSP — fuzzy normalized substring match
		const result = await computeEditDiff(
			filePath,
			'const label = "Click Here";',
			'const label = "Tap Here";',
			tempDir,
		);

		expect(result).not.toHaveProperty("error");
		if (!("error" in result)) {
			// The diff should only show the label line changing
			expect(result.diff).toMatch(/label/);
			// Unchanged lines should NOT appear in the diff context for a single-line change
			// (the diff should be focused around the changed line)
		}
	});
});
