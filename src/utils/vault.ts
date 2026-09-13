import { normalizePath, TFile, TFolder } from "obsidian";
import type { App } from "obsidian";

const folderCreationTails = new WeakMap<object, Promise<void>>();
const folderVisibilityRetryDelaysMs = [0, 10, 25, 50, 100, 200, 400, 800] as const;

export function ensureFolder(app: App, folderPath: string): Promise<void> {
	const previous = folderCreationTails.get(app.vault) ?? Promise.resolve();
	const operation = previous
		.catch(() => undefined)
		.then(() => ensureFolderOnce(app, folderPath));
	folderCreationTails.set(app.vault, operation.catch(() => undefined));
	return operation;
}

async function ensureFolderOnce(app: App, folderPath: string): Promise<void> {
	const normalizedPath = normalizePath(folderPath);
	if (normalizedPath === "" || normalizedPath === "/") {
		return;
	}

	const segments = normalizedPath.split("/");
	let currentPath = "";
	for (const segment of segments) {
		currentPath = currentPath.length === 0 ? segment : `${currentPath}/${segment}`;
		const existing = app.vault.getAbstractFileByPath(currentPath);
		if (existing instanceof TFolder) {
			continue;
		}
		if (existing !== null) {
			throw new Error(`Path exists and is not a folder: ${currentPath}`);
		}
		try {
			await app.vault.createFolder(currentPath);
			continue;
		} catch (error) {
			if (await waitForFolderVisibility(app, currentPath)) continue;
			throw error;
		}
	}
}

async function waitForFolderVisibility(app: App, folderPath: string): Promise<boolean> {
	for (const delayMs of folderVisibilityRetryDelaysMs) {
		if (delayMs > 0) await delay(delayMs);
		const existing = app.vault.getAbstractFileByPath(folderPath);
		if (existing instanceof TFolder) return true;
		if (existing !== null) throw new Error(`Path exists and is not a folder: ${folderPath}`);
	}
	return false;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

export async function ensureTextFile(app: App, filePath: string): Promise<TFile> {
	const normalizedPath = normalizePath(filePath);
	const existing = app.vault.getAbstractFileByPath(normalizedPath);
	if (existing instanceof TFile) {
		return existing;
	}
	if (existing !== null) {
		throw new Error(`Path exists and is not a file: ${normalizedPath}`);
	}

	const parentFolder = getParentFolderPath(normalizedPath);
	if (parentFolder !== null) {
		await ensureFolder(app, parentFolder);
	}

	try {
		return await app.vault.create(normalizedPath, "");
	} catch (error) {
		const nextExisting = app.vault.getAbstractFileByPath(normalizedPath);
		if (nextExisting instanceof TFile) {
			return nextExisting;
		}
		throw error;
	}
}

export function getParentFolderPath(filePath: string): string | null {
	const normalizedPath = normalizePath(filePath);
	const separatorIndex = normalizedPath.lastIndexOf("/");
	if (separatorIndex === -1) {
		return null;
	}
	return normalizedPath.slice(0, separatorIndex);
}
