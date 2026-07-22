import test from "node:test";
import assert from "node:assert/strict";

import { AttachmentService } from "../src/services/AttachmentService";

test("AttachmentService creates image embed links through Obsidian attachment APIs", async () => {
	const createdAttachments: Array<{ path: string; data: string }> = [];
	const requestedPaths: Array<{ name: string; sourcePath: string }> = [];
	const service = new AttachmentService({
		fileManager: {
			getAvailablePathForAttachment: async (name: string, sourcePath: string) => {
				requestedPaths.push({ name, sourcePath });
				return `Attachments/${name}`;
			},
			generateMarkdownLink: (attachment: { path: string }, sourcePath: string) => {
				return `[[${attachment.path}|${sourcePath}]]`;
			},
		},
		vault: {
			createBinary: async (path: string, data: ArrayBuffer) => {
				createdAttachments.push({
					path,
					data: new TextDecoder().decode(data),
				});
				return { path };
			},
		},
	} as never);

	const links = await service.createImageEmbedLinks("Daily/2026-06-02.md", [
		createTestFile("first.png", "first-data"),
		createTestFile("second.jpg", "second-data"),
	]);

	assert.deepEqual(requestedPaths, [
		{ name: "first.png", sourcePath: "Daily/2026-06-02.md" },
		{ name: "second.jpg", sourcePath: "Daily/2026-06-02.md" },
	]);
	assert.deepEqual(createdAttachments, [
		{ path: "Attachments/first.png", data: "first-data" },
		{ path: "Attachments/second.jpg", data: "second-data" },
	]);
	assert.deepEqual(links, [
		"![[Attachments/first.png|Daily/2026-06-02.md]]",
		"![[Attachments/second.jpg|Daily/2026-06-02.md]]",
	]);
});

test("AttachmentService trashes attachments created earlier in a failed batch", async () => {
	const trashedPaths: string[] = [];
	let createCount = 0;
	const service = new AttachmentService({
		fileManager: {
			getAvailablePathForAttachment: async (name: string) => `Attachments/${name}`,
			generateMarkdownLink: (attachment: { path: string }) => `[[${attachment.path}]]`,
			trashFile: async (attachment: { path: string }) => {
				trashedPaths.push(attachment.path);
			},
		},
		vault: {
			createBinary: async (path: string) => {
				createCount += 1;
				if (createCount === 2) {
					throw new Error("disk full");
				}
				return { path };
			},
		},
	} as never);

	await assert.rejects(
		service.createImageEmbedLinks("Daily/2026-06-02.md", [
			createTestFile("first.png", "first-data"),
			createTestFile("second.png", "second-data"),
		]),
		/disk full/,
	);
	assert.deepEqual(trashedPaths, ["Attachments/first.png"]);
});

test("AttachmentService continues rollback after one attachment cannot be trashed", async () => {
	const trashAttempts: string[] = [];
	let createCount = 0;
	const service = new AttachmentService({
		fileManager: {
			getAvailablePathForAttachment: async (name: string) => `Attachments/${name}`,
			generateMarkdownLink: (attachment: { path: string }) => `[[${attachment.path}]]`,
			trashFile: async (attachment: { path: string }) => {
				trashAttempts.push(attachment.path);
				if (attachment.path.endsWith("second.png")) {
					throw new Error("trash unavailable");
				}
			},
		},
		vault: {
			createBinary: async (path: string) => {
				createCount += 1;
				if (createCount === 3) {
					throw new Error("disk full");
				}
				return { path };
			},
		},
	} as never);

	await assert.rejects(
		service.createImageEmbedLinks("Daily/2026-06-02.md", [
			createTestFile("first.png", "first-data"),
			createTestFile("second.png", "second-data"),
			createTestFile("third.png", "third-data"),
		]),
		(error: unknown) => {
			assert.equal(error instanceof Error, true);
			assert.match((error as Error).message, /disk full/);
			assert.match((error as Error).message, /Attachments\/second\.png/);
			return true;
		},
	);
	assert.deepEqual(trashAttempts, ["Attachments/second.png", "Attachments/first.png"]);
});

function createTestFile(name: string, content: string): File {
	return {
		name,
		arrayBuffer: async () => new TextEncoder().encode(content).buffer,
	} as File;
}
