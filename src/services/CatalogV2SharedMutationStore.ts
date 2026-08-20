import { normalizePath, TFile } from "obsidian";
import type { App } from "obsidian";

import type { ArtifactRef, IdentityEvidence } from "../types/catalogV2";
import type {
	CatalogV2MutationAbandonArtifact,
	CatalogV2MutationCommitArtifact,
	CatalogV2MutationPrepareArtifact,
	CatalogV2SharedMutationInspection,
	CatalogV2SharedMutationInspectionIssue,
	CatalogV2SharedMutationRecord,
	CatalogV2ControlPermit,
	CatalogV2VerifiedVaultContext,
} from "../types/catalogV2Protocol";
import { isRecord } from "../utils/object";
import {
	getCatalogMutationAbandonPath,
	getCatalogMutationCommitPath,
	getCatalogMutationPreparePath,
	getCatalogMutationsRootPath,
} from "../utils/path";
import { canonicalJson, canonicalJsonFileBytes, sha256Bytes, sha256Text } from "./CatalogV2Protocol";
import type { CatalogV2VaultProtocol } from "./CatalogV2VaultProtocol";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const WRITER_ID_PATTERN = /^w_[a-f0-9]{32}$/u;
const OP_ID_PATTERN = /^o_[a-f0-9]{32}$/u;
const MEMO_ID_PATTERN = /^[^/\\\u0000-\u001f]+$/u;

export class CatalogV2SharedMutationStore {
	constructor(
		private readonly app: App,
		private readonly protocol: CatalogV2VaultProtocol,
		private readonly getContext: () => CatalogV2VerifiedVaultContext | null | Promise<CatalogV2VerifiedVaultContext | null>,
	) {}

	async prepare(value: CatalogV2MutationPrepareArtifact): Promise<ArtifactRef> {
		const context = await this.requireContext();
		assertMutationPrepare(value);
		if (value.vaultInstanceId !== context.bootstrap.vaultInstanceId) throw new Error("Mutation prepare belongs to another Vault.");
		return this.write(value.mutationId, "prepare", value);
	}

	async commit(value: CatalogV2MutationCommitArtifact): Promise<ArtifactRef> {
		const context = await this.requireContext();
		assertMutationCommit(value);
		if (value.vaultInstanceId !== context.bootstrap.vaultInstanceId) throw new Error("Mutation commit belongs to another Vault.");
		const prepare = await this.readPrepare(value.prepare);
		if (prepare === null || prepare.mutationId !== value.mutationId) {
			throw new Error("Mutation commit does not match its prepare artifact.");
		}
		const controlled = prepare.mutationKind === "adoption" || prepare.mutationKind === "manual_repair";
		if (controlled !== (value.control !== null)) {
			throw new Error("Mutation commit control does not match its mutation kind.");
		}
		if (value.control !== null) {
			const expectedKind = prepare.mutationKind === "adoption" ? "identity_adoption" : "identity_repair";
			if (value.control.vaultInstanceId !== value.vaultInstanceId
				|| value.control.actionKind !== expectedKind
				|| value.control.inputDigest !== await mutationControlInputDigest(prepare)
				|| value.control.actionId !== value.mutationId) {
				throw new Error("Mutation commit has an invalid control permit.");
			}
		}
		const existing = (await this.inspect()).records.find((record) => record.mutationId === value.mutationId);
		if (existing?.abandon !== null && existing?.abandon !== undefined) {
			throw new Error("Abandoned mutation cannot be committed.");
		}
		return this.write(value.mutationId, "commit", value);
	}

	async findControlPermit(
		prepare: CatalogV2MutationPrepareArtifact,
	): Promise<CatalogV2ControlPermit | null> {
		const context = await this.requireContext();
		const actionKind = prepare.mutationKind === "adoption"
			? "identity_adoption"
			: prepare.mutationKind === "manual_repair" ? "identity_repair" : null;
		if (actionKind === null) return null;
		return this.protocol.findControlPermit(
			context,
			actionKind,
			await mutationControlInputDigest(prepare),
			mutationMemoIds(prepare),
		);
	}

	async abandon(value: CatalogV2MutationAbandonArtifact): Promise<ArtifactRef> {
		const context = await this.requireContext();
		assertMutationAbandon(value);
		if (value.vaultInstanceId !== context.bootstrap.vaultInstanceId) throw new Error("Mutation abandon belongs to another Vault.");
		if (await this.readPrepare(value.prepare) === null) throw new Error("Mutation abandon prepare is unavailable.");
		const existing = (await this.inspect()).records.find((record) => record.mutationId === value.mutationId);
		if (existing?.commit !== null && existing?.commit !== undefined) {
			throw new Error("Committed mutation cannot be abandoned.");
		}
		return this.write(value.mutationId, "abandon", value);
	}

	async inspect(): Promise<CatalogV2SharedMutationInspection> {
		const context = await this.requireContext();
		const root = `${getCatalogMutationsRootPath(context.bootstrap.catalogDataRoot)}/`;
		const records = new Map<string, Partial<CatalogV2SharedMutationRecord> & { mutationId: string }>();
		const pathsByMutation = new Map<string, Set<string>>();
		const memoIdsByMutation = new Map<string, Set<string>>();
		const issues: CatalogV2SharedMutationInspectionIssue[] = [];
		const invalidMutationIds = new Set<string>();
		const addIssue = (
			mutationId: string,
			kind: CatalogV2SharedMutationInspectionIssue["kind"],
			paths: readonly string[],
			detail: string,
		): void => {
			invalidMutationIds.add(mutationId);
			issues.push({
				kind,
				mutationId,
				paths: uniqueSorted(paths),
				memoIds: uniqueSorted([...(memoIdsByMutation.get(mutationId) ?? [])]),
				detail,
			});
		};
		for (const file of this.app.vault.getFiles().sort((left, right) => left.path.localeCompare(right.path))) {
			if (!file.path.startsWith(root)) continue;
			const relative = file.path.slice(root.length);
			const match = /^(o_[a-f0-9]{32})\/(prepare|commit|abandon)-([a-f0-9]{64})\.json$/u.exec(relative);
			if (match === null) continue;
			const mutationId = match[1] as string;
			const type = match[2] as "prepare" | "commit" | "abandon";
			const declaredDigest = match[3] as string;
			const mutationPaths = pathsByMutation.get(mutationId) ?? new Set<string>();
			mutationPaths.add(file.path);
			pathsByMutation.set(mutationId, mutationPaths);
			let bytes: Uint8Array;
			try {
				bytes = new Uint8Array(await this.app.vault.readBinary(file));
			} catch (error) {
				addIssue(mutationId, "invalid_artifact", [file.path], errorMessage(error));
				continue;
			}
			const actualDigest = await sha256Bytes(bytes);
			if (actualDigest !== declaredDigest) {
				addIssue(mutationId, "digest_mismatch", [file.path], "Mutation artifact filename digest does not match its bytes.");
				continue;
			}
			const ref = { path: file.path, sha256: actualDigest, byteLength: bytes.byteLength };
			let value: CatalogV2MutationPrepareArtifact | CatalogV2MutationCommitArtifact | CatalogV2MutationAbandonArtifact;
			try {
				const parsed = readCanonical(file.path, bytes);
				if (type === "prepare") assertMutationPrepare(parsed);
				else if (type === "commit") assertMutationCommit(parsed);
				else assertMutationAbandon(parsed);
				value = parsed;
			} catch (error) {
				addIssue(mutationId, "invalid_artifact", [file.path], errorMessage(error));
				continue;
			}
			if (value.mutationId !== mutationId) {
				addIssue(mutationId, "artifact_mutation_mismatch", [file.path], "Mutation artifact belongs to another mutation directory.");
				continue;
			}
			if ("memoId" in value) {
				const memoIds = memoIdsByMutation.get(mutationId) ?? new Set<string>();
				memoIds.add(value.memoId);
				memoIdsByMutation.set(mutationId, memoIds);
			}
			const record = records.get(mutationId) ?? {
				mutationId,
			};
			if (type === "prepare") {
				if (record.prepareRef !== undefined && !sameRef(record.prepareRef, ref)) {
					addIssue(mutationId, "duplicate_artifact", [record.prepareRef.path, file.path], "Mutation has more than one prepare artifact.");
					continue;
				}
				record.prepare = value as CatalogV2MutationPrepareArtifact;
				record.prepareRef = ref;
			} else if (type === "commit") {
				if (record.commitRef != null && !sameRef(record.commitRef, ref)) {
					addIssue(mutationId, "duplicate_artifact", [record.commitRef.path, file.path], "Mutation has more than one commit artifact.");
					continue;
				}
				record.commit = value as CatalogV2MutationCommitArtifact;
				record.commitRef = ref;
			} else {
				if (record.abandonRef != null && !sameRef(record.abandonRef, ref)) {
					addIssue(mutationId, "duplicate_artifact", [record.abandonRef.path, file.path], "Mutation has more than one abandon artifact.");
					continue;
				}
				record.abandon = value as CatalogV2MutationAbandonArtifact;
				record.abandonRef = ref;
			}
			records.set(mutationId, record);
		}
		for (const record of records.values()) {
			if (record.prepareRef === undefined) continue;
			if (record.commit != null && !sameRef(record.commit.prepare, record.prepareRef)
				|| record.abandon != null && !sameRef(record.abandon.prepare, record.prepareRef)) {
				addIssue(record.mutationId, "prepare_reference_mismatch", [
					record.prepareRef.path,
					...(record.commitRef == null ? [] : [record.commitRef.path]),
					...(record.abandonRef == null ? [] : [record.abandonRef.path]),
				], "Mutation completion artifact references another prepare.");
			}
			if (record.commit != null && record.abandon != null) {
				addIssue(record.mutationId, "commit_abandon_conflict", [
					record.commitRef?.path ?? "",
					record.abandonRef?.path ?? "",
				], "Mutation has both commit and abandon artifacts.");
			}
		}
		for (const issue of issues) {
			issue.memoIds = uniqueSorted([...(memoIdsByMutation.get(issue.mutationId) ?? [])]);
		}
		const missingPrepareMutationIds = uniqueSorted([...records.values()]
			.filter((record) => record.prepare == null && (record.commit != null || record.abandon != null))
			.map((record) => record.mutationId));
		const missingCommitMutationIds = uniqueSorted([...records.values()]
			.filter((record) => record.prepare != null && record.commit == null && record.abandon == null
				&& !invalidMutationIds.has(record.mutationId))
			.map((record) => record.mutationId));
		const validRecords = [...records.values()].flatMap((record) => {
			if (record.prepare == null || record.prepareRef == null || invalidMutationIds.has(record.mutationId)) return [];
			return [{
				mutationId: record.mutationId,
				prepare: record.prepare,
				prepareRef: record.prepareRef,
				commit: record.commit ?? null,
				commitRef: record.commitRef ?? null,
				abandon: record.abandon ?? null,
				abandonRef: record.abandonRef ?? null,
			} satisfies CatalogV2SharedMutationRecord];
		}).sort((left, right) => left.mutationId.localeCompare(right.mutationId));
		const affectedMutationIds = new Set([
			...invalidMutationIds,
			...missingPrepareMutationIds,
			...missingCommitMutationIds,
		]);
		return {
			records: validRecords,
			missingPrepareMutationIds,
			missingCommitMutationIds,
			issues: issues.sort(compareInspectionIssues),
			affectedPaths: uniqueSorted([...affectedMutationIds].flatMap((mutationId) => [
				...(pathsByMutation.get(mutationId) ?? []),
				...([...records.values()].find((record) => record.mutationId === mutationId)?.prepare?.changes
					.map((change) => change.transition.sourcePath) ?? []),
			])),
			affectedMemoIds: uniqueSorted([...affectedMutationIds]
				.flatMap((mutationId) => [...(memoIdsByMutation.get(mutationId) ?? [])])),
		};
	}

	private async readPrepare(ref: ArtifactRef): Promise<CatalogV2MutationPrepareArtifact | null> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(ref.path));
		if (!(file instanceof TFile)) return null;
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		if (bytes.byteLength !== ref.byteLength || await sha256Bytes(bytes) !== ref.sha256) throw new Error("Mutation prepare digest mismatch.");
		const value = readCanonical(file.path, bytes);
		assertMutationPrepare(value);
		return value;
	}

	private async write(mutationId: string, type: "prepare" | "commit" | "abandon", value: unknown): Promise<ArtifactRef> {
		const context = await this.requireContext();
		const bytes = canonicalJsonFileBytes(value);
		const digest = await sha256Bytes(bytes);
		const path = type === "prepare"
			? getCatalogMutationPreparePath(context.bootstrap.catalogDataRoot, mutationId, digest)
			: type === "commit"
				? getCatalogMutationCommitPath(context.bootstrap.catalogDataRoot, mutationId, digest)
				: getCatalogMutationAbandonPath(context.bootstrap.catalogDataRoot, mutationId, digest);
		return this.protocol.writeImmutable(path, bytes);
	}

	private async requireContext(): Promise<CatalogV2VerifiedVaultContext> {
		const context = await this.getContext();
		if (context === null) throw new Error("Catalog v2 Vault bootstrap is not verified.");
		return context;
	}
}

export function assertMutationPrepare(value: unknown): asserts value is CatalogV2MutationPrepareArtifact {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.mutation-prepare" || value.schemaVersion !== 2
		|| !/^v_[a-f0-9]{32}$/u.test(readString(value.vaultInstanceId)) || !OP_ID_PATTERN.test(readString(value.mutationId))
		|| !["create", "edit", "task", "delete", "restore", "move", "copy", "adoption", "manual_repair"].includes(readString(value.mutationKind))
		|| !MEMO_ID_PATTERN.test(readString(value.memoId))
		|| !Array.isArray(value.changes)
		|| (value.changes.length === 0 && value.mutationKind !== "adoption" && value.mutationKind !== "manual_repair")
		|| value.changes.some((change) => !isChange(change)) || !Array.isArray(value.effectDrafts)
		|| value.effectDrafts.some((draft) => !isEffectDraft(draft))
		|| !WRITER_ID_PATTERN.test(readString(value.preparedByWriterId)) || !isDate(value.preparedAt)) {
		throw new Error("Invalid Catalog v2 mutation prepare.");
	}
	assertMutationSemantics(value as unknown as CatalogV2MutationPrepareArtifact);
}

export function assertMutationCommit(value: unknown): asserts value is CatalogV2MutationCommitArtifact {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.mutation-commit" || value.schemaVersion !== 2
		|| !/^v_[a-f0-9]{32}$/u.test(readString(value.vaultInstanceId)) || !OP_ID_PATTERN.test(readString(value.mutationId))
		|| !isRef(value.prepare) || (value.control !== null && !isControlPermit(value.control))) {
		throw new Error("Invalid Catalog v2 mutation commit.");
	}
}

export function assertMutationAbandon(value: unknown): asserts value is CatalogV2MutationAbandonArtifact {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.mutation-abandon" || value.schemaVersion !== 2
		|| !/^v_[a-f0-9]{32}$/u.test(readString(value.vaultInstanceId)) || !OP_ID_PATTERN.test(readString(value.mutationId))
		|| !isRef(value.prepare) || !["daily_write_failed", "stale_revision", "user_cancelled"].includes(readString(value.reason))) {
		throw new Error("Invalid Catalog v2 mutation abandon.");
	}
}

export async function mutationControlInputDigest(prepare: CatalogV2MutationPrepareArtifact): Promise<string> {
	if (prepare.mutationKind === "adoption") {
		const claims = prepare.effectDrafts.filter((draft): draft is Extract<typeof draft, { type: "identity.claim" }> =>
			draft.type === "identity.claim" && draft.payload.origin === "manual_adoption");
		if (claims.length !== 1) throw new Error("Identity adoption prepare must contain one claim.");
		return sha256Text(canonicalJson(claims[0]?.payload.evidence));
	}
	if (prepare.mutationKind === "manual_repair") {
		const rebinds = prepare.effectDrafts.filter((draft): draft is Extract<typeof draft, { type: "identity.rebind" }> =>
			draft.type === "identity.rebind" && draft.payload.reason === "manual_resolution");
		const rebind = rebinds[0];
		if (rebinds.length !== 1 || rebind === undefined) {
			throw new Error("Identity repair prepare must contain one rebind.");
		}
		return sha256Text(canonicalJson({
			memoId: rebind.memoId,
			baseBindingId: rebind.payload.baseBindingId,
			baseEvidence: rebind.baseEvidence,
			targetEvidence: rebind.payload.evidence,
		}));
	}
	throw new Error("Mutation kind does not require a control input digest.");
}

export async function deriveObservationMemoId(
	vaultInstanceId: string,
	contractDigest: string,
	evidence: IdentityEvidence,
): Promise<string> {
	if (!/^v_[a-f0-9]{32}$/u.test(vaultInstanceId) || !SHA256_PATTERN.test(contractDigest)) {
		throw new Error("Cannot derive memoId outside a verified Vault contract.");
	}
	const observationDigest = await sha256Text(canonicalJson(evidence));
	return `m_${(await sha256Text(canonicalJson({
		vaultInstanceId,
		contractDigest,
		observationDigest,
	}))).slice(0, 32)}`;
}

function mutationMemoIds(prepare: CatalogV2MutationPrepareArtifact): string[] {
	return [...new Set([prepare.memoId, ...prepare.effectDrafts.map((draft) => draft.memoId)])].sort();
}

function isTransition(value: unknown): boolean {
	return isRecord(value) && typeof value.sourcePath === "string" && value.sourcePath.length > 0
		&& normalizePath(value.sourcePath) === value.sourcePath && !value.sourcePath.startsWith("/")
		&& !/(^|\/)\.{1,2}(\/|$)/u.test(value.sourcePath)
		&& /^\d{4}-\d{2}-\d{2}$/u.test(readString(value.logicalDate)) && Array.isArray(value.headings)
		&& value.headings.every((heading) => typeof heading === "string")
		&& SHA256_PATTERN.test(readString(value.beforeRevision)) && SHA256_PATTERN.test(readString(value.afterRevision))
		&& (value.beforeEvidence === null || isIdentityEvidence(value.beforeEvidence))
		&& (value.afterEvidence === null || isIdentityEvidence(value.afterEvidence))
		&& (value.baseBindingId === null || /^o_[a-f0-9]{32}$/u.test(readString(value.baseBindingId)))
		&& (value.baseEvidence === null || isIdentityEvidence(value.baseEvidence))
		&& Array.isArray(value.preservedEvidence)
		&& value.preservedEvidence.every((item) => isRecord(item)
			&& isIdentityEvidence(item.before) && isIdentityEvidence(item.after));
}

function assertMutationSemantics(value: CatalogV2MutationPrepareArtifact): void {
	const controlled = value.mutationKind === "adoption" || value.mutationKind === "manual_repair";
	if (controlled !== (value.changes.length === 0)) throw new Error("Invalid controlled mutation change set.");
	const paths = value.changes.map((change) => normalizePath(change.transition.sourcePath));
	if (new Set(paths).size !== paths.length) throw new Error("Mutation changes contain the same Daily file more than once.");
	if ((value.mutationKind === "move") !== (value.changes.length === 2)) {
		throw new Error("Move mutation must contain exactly two Daily transitions.");
	}
	if (value.mutationKind !== "move" && !controlled && value.changes.length !== 1) {
		throw new Error("Daily mutation must contain exactly one file transition.");
	}
	for (const change of value.changes) {
		const transition = change.transition;
		if (transition.beforeRevision === transition.afterRevision) {
			throw new Error("Mutation file revision must advance.");
		}
		if (!evidenceMatchesTransition(transition.beforeEvidence, transition.sourcePath,
			transition.logicalDate, transition.beforeRevision)
			|| !evidenceMatchesTransition(transition.afterEvidence, transition.sourcePath,
				transition.logicalDate, transition.afterRevision)
			|| !evidenceMatchesBaseBinding(transition.baseEvidence, transition.sourcePath,
				transition.logicalDate, transition.baseBindingId)
			|| transition.preservedEvidence.some((preserved) =>
				!evidenceMatchesTransition(preserved.before, transition.sourcePath,
					transition.logicalDate, transition.beforeRevision)
				|| !evidenceMatchesTransition(preserved.after, transition.sourcePath,
					transition.logicalDate, transition.afterRevision))) {
			throw new Error("Mutation evidence does not match its file revision transition.");
		}
		const ownsExistingIdentity = change.replay.kind !== "insert";
		if (ownsExistingIdentity
			? transition.baseBindingId === null || transition.baseEvidence === null
			: transition.baseBindingId !== null || transition.baseEvidence !== null) {
			throw new Error("Mutation base binding does not match its predecessor evidence.");
		}
		if (change.replay.kind === "insert"
			? transition.beforeEvidence !== null || transition.afterEvidence === null
			: change.replay.kind === "remove"
				? transition.beforeEvidence === null || transition.afterEvidence !== null
				: transition.beforeEvidence === null || transition.afterEvidence === null) {
			throw new Error("Mutation replay does not match its identity transition.");
		}
	}
	const replayKinds = value.changes.map((change) => change.replay.kind).sort();
	const expectedReplayKinds = value.mutationKind === "move" ? ["insert", "remove"]
		: value.mutationKind === "create" || value.mutationKind === "copy" || value.mutationKind === "restore" ? ["insert"]
			: value.mutationKind === "delete" ? ["remove"] : controlled ? [] : ["replace"];
	if (canonicalJson(replayKinds) !== canonicalJson(expectedReplayKinds)) {
		throw new Error("Mutation kind does not match its Daily replay operations.");
	}
	const effectMemoIds = new Set(value.effectDrafts.map((draft) => draft.memoId));
	if (effectMemoIds.size !== 1 || !effectMemoIds.has(value.memoId)) {
		throw new Error("Mutation effects must belong to exactly one memoId.");
	}
	const effectIds = value.effectDrafts.map((draft) => draft.opId);
	if (new Set(effectIds).size !== effectIds.length || !effectIds.includes(value.mutationId)) {
		throw new Error("Mutation effects must have unique operation IDs and include the mutationId.");
	}
	const claims = value.effectDrafts.filter((draft) => draft.type === "identity.claim");
	const rebinds = value.effectDrafts.filter((draft) => draft.type === "identity.rebind");
	if (value.mutationKind === "adoption") {
		if (claims.length !== 1 || value.effectDrafts.length !== 1
			|| claims[0]?.payload.origin !== "manual_adoption") {
			throw new Error("Identity adoption mutation has invalid effects.");
		}
	} else if (value.mutationKind === "manual_repair") {
		if (rebinds.length !== 1 || value.effectDrafts.length !== 1
			|| rebinds[0]?.payload.reason !== "manual_resolution") {
			throw new Error("Identity repair mutation has invalid effects.");
		}
	} else if (value.mutationKind === "create" || value.mutationKind === "copy") {
		const intents = value.effectDrafts.filter((draft) => draft.type === "lifecycle.create_intent");
		const claim = claims[0];
		const intent = intents[0];
		const afterEvidence = value.changes[0]?.transition.afterEvidence;
		const expectedOrigin = value.mutationKind === "create" ? "plugin_create" : "explicit_copy";
		if (claims.length !== 1 || intents.length !== 1 || claim === undefined || intent === undefined
			|| claim.payload.origin !== expectedOrigin || claim.payload.createIntentOpId !== intent.opId
			|| afterEvidence === null || canonicalJson(claim.payload.evidence) !== canonicalJson(afterEvidence)
			|| canonicalJson(intent.payload.evidence) !== canonicalJson(afterEvidence)
			|| intent.payload.targetPath !== afterEvidence.sourcePath) {
			throw new Error("Create mutation has invalid identity intent effects.");
		}
		const relations = value.effectDrafts.filter((draft) => draft.type === "relation.set_source");
		if (value.mutationKind === "copy"
			? relations.length !== 1 || relations[0]?.payload.sourceMemoId === null
			: relations.length !== 0) {
			throw new Error("Copy mutation has invalid source relation effects.");
		}
	} else if (value.mutationKind === "edit" || value.mutationKind === "task") {
		const transition = value.changes[0]?.transition;
		const rebind = rebinds[0];
		if (value.effectDrafts.length !== 1 || rebind === undefined || rebind.payload.reason !== "edit"
			|| transition === undefined || !rebindMatchesTransition(rebind, transition.baseEvidence,
				transition.afterEvidence, transition.baseBindingId)) {
			throw new Error("Edit mutation has invalid identity effects.");
		}
	} else if (value.mutationKind === "move") {
		const inserted = value.changes.find((change) => change.replay.kind === "insert")?.transition;
		const removed = value.changes.find((change) => change.replay.kind === "remove")?.transition;
		const rebind = rebinds[0];
		if (value.effectDrafts.length !== 1 || rebind === undefined || rebind.payload.reason !== "move"
			|| inserted === undefined || removed === undefined || inserted.baseBindingId !== null
			|| !rebindMatchesTransition(rebind, removed.baseEvidence, inserted.afterEvidence, removed.baseBindingId)) {
			throw new Error("Move mutation has invalid cross-file identity effects.");
		}
	} else if (value.mutationKind === "delete") {
		const deletes = value.effectDrafts.filter((draft) => draft.type === "lifecycle.delete");
		const transition = value.changes[0]?.transition;
		const deleted = deletes[0];
		if (value.effectDrafts.length !== 1 || deleted === undefined || transition === undefined
			|| transition.baseEvidence === null || deleted.payload.baseBindingId !== transition.baseBindingId
			|| canonicalJson(deleted.baseEvidence) !== canonicalJson(transition.baseEvidence)) {
			throw new Error("Delete mutation has invalid lifecycle effects.");
		}
	} else if (value.mutationKind === "restore") {
		const restores = value.effectDrafts.filter((draft) => draft.type === "lifecycle.restore");
		const transition = value.changes[0]?.transition;
		const restored = restores[0];
		if (value.effectDrafts.length !== 1 || restored === undefined || transition === undefined
			|| transition.afterEvidence === null
			|| canonicalJson(restored.payload.evidence) !== canonicalJson(transition.afterEvidence)) {
			throw new Error("Restore mutation has invalid lifecycle effects.");
		}
	}
}

function rebindMatchesTransition(
	rebind: Extract<CatalogV2MutationPrepareArtifact["effectDrafts"][number], { type: "identity.rebind" }>,
	beforeEvidence: CatalogV2MutationPrepareArtifact["changes"][number]["transition"]["beforeEvidence"],
	afterEvidence: CatalogV2MutationPrepareArtifact["changes"][number]["transition"]["afterEvidence"],
	baseBindingId: string | null,
): boolean {
	return beforeEvidence !== null && afterEvidence !== null && baseBindingId !== null
		&& rebind.payload.baseBindingId === baseBindingId
		&& canonicalJson(rebind.baseEvidence) === canonicalJson(beforeEvidence)
		&& canonicalJson(rebind.payload.evidence) === canonicalJson(afterEvidence);
}

function evidenceMatchesTransition(
	evidence: CatalogV2MutationPrepareArtifact["changes"][number]["transition"]["beforeEvidence"],
	sourcePath: string,
	logicalDate: string,
	revision: string,
): boolean {
	return evidence === null || normalizePath(evidence.sourcePath) === normalizePath(sourcePath)
		&& evidence.logicalDate === logicalDate && evidence.sourceRevision === revision;
}

function evidenceMatchesBaseBinding(
	evidence: CatalogV2MutationPrepareArtifact["changes"][number]["transition"]["baseEvidence"],
	sourcePath: string,
	logicalDate: string,
	baseBindingId: string | null,
): boolean {
	return evidence === null ? baseBindingId === null
		: baseBindingId !== null && normalizePath(evidence.sourcePath) === normalizePath(sourcePath)
			&& evidence.logicalDate === logicalDate;
}

function isChange(value: unknown): boolean {
	return isRecord(value) && isTransition(value.transition) && isReplay(value.replay);
}

function isReplay(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind === "insert") return typeof value.rawBlock === "string" && value.rawBlock.length > 0
		&& (value.section === null || typeof value.section === "string");
	if (value.kind === "replace") return typeof value.beforeRawBlock === "string" && value.beforeRawBlock.length > 0
		&& typeof value.afterRawBlock === "string" && value.afterRawBlock.length > 0;
	return value.kind === "remove" && typeof value.beforeRawBlock === "string" && value.beforeRawBlock.length > 0;
}

function isIdentityEvidence(value: unknown): boolean {
	return isRecord(value) && typeof value.sourcePath === "string" && value.sourcePath.length > 0
		&& SHA256_PATTERN.test(readString(value.sourceRevision)) && typeof value.logicalDate === "string"
		&& (value.section === null || typeof value.section === "string")
		&& Number.isInteger(value.startLine) && Number(value.startLine) >= 0
		&& Number.isInteger(value.endLine) && Number(value.endLine) >= Number(value.startLine)
		&& typeof value.time === "string" && typeof value.contentHash === "string"
		&& (value.existingBlockId === null || typeof value.existingBlockId === "string");
}

function isEffectDraft(value: unknown): boolean {
	return isRecord(value) && OP_ID_PATTERN.test(readString(value.opId)) && typeof value.memoId === "string"
		&& typeof value.type === "string" && isDate(value.occurredAt) && "baseEvidence" in value && isRecord(value.payload);
}

function isRef(value: unknown): value is ArtifactRef {
	return isRecord(value) && typeof value.path === "string" && SHA256_PATTERN.test(readString(value.sha256))
		&& Number.isInteger(value.byteLength) && Number(value.byteLength) > 0;
}

function isControlPermit(value: unknown): value is CatalogV2ControlPermit {
	return isRecord(value) && value.kind === "catalog-v2-control-permit"
		&& /^v_[a-f0-9]{32}$/u.test(readString(value.vaultInstanceId))
		&& isRef(value.controlGeneration) && Number.isInteger(value.controlSequence) && Number(value.controlSequence) > 0
		&& Number.isInteger(value.authorityEpoch) && Number(value.authorityEpoch) > 0
		&& WRITER_ID_PATTERN.test(readString(value.authorityWriterId)) && OP_ID_PATTERN.test(readString(value.actionId))
		&& (value.actionKind === "identity_adoption" || value.actionKind === "identity_repair"
			|| value.actionKind === "migration_finalize"
			|| value.actionKind === "contract_change" || value.actionKind === "authority_transfer")
		&& SHA256_PATTERN.test(readString(value.inputDigest))
		&& isDate(value.authorizedAt)
		&& SHA256_PATTERN.test(readString(value.stateGenerationId))
		&& SHA256_PATTERN.test(readString(value.contractDigest));
}

function readCanonical(path: string, bytes: Uint8Array): unknown {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (!text.endsWith("\n")) throw new Error(`Mutation artifact bytes are invalid: ${path}`);
	const value = JSON.parse(text.slice(0, -1)) as unknown;
	if (`${canonicalJson(value)}\n` !== text) throw new Error(`Mutation artifact is not canonical: ${path}`);
	return value;
}

function sameRef(left: ArtifactRef, right: ArtifactRef): boolean {
	return left.path === right.path && left.sha256 === right.sha256 && left.byteLength === right.byteLength;
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function compareInspectionIssues(
	left: CatalogV2SharedMutationInspectionIssue,
	right: CatalogV2SharedMutationInspectionIssue,
): number {
	return left.mutationId.localeCompare(right.mutationId)
		|| left.kind.localeCompare(right.kind)
		|| (left.paths[0] ?? "").localeCompare(right.paths[0] ?? "");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isDate(value: unknown): boolean {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}
