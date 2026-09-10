import test from "node:test";
import assert from "node:assert/strict";

import type { TFile, Workspace } from "obsidian";

import {
	buildDailyNoteOpenState,
	type MemoDailyNoteRef,
	openMemoDailyNoteDefault,
	openMemoDailyNoteInNewTab,
} from "../src/ui/memoDailyNoteOpen";

test("builds daily note open state from optional line hints", () => {
	assert.deepEqual(buildDailyNoteOpenState(null), { active: true });
	assert.deepEqual(buildDailyNoteOpenState(1), { active: true, eState: { line: 0 } });
	assert.deepEqual(buildDailyNoteOpenState(8), { active: true, eState: { line: 7 } });
	assert.deepEqual(buildDailyNoteOpenState(0), { active: true, eState: { line: 0 } });
});

test("opens memo daily note with the default pane behavior and falls back when the line hint fails", async () => {
	const memo = makeMemoDailyNoteRef(12);
	const openCalls: Array<{ linktext: string; sourcePath: string; newLeaf: unknown; state: unknown }> = [];
	const workspace = {
		openLinkText: async (linktext: string, sourcePath: string, newLeaf: unknown, state: unknown): Promise<void> => {
			openCalls.push({ linktext, sourcePath, newLeaf, state });
			if (openCalls.length === 1) {
				throw new Error("Line unavailable");
			}
		},
	} as unknown as Workspace;

	await openMemoDailyNoteDefault(workspace, memo);

	assert.deepEqual(openCalls, [
		{
			linktext: "Daily/2026-06-02.md",
			sourcePath: "",
			newLeaf: false,
			state: { active: true, eState: { line: 11 } },
		},
		{
			linktext: "Daily/2026-06-02.md",
			sourcePath: "",
			newLeaf: false,
			state: { active: true },
		},
	]);
});

test("opens memo daily note with the default pane behavior without line state when no hint exists", async () => {
	const memo = makeMemoDailyNoteRef(null);
	const openCalls: Array<{ linktext: string; sourcePath: string; newLeaf: unknown; state: unknown }> = [];
	const workspace = {
		openLinkText: async (linktext: string, sourcePath: string, newLeaf: unknown, state: unknown): Promise<void> => {
			openCalls.push({ linktext, sourcePath, newLeaf, state });
		},
	} as unknown as Workspace;

	await openMemoDailyNoteDefault(workspace, memo);

	assert.deepEqual(openCalls, [
		{
			linktext: "Daily/2026-06-02.md",
			sourcePath: "",
			newLeaf: false,
			state: { active: true },
		},
	]);
});

test("opens memo daily note in a new tab and falls back when the line hint fails", async () => {
	const file = { path: "Daily/2026-06-02.md" } as TFile;
	const leafKinds: unknown[] = [];
	const openCalls: Array<{ file: TFile; state: unknown }> = [];
	const workspace = {
		getLeaf: (newLeaf: "tab") => {
			leafKinds.push(newLeaf);
			return {
				openFile: async (openedFile: TFile, state: unknown): Promise<void> => {
					openCalls.push({ file: openedFile, state });
					if (openCalls.length === 1) {
						throw new Error("Line unavailable");
					}
				},
			};
		},
	} as unknown as Workspace;

	await openMemoDailyNoteInNewTab(workspace, file, 12);

	assert.deepEqual(leafKinds, ["tab"]);
	assert.deepEqual(openCalls, [
		{ file, state: { active: true, eState: { line: 11 } } },
		{ file, state: { active: true } },
	]);
});

test("opens memo daily note in a new tab without line state when no hint exists", async () => {
	const file = { path: "Daily/2026-06-02.md" } as TFile;
	const leafKinds: unknown[] = [];
	const openCalls: Array<{ file: TFile; state: unknown }> = [];
	const workspace = {
		getLeaf: (newLeaf: "tab") => {
			leafKinds.push(newLeaf);
			return {
				openFile: async (openedFile: TFile, state: unknown): Promise<void> => {
					openCalls.push({ file: openedFile, state });
				},
			};
		},
	} as unknown as Workspace;

	await openMemoDailyNoteInNewTab(workspace, file, null);

	assert.deepEqual(leafKinds, ["tab"]);
	assert.deepEqual(openCalls, [
		{ file, state: { active: true } },
	]);
});

function makeMemoDailyNoteRef(lineNumberHint: number | null): MemoDailyNoteRef {
	return {
		dailyRef: {
			path: "Daily/2026-06-02.md",
			heading: null,
			lineNumberHint,
		},
	};
}
