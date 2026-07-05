import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEditToolSettings } from "../src/settings.ts";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const previousAgentDir = process.env[ENV_AGENT_DIR];
let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-settings-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	if (previousAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = previousAgentDir;
	}
	await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	tempDirs = [];
});

describe("loadEditToolSettings", () => {
	it("defaults fuzzy matching to enabled", async () => {
		const cwd = await makeTempDir();
		process.env[ENV_AGENT_DIR] = await makeTempDir();

		expect(loadEditToolSettings(cwd)).toEqual({ allowFuzzy: true, fuzzyThreshold: 0.95 });
	});

	it("reads global settings that disable fuzzy matching", async () => {
		const cwd = await makeTempDir();
		const agentDir = await makeTempDir();
		process.env[ENV_AGENT_DIR] = agentDir;
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ piEdit: { fuzzyMatch: false } }), "utf-8");

		expect(loadEditToolSettings(cwd)).toEqual({ allowFuzzy: false, fuzzyThreshold: 0.95 });
	});

	it("lets project settings override global settings", async () => {
		const cwd = await makeTempDir();
		const agentDir = await makeTempDir();
		process.env[ENV_AGENT_DIR] = agentDir;
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ piEdit: { fuzzyMatch: false, fuzzyThreshold: 0.9 } }),
			"utf-8",
		);
		await mkdir(join(cwd, ".pi"));
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ piEdit: { fuzzyMatch: true, fuzzyThreshold: 0.97 } }),
			"utf-8",
		);

		expect(loadEditToolSettings(cwd)).toEqual({ allowFuzzy: true, fuzzyThreshold: 0.97 });
	});

	it("prefers piEdit settings over edit compatibility aliases", async () => {
		const cwd = await makeTempDir();
		process.env[ENV_AGENT_DIR] = await makeTempDir();
		await mkdir(join(cwd, ".pi"));
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ edit: { fuzzyMatch: false, fuzzyThreshold: 0.8 }, piEdit: { fuzzyMatch: true } }),
			"utf-8",
		);

		expect(loadEditToolSettings(cwd)).toEqual({ allowFuzzy: true, fuzzyThreshold: 0.8 });
	});
});
