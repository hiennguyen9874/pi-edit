import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_FUZZY_THRESHOLD } from "./edit-diff.ts";

export interface EditToolSettings {
	allowFuzzy: boolean;
	fuzzyThreshold: number;
}

type EditSettingsShape = {
	edit?: {
		fuzzyMatch?: unknown;
		fuzzyThreshold?: unknown;
	};
	piEdit?: {
		fuzzyMatch?: unknown;
		fuzzyThreshold?: unknown;
	};
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(path: string): EditSettingsShape {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!isRecord(parsed)) return {};
		return {
			edit: isRecord(parsed.edit) ? parsed.edit : undefined,
			piEdit: isRecord(parsed.piEdit) ? parsed.piEdit : undefined,
		};
	} catch {
		return {};
	}
}

function overlaySettings(base: EditSettingsShape, override: EditSettingsShape): EditSettingsShape {
	return {
		edit: { ...base.edit, ...override.edit },
		piEdit: { ...base.piEdit, ...override.piEdit },
	};
}

function readBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function readThreshold(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : undefined;
}

export function loadEditToolSettings(cwd: string): EditToolSettings {
	const globalSettings = readSettings(join(getAgentDir(), "settings.json"));
	const projectSettings = readSettings(join(cwd, ".pi", "settings.json"));
	const settings = overlaySettings(globalSettings, projectSettings);

	return {
		allowFuzzy: readBoolean(settings.piEdit?.fuzzyMatch) ?? readBoolean(settings.edit?.fuzzyMatch) ?? true,
		fuzzyThreshold:
			readThreshold(settings.piEdit?.fuzzyThreshold) ??
			readThreshold(settings.edit?.fuzzyThreshold) ??
			DEFAULT_FUZZY_THRESHOLD,
	};
}
