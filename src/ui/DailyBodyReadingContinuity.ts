import type { TFile } from "obsidian";
import { createDailyMemoBodyProof, type DailyMemoBodyProof } from "../services/DailyMemoPresentationChange";
import { catalogObservationKey } from "../types/catalog";
import type { MemoViewItem } from "../types/memoView";
import { sha256Bytes } from "../utils/sha256";

interface ReadingBodyVersion extends DailyMemoBodyProof { revision: string }
interface ReadingFile {
	file: TFile;
	before: ReadingBodyVersion;
	after?: ReadingBodyVersion;
}

// 每个视图只跟踪当前视口少量 Daily 的正文证明，映射仅供几何和静态占位使用。
export class DailyBodyReadingContinuity {
	private readonly files = new Map<string, ReadingFile>();
	private captureRun = 0;

	clear(): void { this.captureRun++; this.files.clear(); }
	getRevision(path: string): string | undefined { return this.files.get(path)?.before.revision; }

	async capture(memos: readonly MemoViewItem[], getFile: (path: string) => TFile | null,
		read: (file: TFile) => Promise<string>, isCurrent: () => boolean): Promise<void> {
		const run = ++this.captureRun;
		const paths = new Map<string, string>();
		for (const memo of memos) {
			const handle = memo.catalog?.observationHandle;
			if (handle) paths.set(handle.sourcePath, handle.sourceRevision);
			if (paths.size === 8) break;
		}
		for (const path of this.files.keys()) if (!paths.has(path)) this.files.delete(path);
		for (const [path, revision] of paths) {
			const file = getFile(path);
			const known = this.files.get(path);
			if (!file || known?.file === file && known.before.revision === revision) continue;
			const content = await read(file);
			if (await sha256Bytes(new TextEncoder().encode(content)) !== revision) continue;
			const body = await createDailyMemoBodyProof(content);
			if (run !== this.captureRun || !isCurrent()) return;
			if (body && getFile(path) === file) this.files.set(path, { file, before: { ...body, revision } });
		}
	}

	async noteRevision(path: string, file: TFile | null, content: string | null, revision: string | null,
		isCurrent: () => boolean): Promise<ReadingBodyVersion | undefined> {
		const entry = this.files.get(path);
		if (!entry) return;
		if (file !== entry.file || content === null || revision === null) { this.files.delete(path); return; }
		const body = await createDailyMemoBodyProof(content);
		if (this.files.get(path) !== entry || !isCurrent()) return;
		entry.after = body && body.digest === entry.before.digest ? { ...body, revision } : undefined;
		return entry.after ? entry.before : undefined;
	}

	match(before: readonly MemoViewItem[], after: readonly MemoViewItem[]): Map<string, MemoViewItem | null> | undefined {
		if (![...this.files.values()].some(file => file.after)) return undefined;
		const byPosition = new Map(after.flatMap(memo => {
			const observation = memo.catalog?.observation;
			return observation ? [[observation.observationKey, memo] as const] : [];
		}));
		const changes = new Map<string, MemoViewItem | null>();
		for (const memo of before) {
			const old = memo.catalog?.observation, file = old && this.files.get(old.sourcePath);
			const nextBody = file?.after;
			if (!old || !file || !nextBody || file.before.revision !== old.sourceRevision || nextBody.revision === old.sourceRevision) continue;
			const shift = nextBody.startLine - file.before.startLine;
			const current = byPosition.get(catalogObservationKey({ sourcePath: old.sourcePath, startLine: old.startLine + shift }));
			const next = current?.catalog?.observation;
			if (current && next?.sourceRevision === nextBody.revision && old.endLine + shift === next.endLine
				&& old.rawBlockHash === next.rawBlockHash && old.logicalDate === next.logicalDate && old.time === next.time
				&& old.section === next.section && old.content === next.content) changes.set(memo.id, current);
		}
		return changes.size ? changes : undefined;
	}
}
