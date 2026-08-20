import type {
	ArtifactRef,
	CatalogV2IdPrefix,
	DeletedMemoPayload,
	IdentityEvidence,
	ParsedStateSegment,
	StateCompactionCommit,
	StateOperation,
	StateSnapshot,
} from "../types/catalogV2";
import { isRecord } from "../utils/object";
import { getCatalogSnapshotPath, getCatalogStateCheckpointPath } from "../utils/path";

const WRITER_ID_PATTERN = /^w_[a-f0-9]{32}$/;
const OP_ID_PATTERN = /^o_[a-f0-9]{32}$/;
const LEGACY_ENTRY_ID_PATTERN = /^l_[a-f0-9]{64}$/;
const MEMO_ID_PATTERN = /^[^/\\\u0000-\u001f]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONTENT_HASH_PATTERN = /^fnv1a-[a-f0-9]{8}$/;
const LOGICAL_DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const MEMO_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const SEGMENT_ROTATE_BYTES = 384 * 1024;
const SEGMENT_HARD_LIMIT_BYTES = 512 * 1024;

export type FillRandomBytes = (target: Uint8Array) => void;

export function canonicalJson(value: unknown): string {
	return JSON.stringify(toCanonicalValue(value));
}

export function canonicalJsonFileBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}

export function createCatalogV2Id(prefix: CatalogV2IdPrefix, fillRandomBytes: FillRandomBytes = fillCryptoRandom): string {
	const bytes = new Uint8Array(16);
	fillRandomBytes(bytes);
	return `${prefix}_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export async function sha256Text(value: string): Promise<string> {
	return sha256Bytes(new TextEncoder().encode(value));
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
	const cryptoApi = typeof crypto === "undefined" ? undefined : crypto;
	if (cryptoApi?.subtle === undefined) {
		throw new Error("Web Crypto SHA-256 is unavailable.");
	}
	const input = new Uint8Array(bytes.byteLength);
	input.set(bytes);
	const digest = await cryptoApi.subtle.digest("SHA-256", input.buffer);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function serializeStateSegment(operations: readonly StateOperation[]): string {
	if (operations.length === 0) {
		return "";
	}
	validateOperationSequence(operations);
	return operations.map((operation) => canonicalJson(operation)).join("\n") + "\n";
}

export async function parseStateSegment(path: string, content: string | Uint8Array): Promise<ParsedStateSegment> {
	const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
	const text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: true }).decode(content);
	if (text.length === 0 || text.charCodeAt(0) === 0xfeff || !text.endsWith("\n")) {
		throw new Error(`Invalid state segment bytes: ${path}`);
	}
	const lines = text.slice(0, -1).split("\n");
	if (lines.some((line) => line.length === 0)) {
		throw new Error(`State segment contains a blank line: ${path}`);
	}
	const operations: StateOperation[] = [];
	const digests: string[] = [];
	for (const line of lines) {
		const parsed = JSON.parse(line) as unknown;
		assertStateOperation(parsed);
		if (canonicalJson(parsed) !== line) {
			throw new Error(`State operation is not canonical JSON: ${path}`);
		}
		operations.push(parsed);
		digests.push(await sha256Text(line));
	}
	validateOperationSequence(operations);
	return {
		path,
		sha256: await sha256Bytes(bytes),
		byteLength: bytes.byteLength,
		writerId: operations[0]?.writerId ?? "",
		firstSequence: operations[0]?.sequence ?? 0,
		lastSequence: operations[operations.length - 1]?.sequence ?? 0,
		operations: operations.map((operation, index) => ({
			operation,
			digest: digests[index] ?? "",
			sourcePath: path,
		})),
	};
}

export function serializeDeletedMemoPayload(payload: DeletedMemoPayload): Uint8Array {
	assertDeletedMemoPayload(payload);
	return canonicalJsonFileBytes(payload);
}

export function parseDeletedMemoPayload(path: string, content: string | Uint8Array): DeletedMemoPayload {
	const text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: true }).decode(content);
	if (text.length === 0 || text.charCodeAt(0) === 0xfeff || !text.endsWith("\n")) {
		throw new Error(`Invalid deleted memo payload bytes: ${path}`);
	}
	const parsed = JSON.parse(text.slice(0, -1)) as unknown;
	assertDeletedMemoPayload(parsed);
	if (`${canonicalJson(parsed)}\n` !== text) {
		throw new Error(`Deleted memo payload is not canonical JSON: ${path}`);
	}
	return parsed;
}

export function assertDeletedMemoPayload(value: unknown): asserts value is DeletedMemoPayload {
	if (!isRecord(value)
		|| value.kind !== "knomo.catalog-v2.deleted-payload"
		|| value.schemaVersion !== 1
		|| !isMemoId(value.memoId)
		|| !isStateEntryId(value.deleteOpId)
		|| !isValidDateTime(value.deletedAt)
		|| !isVaultPath(value.sourcePath)
		|| !LOGICAL_DATE_PATTERN.test(readString(value.logicalDate))
		|| (value.section !== null && typeof value.section !== "string")
		|| typeof value.rawBlock !== "string"
		|| value.rawBlock.length === 0
		|| !CONTENT_HASH_PATTERN.test(readString(value.contentHash))
		|| (value.sourceMemoId !== null && !isMemoId(value.sourceMemoId))) {
		throw new Error("Invalid deleted memo payload.");
	}
}

export interface StateSegmentAppendPlan {
	action: "append" | "rotate";
	line: string;
	content: string;
}

export function planStateSegmentAppend(currentContent: string, operation: StateOperation): StateSegmentAppendPlan {
	assertStateOperation(operation);
	const line = `${canonicalJson(operation)}\n`;
	const lineBytes = new TextEncoder().encode(line).byteLength;
	if (lineBytes > SEGMENT_HARD_LIMIT_BYTES) {
		throw new Error("A single state operation exceeds the 512 KiB segment hard limit.");
	}
	const currentBytes = new TextEncoder().encode(currentContent).byteLength;
	if (currentBytes >= SEGMENT_ROTATE_BYTES || currentBytes + lineBytes > SEGMENT_HARD_LIMIT_BYTES) {
		return { action: "rotate", line, content: line };
	}
	return { action: "append", line, content: `${currentContent}${line}` };
}

export interface BuildStateSnapshotInput {
	sourceWriterId: string;
	coveredSegments: ArtifactRef[];
	operations: StateOperation[];
}

export async function buildStateSnapshot(input: BuildStateSnapshotInput): Promise<{
	snapshot: StateSnapshot;
	bytes: Uint8Array;
	digest: string;
	path: string;
}> {
	if (!WRITER_ID_PATTERN.test(input.sourceWriterId)) {
		throw new Error("Invalid source writerId for state snapshot.");
	}
	const operations = [...input.operations].sort(compareOperations);
	validateOperationSequence(operations);
	if (operations.length === 0 || operations.some((operation) => operation.writerId !== input.sourceWriterId)) {
		throw new Error("State snapshot requires operations from one writer.");
	}
	for (let index = 1; index < operations.length; index += 1) {
		if (operations[index]?.sequence !== (operations[index - 1]?.sequence ?? 0) + 1) {
			throw new Error("State snapshot cannot cover a sequence gap.");
		}
	}
	const operationDigests = await Promise.all(operations.map(async (operation) => ({
		opId: operation.opId,
		sha256: await sha256Text(canonicalJson(operation)),
	})));
	operationDigests.sort((left, right) => compareText(`${left.opId}\u0000${left.sha256}`, `${right.opId}\u0000${right.sha256}`));
	const coveredSegments = [...input.coveredSegments].sort((left, right) => compareText(
		`${left.path}\u0000${left.sha256}`,
		`${right.path}\u0000${right.sha256}`,
	));
	for (const segment of coveredSegments) {
		assertArtifactRef(segment);
	}
	const snapshot: StateSnapshot = {
		kind: "knomo.catalog-v2.state-snapshot",
		schemaVersion: 1,
		sourceWriterId: input.sourceWriterId,
		firstSequence: operations[0]?.sequence ?? 0,
		lastSequence: operations[operations.length - 1]?.sequence ?? 0,
		coveredSegments,
		operationDigests,
		operations,
	};
	const bytes = canonicalJsonFileBytes(snapshot);
	const digest = await sha256Bytes(bytes);
	return {
		snapshot,
		bytes,
		digest,
		path: getCatalogSnapshotPath("", snapshot.sourceWriterId, snapshot.firstSequence, snapshot.lastSequence, digest),
	};
}

export interface BuildStateCompactionCommitInput {
	snapshot: ArtifactRef;
	snapshotValue: StateSnapshot;
	committingWriterId: string;
	committedAt: string;
}

export async function buildStateCompactionCommit(input: BuildStateCompactionCommitInput): Promise<{
	commit: StateCompactionCommit;
	bytes: Uint8Array;
	digest: string;
	path: string;
}> {
	assertArtifactRef(input.snapshot);
	if (!WRITER_ID_PATTERN.test(input.committingWriterId) || !isValidDateTime(input.committedAt)) {
		throw new Error("Invalid state compaction commit writer or timestamp.");
	}
	const expectedSnapshotBytes = canonicalJsonFileBytes(input.snapshotValue);
	if (input.snapshot.sha256 !== await sha256Bytes(expectedSnapshotBytes)
		|| input.snapshot.byteLength !== expectedSnapshotBytes.byteLength) {
		throw new Error("State compaction snapshot reference does not match its bytes.");
	}
	const coveredSegments = [...input.snapshotValue.coveredSegments].sort((left, right) => compareText(
		`${left.path}\u0000${left.sha256}`,
		`${right.path}\u0000${right.sha256}`,
	));
	const commit: StateCompactionCommit = {
		kind: "knomo.catalog-v2.compaction-commit",
		schemaVersion: 1,
		sourceWriterId: input.snapshotValue.sourceWriterId,
		firstSequence: input.snapshotValue.firstSequence,
		lastSequence: input.snapshotValue.lastSequence,
		snapshot: input.snapshot,
		coveredSegments,
		committingWriterId: input.committingWriterId,
		committedAt: input.committedAt,
	};
	const bytes = canonicalJsonFileBytes(commit);
	return {
		commit,
		bytes,
		digest: await sha256Bytes(bytes),
		path: getCatalogStateCheckpointPath("", input.snapshot.sha256, input.committingWriterId),
	};
}

export async function parseStateSnapshot(path: string, content: string | Uint8Array): Promise<StateSnapshot> {
	const text = decodeCanonicalJsonFile(path, content);
	const value = JSON.parse(text.slice(0, -1)) as unknown;
	assertStateSnapshot(value);
	if (`${canonicalJson(value)}\n` !== text) throw new Error(`State snapshot is not canonical JSON: ${path}`);
	const digestByOpId = new Map(value.operationDigests.map((item) => [item.opId, item.sha256]));
	for (const operation of value.operations) {
		if (digestByOpId.get(operation.opId) !== await sha256Text(canonicalJson(operation))) {
			throw new Error(`State snapshot operation digest mismatch: ${path}`);
		}
	}
	return value;
}

export function parseStateCompactionCommit(path: string, content: string | Uint8Array): StateCompactionCommit {
	const text = decodeCanonicalJsonFile(path, content);
	const value = JSON.parse(text.slice(0, -1)) as unknown;
	assertStateCompactionCommit(value);
	if (`${canonicalJson(value)}\n` !== text) throw new Error(`State compaction commit is not canonical JSON: ${path}`);
	return value;
}

function assertStateSnapshot(value: unknown): asserts value is StateSnapshot {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.state-snapshot" || value.schemaVersion !== 1
		|| !WRITER_ID_PATTERN.test(readString(value.sourceWriterId))
		|| !isPositiveInteger(value.firstSequence) || !isPositiveInteger(value.lastSequence)
		|| value.lastSequence < value.firstSequence
		|| !Array.isArray(value.coveredSegments) || value.coveredSegments.length === 0
		|| !Array.isArray(value.operationDigests) || value.operationDigests.length === 0
		|| !Array.isArray(value.operations)) {
		throw new Error("Invalid state snapshot.");
	}
	for (const segment of value.coveredSegments) assertArtifactRef(segment as ArtifactRef);
	assertSortedUnique(value.coveredSegments, (item) => `${(item as ArtifactRef).path}\u0000${(item as ArtifactRef).sha256}`);
	for (const item of value.operationDigests) {
		if (!isRecord(item) || !OP_ID_PATTERN.test(readString(item.opId)) || !SHA256_PATTERN.test(readString(item.sha256))) {
			throw new Error("Invalid state snapshot operation digest.");
		}
	}
	assertSortedUnique(value.operationDigests, (item) => {
		const record = item as { opId: string; sha256: string };
		return `${record.opId}\u0000${record.sha256}`;
	});
	let previous: StateOperation | null = null;
	for (const operation of value.operations) {
		assertStateOperation(operation);
		if (operation.writerId !== value.sourceWriterId
			|| operation.sequence < value.firstSequence || operation.sequence > value.lastSequence
			|| (previous !== null && compareOperations(previous, operation) >= 0)) {
			throw new Error("Invalid state snapshot operation range.");
		}
		previous = operation;
	}
}

function assertStateCompactionCommit(value: unknown): asserts value is StateCompactionCommit {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.compaction-commit" || value.schemaVersion !== 1
		|| !WRITER_ID_PATTERN.test(readString(value.sourceWriterId))
		|| !isPositiveInteger(value.firstSequence) || !isPositiveInteger(value.lastSequence)
		|| value.lastSequence < value.firstSequence
		|| !isArtifactRef(value.snapshot)
		|| !Array.isArray(value.coveredSegments) || value.coveredSegments.length === 0
		|| !WRITER_ID_PATTERN.test(readString(value.committingWriterId))
		|| !isValidDateTime(value.committedAt)) {
		throw new Error("Invalid state compaction commit.");
	}
	for (const segment of value.coveredSegments) assertArtifactRef(segment as ArtifactRef);
	assertSortedUnique(value.coveredSegments, (item) => `${(item as ArtifactRef).path}\u0000${(item as ArtifactRef).sha256}`);
}

function decodeCanonicalJsonFile(path: string, content: string | Uint8Array): string {
	const text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: true }).decode(content);
	if (text.length === 0 || text.charCodeAt(0) === 0xfeff || !text.endsWith("\n")) {
		throw new Error(`Invalid canonical JSON bytes: ${path}`);
	}
	return text;
}

function assertSortedUnique<T>(values: readonly T[], keyOf: (value: T) => string): void {
	let previous: string | null = null;
	for (const value of values) {
		const key = keyOf(value);
		if (previous !== null && compareText(previous, key) >= 0) throw new Error("Canonical state artifact array is not sorted and unique.");
		previous = key;
	}
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function assertStateOperation(value: unknown): asserts value is StateOperation {
	if (!isRecord(value)
		|| value.schemaVersion !== 1
		|| !WRITER_ID_PATTERN.test(readString(value.writerId))
		|| typeof value.sequence !== "number"
		|| !Number.isInteger(value.sequence)
		|| value.sequence < 1
		|| !OP_ID_PATTERN.test(readString(value.opId))
		|| !MEMO_ID_PATTERN.test(readString(value.memoId))
		|| !isValidDateTime(value.occurredAt)
		|| !isRecord(value.payload)) {
		throw new Error("Invalid StateOperation base fields.");
	}
	const type = value.type;
	if (type === "review.record") {
		if (value.baseEvidence !== null || !isValidDateTime(value.payload.reviewedAt)) {
			throw new Error("Invalid review.record operation.");
		}
		return;
	}
	if (type === "relation.set_source") {
		if (value.baseEvidence !== null
			|| (value.payload.sourceMemoId !== null && !isMemoId(value.payload.sourceMemoId))
			|| !isStateEntryIdArray(value.payload.supersedesRelationIds)) {
			throw new Error("Invalid relation.set_source operation.");
		}
		return;
	}
	if (type === "identity.claim") {
		const origin = readString(value.payload.origin);
		const control = value.payload.control;
		if (value.baseEvidence !== null || !isIdentityEvidence(value.payload.evidence)
			|| !["plugin_create", "explicit_copy", "manual_adoption"].includes(origin)
			|| (value.payload.createIntentOpId !== null && !OP_ID_PATTERN.test(readString(value.payload.createIntentOpId)))
			|| (value.payload.control !== null && value.payload.control !== undefined && !isControlPermit(value.payload.control))
			|| (origin === "manual_adoption"
				&& (value.payload.control === null || value.payload.control === undefined
					|| !isRecord(control) || control.actionKind !== "identity_adoption"))
			|| ((origin === "plugin_create" || origin === "explicit_copy")
				&& value.payload.control !== null && value.payload.control !== undefined)) {
			throw new Error("Invalid identity.claim operation.");
		}
		return;
	}
	if (type === "identity.rebind") {
		const reason = readString(value.payload.reason);
		const control = value.payload.control;
		if (!isIdentityEvidence(value.baseEvidence) || !isIdentityEvidence(value.payload.evidence)
			|| !isStateEntryId(value.payload.baseBindingId)
			|| !["edit", "rename", "move", "restore", "manual_resolution"].includes(reason)
			|| (value.payload.control !== null && value.payload.control !== undefined && !isControlPermit(value.payload.control))
			|| (reason === "manual_resolution"
				? value.payload.control === null || value.payload.control === undefined
					|| !isRecord(control) || control.actionKind !== "identity_repair"
				: value.payload.control !== null && value.payload.control !== undefined)) {
			throw new Error("Invalid identity.rebind operation.");
		}
		return;
	}
	if (type === "identity.redirect") {
		if (value.baseEvidence !== null || !isMemoId(value.payload.toMemoId)
			|| (value.payload.reason !== "duplicate_resolution" && value.payload.reason !== "manual_resolution")) {
			throw new Error("Invalid identity.redirect operation.");
		}
		return;
	}
	if (type === "lifecycle.create_intent") {
		const evidence = value.payload.evidence;
		if (!isIdentityEvidence(evidence)) {
			throw new Error("Invalid lifecycle.create_intent operation.");
		}
		if (value.baseEvidence !== null || !isVaultPath(value.payload.targetPath)
			|| !LOGICAL_DATE_PATTERN.test(readString(value.payload.logicalDate))
			|| !MEMO_TIME_PATTERN.test(readString(value.payload.time))
			|| !CONTENT_HASH_PATTERN.test(readString(value.payload.contentHash))
			|| evidence.sourcePath !== value.payload.targetPath
			|| evidence.logicalDate !== value.payload.logicalDate
			|| evidence.time !== value.payload.time
			|| evidence.contentHash !== value.payload.contentHash
			|| (value.payload.sourceMemoId !== null && !isMemoId(value.payload.sourceMemoId))) {
			throw new Error("Invalid lifecycle.create_intent operation.");
		}
		return;
	}
	if (type === "lifecycle.create_abandon") {
		if (value.baseEvidence !== null || !OP_ID_PATTERN.test(readString(value.payload.createIntentOpId))
			|| !["daily_write_failed", "intent_commit_failed", "user_cancelled"].includes(readString(value.payload.reason))) {
			throw new Error("Invalid lifecycle.create_abandon operation.");
		}
		return;
	}
	if (type === "lifecycle.delete") {
		if (!isIdentityEvidence(value.baseEvidence)
			|| !isStateEntryId(value.payload.baseBindingId)
			|| !OP_ID_PATTERN.test(readString(value.payload.deleteOpId))
			|| value.payload.deleteOpId !== value.opId
			|| !isArtifactRef(value.payload.deletedPayload)) {
			throw new Error("Invalid lifecycle.delete operation.");
		}
		return;
	}
	if (type === "lifecycle.restore") {
		if (value.baseEvidence !== null
			|| (value.payload.baseBindingId !== null && !isStateEntryId(value.payload.baseBindingId))
			|| !isStateEntryId(value.payload.deleteOpId)
			|| !isIdentityEvidence(value.payload.evidence)) {
			throw new Error("Invalid lifecycle.restore operation.");
		}
		return;
	}
	if (type === "lifecycle.purge") {
		if (value.baseEvidence !== null || !isStateEntryId(value.payload.deleteOpId)) throw new Error("Invalid lifecycle.purge operation.");
		return;
	}
	throw new Error("Unknown StateOperation type.");
}

function isControlPermit(value: unknown): boolean {
	return isRecord(value) && value.kind === "catalog-v2-control-permit"
		&& /^v_[a-f0-9]{32}$/u.test(readString(value.vaultInstanceId))
		&& isArtifactRef(value.controlGeneration)
		&& isPositiveInteger(value.controlSequence) && isPositiveInteger(value.authorityEpoch)
		&& WRITER_ID_PATTERN.test(readString(value.authorityWriterId))
		&& OP_ID_PATTERN.test(readString(value.actionId))
		&& ["identity_adoption", "identity_repair", "migration_finalize", "contract_change", "authority_transfer"].includes(readString(value.actionKind))
		&& SHA256_PATTERN.test(readString(value.inputDigest))
		&& isValidDateTime(value.authorizedAt)
		&& SHA256_PATTERN.test(readString(value.stateGenerationId))
		&& SHA256_PATTERN.test(readString(value.contractDigest));
}

function validateOperationSequence(operations: readonly StateOperation[]): void {
	if (operations.length === 0) return;
	const writerId = operations[0]?.writerId;
	let previousSequence = 0;
	for (const operation of operations) {
		assertStateOperation(operation);
		if (operation.writerId !== writerId) {
			throw new Error("State segment operations must use one writerId.");
		}
		if (operation.sequence <= previousSequence) {
			throw new Error("State segment sequence must be strictly increasing.");
		}
		previousSequence = operation.sequence;
	}
}

function assertArtifactRef(value: ArtifactRef): void {
	if (!isArtifactRef(value)) {
		throw new Error("Invalid artifact reference.");
	}
}

function isArtifactRef(value: unknown): value is ArtifactRef {
	return isRecord(value) && isVaultPath(value.path) && SHA256_PATTERN.test(readString(value.sha256))
		&& typeof value.byteLength === "number" && Number.isInteger(value.byteLength) && value.byteLength >= 1;
}

function isIdentityEvidence(value: unknown): value is IdentityEvidence {
	if (!isRecord(value) || !isVaultPath(value.sourcePath) || !SHA256_PATTERN.test(readString(value.sourceRevision))
		|| !LOGICAL_DATE_PATTERN.test(readString(value.logicalDate))
		|| (value.section !== null && typeof value.section !== "string")
		|| typeof value.startLine !== "number" || !Number.isInteger(value.startLine) || value.startLine < 0
		|| typeof value.endLine !== "number" || !Number.isInteger(value.endLine) || value.endLine < value.startLine
		|| !MEMO_TIME_PATTERN.test(readString(value.time)) || !CONTENT_HASH_PATTERN.test(readString(value.contentHash))
		|| (value.existingBlockId !== null && (typeof value.existingBlockId !== "string" || value.existingBlockId.length === 0))) {
		return false;
	}
	return true;
}

function isMemoId(value: unknown): value is string {
	return typeof value === "string" && MEMO_ID_PATTERN.test(value);
}

function isVaultPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\")
		&& !/(^|\/)\.{1,2}(\/|$)/.test(value) && !/[\u0000-\u001f]/.test(value);
}

function toCanonicalValue(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Canonical JSON rejects non-finite numbers.");
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(toCanonicalValue);
	}
	if (isRecord(value)) {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort(compareText)) {
			const item = value[key];
			if (item === undefined) throw new Error("Canonical JSON rejects undefined values.");
			result[key] = toCanonicalValue(item);
		}
		return result;
	}
	throw new Error(`Canonical JSON rejects ${typeof value}.`);
}

function compareOperations(left: StateOperation, right: StateOperation): number {
	return left.sequence - right.sequence || compareText(left.opId, right.opId);
}

export function compareText(left: string, right: string): number {
	const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
	const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
	const length = Math.min(leftPoints.length, rightPoints.length);
	for (let index = 0; index < length; index += 1) {
		const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return leftPoints.length - rightPoints.length;
}

function fillCryptoRandom(target: Uint8Array): void {
	const cryptoApi = typeof crypto === "undefined" ? undefined : crypto;
	if (cryptoApi?.getRandomValues === undefined) {
		throw new Error("Web Crypto random source is unavailable.");
	}
	cryptoApi.getRandomValues(target);
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isValidDateTime(value: unknown): boolean {
	return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isStateEntryId(value: unknown): value is string {
	return typeof value === "string" && (OP_ID_PATTERN.test(value) || LEGACY_ENTRY_ID_PATTERN.test(value));
}

function isStateEntryIdArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isStateEntryId);
}
