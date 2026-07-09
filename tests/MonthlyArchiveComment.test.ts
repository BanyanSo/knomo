import test from "node:test";
import assert from "node:assert/strict";
import { ensureObsidianStub } from "./helpers/obsidianStub";

test("creates monthly archive comments in the requested locale", async () => {
	await ensureObsidianStub();
	const { ensureReadOnlyComment, MONTHLY_ARCHIVE_MARKER } = await import("../src/services/MonthlyArchiveService");

	const english = ensureReadOnlyComment("# 2026-06", "en");
	const chinese = ensureReadOnlyComment("# 2026-06", "zh-CN");

	assert.equal(english.startsWith(`<!-- ${MONTHLY_ARCHIVE_MARKER}\nKnomo monthly archive file:`), true);
	assert.equal(chinese.startsWith(`<!-- ${MONTHLY_ARCHIVE_MARKER}\nKnomo 月度归档文件：`), true);
});

test("preserves existing localized and legacy comments without translation churn", async () => {
	await ensureObsidianStub();
	const {
		ensureReadOnlyComment,
		LEGACY_MONTHLY_ARCHIVE_READONLY_COMMENT,
	} = await import("../src/services/MonthlyArchiveService");
	const legacyContent = `${LEGACY_MONTHLY_ARCHIVE_READONLY_COMMENT}\n\n# 2026-06`;
	const chineseContent = ensureReadOnlyComment("# 2026-06", "zh-CN");

	assert.equal(ensureReadOnlyComment(legacyContent, "zh-CN"), legacyContent);
	assert.equal(ensureReadOnlyComment(chineseContent, "en"), chineseContent);
	assert.equal(ensureReadOnlyComment(chineseContent, "zh-CN"), chineseContent);
});

test("lists likely sync-conflict monthly archive files", async () => {
	await ensureObsidianStub();
	const { TFile, TFolder, Vault } = await import("obsidian");
	const { MonthlyArchiveService } = await import("../src/services/MonthlyArchiveService");
	const monthlyFolder = Object.assign(new TFolder(), {
		path: "Memos conflict",
		children: [] as unknown[],
	});
	const regularArchive = Object.assign(new TFile(), {
		path: "Memos conflict/Memos-2026-06.md",
		name: "Memos-2026-06.md",
		extension: "md",
	});
	const conflictArchive = Object.assign(new TFile(), {
		path: "Memos conflict/Memos-2026-06 conflict.md",
		name: "Memos-2026-06 conflict.md",
		extension: "md",
	});
	const unrelatedConflictFile = Object.assign(new TFile(), {
		path: "Memos conflict/project conflict 2026-07.md",
		name: "project conflict 2026-07.md",
		extension: "md",
	});
	const systemConflictArchive = Object.assign(new TFile(), {
		path: "Memos conflict/_knomo-system/Memos-2026-06 conflict.md",
		name: "Memos-2026-06 conflict.md",
		extension: "md",
	});
	const nestedSameNameConflictArchive = Object.assign(new TFile(), {
		path: "Memos conflict/Nested/Memos-2026-06 conflict.md",
		name: "Memos-2026-06 conflict.md",
		extension: "md",
	});
	monthlyFolder.children = [
		regularArchive,
		conflictArchive,
		unrelatedConflictFile,
		systemConflictArchive,
		nestedSameNameConflictArchive,
	];
	const originalRecurseChildren = Vault.recurseChildren;
	Vault.recurseChildren = ((folder: { children: unknown[] }, callback: (child: unknown) => void) => {
		for (const child of folder.children) {
			callback(child);
		}
	}) as typeof Vault.recurseChildren;
	try {
		const service = new MonthlyArchiveService({
			vault: {
				getAbstractFileByPath: (path: string) => path === monthlyFolder.path ? monthlyFolder : null,
			},
		} as never);

		assert.deepEqual(service.listPotentialSyncConflictFiles({
			monthlyMemoFolder: "Memos conflict",
			monthlyMemoFileFormat: "Memos-YYYY-MM.md",
		} as never), [{
			kind: "monthly-archive",
			path: conflictArchive.path,
			period: "2026-06",
		}]);
	} finally {
		Vault.recurseChildren = originalRecurseChildren;
	}
});
