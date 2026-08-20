import { normalizePath, TFile } from "obsidian";
import type { App } from "obsidian";

import type { ArtifactRef, DeletedMemoPayload } from "../types/catalogV2";
import { getCatalogDeletedPayloadPath, getCatalogDeletedRootPath } from "../utils/path";
import { ensureFolder, getParentFolderPath } from "../utils/vault";
import {
	parseDeletedMemoPayload,
	serializeDeletedMemoPayload,
	sha256Bytes,
} from "./CatalogV2Protocol";

export class CatalogV2DeletedPayloadStore {
	constructor(
		private readonly app: App,
		private readonly catalogDataRoot: string | (() => string),
	) {}

	async write(payload: DeletedMemoPayload): Promise<ArtifactRef> {
		const path = this.getPayloadPath(payload.memoId, payload.deleteOpId);
		const bytes = serializeDeletedMemoPayload(payload);
		let file = this.app.vault.getAbstractFileByPath(path);
		if (file === null) {
			const parent = getParentFolderPath(path);
			if (parent !== null) await ensureFolder(this.app, parent);
			try {
				file = await this.app.vault.create(path, new TextDecoder().decode(bytes));
			} catch (error) {
				file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) throw error;
			}
		}
		if (!(file instanceof TFile)) throw new Error(`Deleted payload path is not a file: ${path}`);
		const actual = new Uint8Array(await this.app.vault.readBinary(file));
		if (!equalBytes(actual, bytes)) throw new Error(`Immutable deleted payload collision: ${path}`);
		parseDeletedMemoPayload(path, actual);
		return { path, sha256: await sha256Bytes(actual), byteLength: actual.byteLength };
	}

	async read(reference: ArtifactRef): Promise<DeletedMemoPayload> {
		const path = normalizePath(reference.path);
		this.assertPayloadPath(path);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error(`Deleted payload is missing: ${path}`);
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		if (bytes.byteLength !== reference.byteLength || await sha256Bytes(bytes) !== reference.sha256) {
			throw new Error(`Deleted payload reference mismatch: ${path}`);
		}
		return parseDeletedMemoPayload(path, bytes);
	}

	async trashIfPresent(payloadPath: string): Promise<boolean> {
		const path = normalizePath(payloadPath);
		this.assertPayloadPath(path);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file === null) return false;
		if (!(file instanceof TFile)) throw new Error(`Deleted payload path is not a file: ${path}`);
		await this.app.fileManager.trashFile(file);
		return true;
	}

	getPayloadPath(memoId: string, deleteOpId: string): string {
		if (!/^[^/\\\u0000-\u001f]+$/u.test(memoId) || !/^(?:o_[a-f0-9]{32}|l_[a-f0-9]{64})$/u.test(deleteOpId)) {
			throw new Error("Invalid deleted payload identity.");
		}
		return getCatalogDeletedPayloadPath(this.resolveCatalogDataRoot(), memoId, deleteOpId);
	}

	private assertPayloadPath(path: string): void {
		const root = getCatalogDeletedRootPath(this.resolveCatalogDataRoot());
		if (!path.startsWith(`${root}/`) || path.slice(root.length + 1).split("/").length !== 2) {
			throw new Error(`Deleted payload path is outside the Catalog deleted root: ${path}`);
		}
	}

	private resolveCatalogDataRoot(): string {
		return normalizePath((typeof this.catalogDataRoot === "function"
			? this.catalogDataRoot()
			: this.catalogDataRoot).replace(/\/$/u, ""));
	}
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
