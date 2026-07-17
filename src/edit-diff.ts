/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base, and all other lines are copied back
 * from `originalContent`. The actual replacement ranges drive preservation so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

export const DEFAULT_FUZZY_THRESHOLD = 0.95;
const DOMINANT_FUZZY_MIN_CONFIDENCE = 0.97;
const DOMINANT_FUZZY_DELTA = 0.08;
const FALLBACK_THRESHOLD = 0.8;

export interface EditMatchOptions {
	allowFuzzy?: boolean;
	fuzzyThreshold?: number;
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * Exact and true fuzzy matches use original content. Normalized substring
	 * matches use normalized content to preserve existing compatibility behavior.
	 */
	contentForReplacement: string;
	/** User-facing reason why a fuzzy candidate was rejected. */
	error?: Error;
}

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

export interface ApplyEditOptions extends EditMatchOptions {
	replaceAll?: boolean;
}

function resolveMatchOptions(options: EditMatchOptions): Required<EditMatchOptions> {
	return {
		allowFuzzy: options.allowFuzzy ?? true,
		fuzzyThreshold: options.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD,
	};
}

export function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	const aLen = a.length;
	const bLen = b.length;
	if (aLen === 0) return bLen;
	if (bLen === 0) return aLen;

	let previous = new Array<number>(bLen + 1);
	let current = new Array<number>(bLen + 1);
	for (let j = 0; j <= bLen; j++) {
		previous[j] = j;
	}

	for (let i = 1; i <= aLen; i++) {
		current[0] = i;
		const aCode = a.charCodeAt(i - 1);
		for (let j = 1; j <= bLen; j++) {
			const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
		}
		const nextPrevious = current;
		current = previous;
		previous = nextPrevious;
	}

	return previous[bLen];
}

export function similarity(a: string, b: string): number {
	if (a.length === 0 && b.length === 0) return 1;
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	return 1 - levenshteinDistance(a, b) / maxLen;
}

export function computeLineOffsets(lines: string[]): number[] {
	const offsets: number[] = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		offsets.push(offset);
		offset += lines[i].length;
		if (i < lines.length - 1) offset += 1;
	}
	return offsets;
}

function countLeadingWhitespace(line: string): number {
	let count = 0;
	for (const char of line) {
		if (char !== " " && char !== "\t") break;
		count += char === "\t" ? 4 : 1;
	}
	return count;
}

function computeRelativeIndentDepths(lines: string[]): number[] {
	const indents = lines.map(countLeadingWhitespace);
	const nonEmptyIndents = lines
		.map((line, index) => (line.trim().length > 0 ? indents[index] : undefined))
		.filter((indent): indent is number => indent !== undefined);
	const minIndent = nonEmptyIndents.length > 0 ? Math.min(...nonEmptyIndents) : 0;
	const indentSteps = nonEmptyIndents.map((indent) => indent - minIndent).filter((step) => step > 0);
	const indentUnit = indentSteps.length > 0 ? Math.min(...indentSteps) : 1;

	return lines.map((line, index) => {
		if (line.trim().length === 0 || indentUnit <= 0) return 0;
		return Math.round((indents[index] - minIndent) / indentUnit);
	});
}

export function normalizeLines(lines: string[], includeDepth = true): string[] {
	const indentDepths = includeDepth ? computeRelativeIndentDepths(lines) : undefined;
	return lines.map((line, index) => {
		const prefix = indentDepths ? `${indentDepths[index]}|` : "|";
		const trimmed = line.trim();
		return trimmed.length === 0 ? prefix : `${prefix}${normalizeForFuzzyMatch(trimmed)}`;
	});
}

interface BestFuzzyMatch {
	actualText: string;
	startIndex: number;
	startLine: number;
	confidence: number;
}

interface BestFuzzyMatchResult {
	best?: BestFuzzyMatch;
	aboveThresholdCount: number;
	secondBestScore: number;
}

function findBestFuzzyMatchCore(
	contentLines: string[],
	targetLines: string[],
	offsets: number[],
	threshold: number,
	includeDepth: boolean,
): BestFuzzyMatchResult {
	const targetNormalized = normalizeLines(targetLines, includeDepth);
	let best: BestFuzzyMatch | undefined;
	let bestScore = -1;
	let secondBestScore = -1;
	let aboveThresholdCount = 0;

	for (let start = 0; start <= contentLines.length - targetLines.length; start++) {
		const windowLines = contentLines.slice(start, start + targetLines.length);
		const windowNormalized = normalizeLines(windowLines, includeDepth);
		let score = 0;
		for (let i = 0; i < targetLines.length; i++) {
			score += similarity(targetNormalized[i], windowNormalized[i]);
		}
		score /= targetLines.length;

		if (score >= threshold) {
			aboveThresholdCount++;
		}
		if (score > bestScore) {
			secondBestScore = bestScore;
			bestScore = score;
			best = {
				actualText: windowLines.join("\n"),
				startIndex: offsets[start],
				startLine: start + 1,
				confidence: score,
			};
		} else if (score > secondBestScore) {
			secondBestScore = score;
		}
	}

	return { best, aboveThresholdCount, secondBestScore };
}

export function findBestFuzzyMatch(content: string, target: string, threshold: number): BestFuzzyMatchResult {
	const contentLines = content.split("\n");
	const targetLines = target.split("\n");
	if (target.length === 0 || targetLines.length > contentLines.length) {
		return { aboveThresholdCount: 0, secondBestScore: 0 };
	}

	const offsets = computeLineOffsets(contentLines);
	let result = findBestFuzzyMatchCore(contentLines, targetLines, offsets, threshold, true);
	if (result.best && result.best.confidence < threshold && result.best.confidence >= FALLBACK_THRESHOLD) {
		const noDepthResult = findBestFuzzyMatchCore(contentLines, targetLines, offsets, threshold, false);
		if (noDepthResult.best && noDepthResult.best.confidence > result.best.confidence) {
			result = noDepthResult;
		}
	}

	return result;
}

function emptyMatch(content: string, error?: Error): FuzzyMatchResult {
	return {
		found: false,
		index: -1,
		matchLength: 0,
		usedFuzzyMatch: false,
		contentForReplacement: content,
		error,
	};
}

function getFuzzyMatchError(path: string, oldText: string, best: BestFuzzyMatch, threshold: number, count: number): Error {
	const thresholdPercent = Math.round(threshold * 100);
	const similarityPercent = Math.round(best.confidence * 100);
	if (count > 1) {
		return new Error(
			`Could not find a unique fuzzy match in ${path}.\nFound ${count} high-confidence matches above ${thresholdPercent}%.\nClosest match was ${similarityPercent}% similar at line ${best.startLine}.\nPlease provide more surrounding context.`,
		);
	}
	return new Error(
		`Could not find a close enough match in ${path}.\nClosest match was ${similarityPercent}% similar at line ${best.startLine}.\nClosest match was below the ${thresholdPercent}% similarity threshold.`,
	);
}

/**
 * Find oldText in content, trying exact match, normalized substring matching,
 * then line-window fuzzy matching. Exact offsets always refer to original
 * content. Normalized substring offsets refer to normalized content.
 */
export function fuzzyFindText(content: string, oldText: string, path = "file", options: EditMatchOptions = {}): FuzzyMatchResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	const matchOptions = resolveMatchOptions(options);
	if (!matchOptions.allowFuzzy) {
		return emptyMatch(
			content,
			new Error(`Could not find the exact text in ${path}. Fuzzy matching is disabled.`),
		);
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex !== -1) {
		return {
			found: true,
			index: fuzzyIndex,
			matchLength: fuzzyOldText.length,
			usedFuzzyMatch: true,
			contentForReplacement: fuzzyContent,
		};
	}

	const threshold = matchOptions.fuzzyThreshold;
	const { best, aboveThresholdCount, secondBestScore } = findBestFuzzyMatch(content, oldText, threshold);
	if (!best) {
		return emptyMatch(content);
	}

	const dominant =
		aboveThresholdCount > 1 &&
		best.confidence >= DOMINANT_FUZZY_MIN_CONFIDENCE &&
		best.confidence - secondBestScore >= DOMINANT_FUZZY_DELTA;
	if (best.confidence >= threshold && (aboveThresholdCount === 1 || dominant)) {
		return {
			found: true,
			index: best.startIndex,
			matchLength: best.actualText.length,
			usedFuzzyMatch: true,
			contentForReplacement: content,
		};
	}

	return emptyMatch(content, getFuzzyMatchError(path, oldText, best, threshold, aboveThresholdCount));
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function countLiteralOccurrences(content: string, oldText: string): number {
	if (oldText.length === 0) return 0;
	let count = 0;
	let index = content.indexOf(oldText);
	while (index !== -1) {
		count++;
		index = content.indexOf(oldText, index + oldText.length);
	}
	return count;
}

function countOccurrences(content: string, oldText: string, options: EditMatchOptions): number {
	const exactOccurrences = countLiteralOccurrences(content, oldText);
	if (exactOccurrences > 0 || resolveMatchOptions(options).allowFuzzy === false) {
		return exactOccurrences;
	}
	return countLiteralOccurrences(normalizeForFuzzyMatch(content), normalizeForFuzzyMatch(oldText));
}

function findAllMatches(content: string, oldText: string, path: string, options: EditMatchOptions): FuzzyMatchResult[] {
	const matches: FuzzyMatchResult[] = [];
	let index = content.indexOf(oldText);
	while (index !== -1) {
		matches.push({
			found: true,
			index,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		});
		index = content.indexOf(oldText, index + oldText.length);
	}
	if (matches.length > 0) {
		return matches;
	}

	if (!resolveMatchOptions(options).allowFuzzy) {
		return [emptyMatch(content, new Error(`Could not find the exact text in ${path}. Fuzzy matching is disabled.`))];
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	index = fuzzyContent.indexOf(fuzzyOldText);
	while (index !== -1) {
		matches.push({
			found: true,
			index,
			matchLength: fuzzyOldText.length,
			usedFuzzyMatch: true,
			contentForReplacement: fuzzyContent,
		});
		index = fuzzyContent.indexOf(fuzzyOldText, index + fuzzyOldText.length);
	}
	if (matches.length > 0) {
		return matches;
	}

	return [fuzzyFindText(content, oldText, path, options)];
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number, cause?: Error): Error {
	if (totalEdits === 1 && cause) return cause;
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	if (cause) {
		return new Error(`Could not apply edits[${editIndex}] in ${path}. ${cause.message}`);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space and then
 * overlays those line-level changes onto the original content so unchanged line
 * blocks keep their original bytes.
 */
export function applyEditToNormalizedContent(
	normalizedContent: string,
	edit: Edit,
	path: string,
	options: ApplyEditOptions = {},
): AppliedEditsResult {
	if (!options.replaceAll) {
		return applyEditsToNormalizedContent(normalizedContent, [edit], path, options);
	}

	const normalizedEdit = {
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	};
	if (normalizedEdit.oldText.length === 0) {
		throw getEmptyOldTextError(path, 0, 1);
	}

	const matches = findAllMatches(normalizedContent, normalizedEdit.oldText, path, options);
	if (matches.length === 0 || matches.some((match) => !match.found)) {
		throw getNotFoundError(path, 0, 1, matches.find((match) => match.error)?.error);
	}

	const usesNormalizedBase = matches.some((match) => match.contentForReplacement !== normalizedContent);
	const replacementBaseContent = usesNormalizedBase ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
	const matchedEdits = matches.map((match, index) => ({
		editIndex: index,
		matchIndex: match.index,
		matchLength: match.matchLength,
		newText: normalizedEdit.newText,
	}));

	const baseContent = normalizedContent;
	const newContent = usesNormalizedBase
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, 1);
	}

	return { baseContent, newContent };
}

export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
	options: EditMatchOptions = {},
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText, path, options));
	const usesNormalizedBase = initialMatches.some((match) => match.contentForReplacement !== normalizedContent);
	const replacementBaseContent = usesNormalizedBase ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const searchText = usesNormalizedBase ? normalizeForFuzzyMatch(edit.oldText) : edit.oldText;
		const matchResult = usesNormalizedBase
			? fuzzyFindText(replacementBaseContent, searchText, path, { ...options, allowFuzzy: false })
			: initialMatches[i];
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length, matchResult.error);
		}

		const occurrences = countOccurrences(replacementBaseContent, searchText, options);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const newContent = usesNormalizedBase
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
	options: EditMatchOptions = {},
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path, options);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
	options: ApplyEditOptions = {},
): Promise<EditDiffResult | EditDiffError> {
	if (!options.replaceAll) {
		return computeEditsDiff(path, [{ oldText, newText }], cwd, options);
	}

	const absolutePath = resolveToCwd(path, cwd);

	try {
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		const rawContent = await readFile(absolutePath, "utf-8");
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditToNormalizedContent(
			normalizedContent,
			{ oldText, newText },
			path,
			options,
		);

		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
