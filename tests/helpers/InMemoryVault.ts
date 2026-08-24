import { TFile, TFolder } from "obsidian";
import type { App, TAbstractFile } from "obsidian";

export class InMemoryVault {
	private readonly files = new Map<string, TAbstractFile>();
	private readonly contents = new Map<string, string>();
	readonly app: App;

	constructor(initialFiles: Readonly<Record<string, string>> = {}) {
		const adapter = {
			exists: async (path: string) => this.files.has(path),
			read: async (path: string) => this.contents.get(path) ?? "",
			readBinary: async (path: string) => new TextEncoder().encode(this.contents.get(path) ?? "").buffer,
			stat: async (path: string) => {
				const file = this.files.get(path);
				return file instanceof TFile ? file.stat : null;
			},
		};
		const vault = {
			configDir: ".obsidian",
			adapter,
			getFiles: () => [...this.files.values()].filter((file): file is TFile => file instanceof TFile),
			getMarkdownFiles: () => [...this.files.values()].filter((file): file is TFile =>
				file instanceof TFile && file.extension.toLowerCase() === "md"),
			getAbstractFileByPath: (path: string) => this.files.get(path) ?? null,
			createFolder: async (path: string) => { this.ensureFolderRecord(path); },
			create: async (path: string, content: string) => {
				if (this.files.has(path)) throw new Error(`exists:${path}`);
				return this.putFile(path, content);
			},
			cachedRead: async (file: TFile) => this.contents.get(file.path) ?? "",
			read: async (file: TFile) => this.contents.get(file.path) ?? "",
			readBinary: async (file: TFile) => new TextEncoder().encode(this.contents.get(file.path) ?? "").buffer,
			process: async (file: TFile, update: (content: string) => string) => {
				const next = update(this.contents.get(file.path) ?? "");
				this.contents.set(file.path, next);
				file.stat = { ...file.stat, mtime: file.stat.mtime + 1, size: new TextEncoder().encode(next).byteLength };
				return next;
			},
		} as unknown as App["vault"];
		this.app = { vault } as App;
		for (const [path, content] of Object.entries(initialFiles)) this.putFile(path, content);
	}

	read(path: string): string | null {
		return this.contents.get(path) ?? null;
	}

	paths(): string[] {
		return [...this.contents.keys()].sort();
	}

	snapshot(): Record<string, string> {
		return Object.fromEntries(this.paths().map((path) => [path, this.contents.get(path) ?? ""]));
	}

	deliverFrom(source: InMemoryVault, paths: readonly string[] = source.paths()): void {
		for (const path of paths) {
			const content = source.read(path);
			if (content === null) continue;
			const current = this.read(path);
			if (current !== null && current !== content) throw new Error(`replica_path_collision:${path}`);
			if (current === null) this.putFile(path, content);
		}
	}

	remove(path: string): void {
		this.files.delete(path);
		this.contents.delete(path);
	}

	replace(path: string, content: string): void {
		if (!(this.files.get(path) instanceof TFile)) throw new Error(`missing:${path}`);
		this.contents.set(path, content);
		const file = this.files.get(path) as TFile;
		file.stat = { ...file.stat, mtime: file.stat.mtime + 1, size: new TextEncoder().encode(content).byteLength };
	}

	private putFile(path: string, content: string): TFile {
		this.ensureParents(path);
		const name = path.split("/").at(-1) ?? path;
		const file = Object.assign(new TFile(), {
			path,
			name,
			basename: name.replace(/\.[^.]+$/u, ""),
			extension: name.includes(".") ? name.split(".").at(-1) ?? "" : "",
			stat: { ctime: 1, mtime: 1, size: new TextEncoder().encode(content).byteLength },
		});
		this.files.set(path, file);
		this.contents.set(path, content);
		this.addToParent(path, file);
		return file;
	}

	private ensureParents(path: string): void {
		const segments = path.split("/").slice(0, -1);
		let current = "";
		for (const segment of segments) {
			current = current.length === 0 ? segment : `${current}/${segment}`;
			this.ensureFolderRecord(current);
		}
	}

	private ensureFolderRecord(path: string): void {
		const current = this.files.get(path);
		if (current instanceof TFolder) return;
		if (current !== undefined) throw new Error(`not_folder:${path}`);
		const folder = Object.assign(new TFolder(), {
			path,
			name: path.split("/").at(-1) ?? path,
			children: [] as TAbstractFile[],
		});
		this.files.set(path, folder);
		this.addToParent(path, folder);
	}

	private addToParent(path: string, child: TAbstractFile): void {
		const separator = path.lastIndexOf("/");
		if (separator < 0) return;
		const parent = this.files.get(path.slice(0, separator));
		if (parent instanceof TFolder && !parent.children.includes(child)) parent.children.push(child);
	}
}
