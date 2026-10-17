import type { CatalogMemoItem } from "../../src/types/catalogView";
import type { CatalogObservation } from "../../src/types/catalog";
import { toCatalogMemoView } from "../../src/types/memoView";
import { createCatalogCapabilities, createResolvedMemoCapabilities } from "../../src/services/MemoCapabilityModel";

export function createReferenceMemo(existingBlockId: string | null = null) {
	const observation: CatalogObservation = {
		sourcePath: "Daily/2026-10-16.md", sourceRevision: "revision", startLine: 2, endLine: 2, rawBlockHash: "raw",
		occurrenceIndex: 0, occurrenceCount: 1, logicalDate: "2026-10-16", section: "## Memos", time: "09:00",
		content: "memo [[Other#^their-anchor|custom alias]]", contentHash: "content", existingBlockId,
		tags: [], links: [], images: [], tasks: [], timeBuoyDates: [], observationKey: "observation", createdAtKey: "2026-10-16T09:00:00",
		searchBody: ["memo"], searchTokens: ["memo"], tagKeys: [], linkTargets: [], imagePaths: [], explicitReferenceTargets: [],
		hasLink: 1, hasImage: 0, hasTask: 0, hasTimeBuoy: 0,
	};
	const resolved = { kind: "observation" as const, observation, capabilities: createResolvedMemoCapabilities() };
	const item: CatalogMemoItem = {
		key: "memo", renderKey: "memo", observationHandle: { sourcePath: observation.sourcePath, sourceRevision: observation.sourceRevision,
			startLine: observation.startLine, endLine: observation.endLine, rawBlockHash: observation.rawBlockHash },
		createdAt: "2026-10-16T09:00", content: observation.content, tags: [], links: [], images: [], tasks: [], timeBuoyDates: [],
		sourcePath: observation.sourcePath, lineNumberHint: 3, observation, resolved,
		capabilities: { ...resolved.capabilities, catalog: createCatalogCapabilities({ kind: "complete", coveredFromDate: "2026-10-16",
			pendingFileCount: 0, coveredFileCount: 1, totalFileCount: 1 }) },
	};
	return toCatalogMemoView(item);
}
