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

function createTestFile(name: string, content: string): File {
	return {
		name,
		arrayBuffer: async () => new TextEncoder().encode(content).buffer,
	} as File;
}
