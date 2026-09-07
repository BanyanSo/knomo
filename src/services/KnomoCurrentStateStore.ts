import { TFile, normalizePath } from "obsidian";
import type { App } from "obsidian";
import { ensureFolder } from "../utils/vault";
import { canonicalIdentityLedgerJson, sha256IdentityLedgerText } from "./IdentityLedgerProtocol";
import { isRecord } from "../utils/object";

interface StateImage { generation: number; value: unknown; digest: string; }

/** 两个固定槽位保存当前状态。先验证新槽，再刷新旧槽，不累积历史文件。 */
export class KnomoCurrentStateStore {
	private queue: Promise<void> = Promise.resolve();
	constructor(private readonly app: App, private readonly getRoot: () => string | null,
		private readonly relativeRoot = "_knomo-data/state", private readonly signal?: AbortSignal) {}

	async getMeta<T>(key: string): Promise<T | null> {
		await this.queue;
		return (await this.read(key))?.value as T | null ?? null;
	}

	async getMetaValues<T>(key: string): Promise<T[]> {
		const value = await this.getMeta<T>(key);
		return value === null ? [] : [value];
	}

	setMeta(key: string, value: unknown): Promise<void> {
		const operation = this.queue.then(() => this.write(key, value));
		this.queue = operation.catch(() => undefined);
		return operation;
	}

	deleteMeta(key: string): Promise<void> { return this.setMeta(key, null); }

	private paths(key: string): string[] {
		if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key)) throw new Error("Invalid Knomo state key.");
		const root = this.getRoot();
		if (root === null) throw new Error("Knomo state root is not configured.");
		return ["a", "b"].map((slot) => normalizePath(`${root}/${this.relativeRoot}/${key}.${slot}.json`));
	}

	private async read(key: string): Promise<StateImage | null> {
		const images: StateImage[] = [];
		let errors = 0;
		for (const path of this.paths(key)) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file === null) continue;
			try {
				if (!(file instanceof TFile)) throw new Error("State path is not a file.");
				const image: unknown = JSON.parse(await this.app.vault.read(file));
				if (!isRecord(image) || !Number.isSafeInteger(image.generation) || Number(image.generation) < 1
					|| typeof image.digest !== "string" || !("value" in image)
					|| await sha256IdentityLedgerText(canonicalIdentityLedgerJson({ generation: image.generation, value: image.value })) !== image.digest) {
					throw new Error("Invalid Knomo state image.");
				}
				images.push(image as unknown as StateImage);
			} catch { errors += 1; }
		}
		if (images.length === 0 && errors > 0) throw new Error(`Knomo current state cannot be read: ${key}`);
		images.sort((a, b) => b.generation - a.generation);
		if (images.length === 2 && images[0]!.generation === images[1]!.generation && images[0]!.digest !== images[1]!.digest) {
			throw new Error(`Conflicting Knomo current state: ${key}`);
		}
		return images[0] ?? null;
	}

	private async write(key: string, value: unknown): Promise<void> {
		const root = this.getRoot();
		const assertActive = () => {
			if (this.signal?.aborted || this.getRoot() !== root) throw new Error("Knomo state write was cancelled.");
		};
		assertActive();
		const current = await this.read(key);
		if (current === null && value === null) return;
		const generation = (current?.generation ?? 0) + 1;
		const semantic = { generation, value };
		const image: StateImage = { ...semantic, digest: await sha256IdentityLedgerText(canonicalIdentityLedgerJson(semantic)) };
		const content = canonicalIdentityLedgerJson(image);
		const paths = this.paths(key);
		// 交替首写槽位，任何中断都至少留下上一份经过验证的数据。
		if (generation % 2 === 0) paths.reverse();
		for (const path of paths) {
			assertActive();
			await ensureFolder(this.app, path.slice(0, path.lastIndexOf("/")));
			assertActive();
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const expected = await this.app.vault.read(file);
				await this.app.vault.process(file, (actual) => {
					assertActive();
					if (actual !== expected) throw new Error(`Knomo state changed during write: ${key}`);
					return content;
				});
			}
			else if (file === null) await this.app.vault.create(path, content);
			else throw new Error(`State path is not a file: ${path}`);
			const written = this.app.vault.getAbstractFileByPath(path);
			if (!(written instanceof TFile) || await this.app.vault.read(written) !== content) {
				throw new Error(`Knomo current state verification failed: ${key}`);
			}
		}
	}
}
