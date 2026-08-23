import { normalizePath, TFile } from "obsidian";
import type { App } from "obsidian";

import type {
	ArtifactRef,
	DeletedMemoPayload,
	MigrationCommit,
	MigrationPackage,
	QuarantineReceipt,
	StateOperation,
} from "../types/catalogV2";
import type {
	CatalogV2AuthorityTransferRequest,
	CatalogV2ControlGeneration,
	CatalogV2ControlGenerationSelection,
	CatalogV2ControlGenerationVerification,
	CatalogV2ControlPermit,
	CatalogV2GenerationSelection,
	CatalogV2GenerationVerification,
	CatalogV2ImmutableStateSegment,
	CatalogV2MutationCommitArtifact,
	CatalogV2MutationAbandonArtifact,
	CatalogV2MutationPrepareArtifact,
	CatalogV2StateGeneration,
	CatalogV2VaultBootstrap,
	CatalogV2VaultContract,
	CatalogV2VerifiedStateGeneration,
	CatalogV2VerifiedControlGeneration,
	CatalogV2VerifiedVaultContext,
	CatalogV2WriterHead,
	CatalogV2WriterRegistration,
} from "../types/catalogV2Protocol";
import type { StateOperationDraft } from "../types/catalogV2Runtime";
import { isRecord } from "../utils/object";
import {
	getCatalogBootstrapPath,
	getCatalogAuthorityRequestPath,
	getCatalogAuthorityRequestsRootPath,
	getCatalogControlGenerationPath,
	getCatalogControlGenerationsRootPath,
	getCatalogContractPath,
	getCatalogMutationsRootPath,
	getCatalogStateGenerationPath,
	getCatalogStateGenerationsRootPath,
	getCatalogWriterRegistrationPath,
	getCatalogWriterRootPath,
} from "../utils/path";
import { ensureFolder, getParentFolderPath } from "../utils/vault";
import {
	assertDeletedMemoPayload,
	assertStateOperation,
	canonicalJson,
	canonicalJsonFileBytes,
	createCatalogV2Id,
	sha256Bytes,
	sha256Text,
} from "./CatalogV2Protocol";
import { calculateMigrationDomainCounts } from "./CatalogV2Migration";
import { CATALOG_V2_MONTHLY_RENDERER_VERSION } from "./CatalogV2MonthlyProjection";
import {
	assertMigrationCommit,
	assertMigrationPackage,
	assertQuarantineReceipt,
} from "./CatalogV2MigrationArtifactStore";
import { CATALOG_PARSER_VERSION } from "./DiaryMemoParser";
import {
	assertMutationCommit,
	assertMutationAbandon,
	assertMutationPrepare,
	mutationControlInputDigest,
} from "./CatalogV2SharedMutationStore";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const WRITER_ID_PATTERN = /^w_[a-f0-9]{32}$/u;
const VAULT_ID_PATTERN = /^v_[a-f0-9]{32}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

export type CatalogV2VaultContextLoadResult =
	| { kind: "ready"; context: CatalogV2VerifiedVaultContext }
	| { kind: "missing" }
	| { kind: "awaiting_data"; missingPaths: string[] }
	| { kind: "attention"; reasons: string[] };

export interface CatalogV2InitializeVaultInput {
	catalogDataRoot: string;
	contract: CatalogV2VaultContract;
	initialWriterId: string;
	createdAt: string;
	vaultInstanceId?: string;
	initializationMode?: "native" | "legacy_upgrade";
}

interface ArtifactReadResult<T> {
	value: T;
	ref: ArtifactRef;
	bytes: Uint8Array;
}

interface HeadChainResult {
	head: CatalogV2WriterHead;
	operations: StateOperation[];
}

export class CatalogV2VaultProtocol {
	constructor(private readonly app: App) {}

	async loadVaultContext(): Promise<CatalogV2VaultContextLoadResult> {
		const candidatePaths = this.listBootstrapCandidatePaths();
		if (candidatePaths.length === 0) return { kind: "missing" };
		const canonicalPath = getCatalogBootstrapPath();
		if (!candidatePaths.includes(canonicalPath)) {
			return { kind: "attention", reasons: ["canonical_bootstrap_missing"] };
		}
		return this.loadVaultContextCandidates(candidatePaths);
	}

	async loadConfiguredVaultContext(catalogDataRoot: string): Promise<CatalogV2VaultContextLoadResult> {
		const canonicalPath = getCatalogBootstrapPath();
		if (!(this.app.vault.getAbstractFileByPath(canonicalPath) instanceof TFile)) return { kind: "missing" };
		const result = await this.loadVaultContextCandidates([canonicalPath]);
		if (result.kind !== "ready") return result;
		return normalizePath(result.context.bootstrap.catalogDataRoot) === normalizePath(catalogDataRoot)
			? result
			: { kind: "attention", reasons: ["configured_catalog_root_mismatch"] };
	}

	private async loadVaultContextCandidates(
		candidatePaths: readonly string[],
	): Promise<CatalogV2VaultContextLoadResult> {
		const contexts: CatalogV2VerifiedVaultContext[] = [];
		const reasons: string[] = [];
		const missingPaths: string[] = [];
		for (const path of candidatePaths) {
			try {
				const bootstrapRead = await this.readCanonicalArtifact(path, assertVaultBootstrap);
				const contractRead = await this.readArtifactRef(bootstrapRead.value.contract, assertVaultContract);
				if (contractRead === null) {
					missingPaths.push(bootstrapRead.value.contract.path);
					continue;
				}
				if (bootstrapRead.value.contract.sha256 !== contractRead.ref.sha256) {
					reasons.push(`contract_digest_mismatch:${path}`);
					continue;
				}
				const bootstrapContext = {
					bootstrap: bootstrapRead.value,
					bootstrapSha256: bootstrapRead.ref.sha256,
					contract: contractRead.value,
					contractRef: contractRead.ref,
					contractSha256: contractRead.ref.sha256,
				};
				const control = await this.verifyControlGenerationGraph(
					bootstrapContext,
					bootstrapRead.value.controlGenesis,
					new Map(),
					new Set(),
				);
				if (control.kind === "awaiting_data") {
					missingPaths.push(...control.missingPaths);
					continue;
				}
				if (control.kind === "invalid") {
					reasons.push(`invalid_control:${control.reason}`);
					continue;
				}
				const provisionalContext: CatalogV2VerifiedVaultContext = {
					...bootstrapContext,
					control: control.value,
				};
				const selectedControl = await this.selectControlGeneration(provisionalContext);
				if (selectedControl.kind === "awaiting_data") {
					missingPaths.push(...selectedControl.missingPaths);
					continue;
				}
				if (selectedControl.kind === "invalid") {
					reasons.push(...selectedControl.reasons.map((reason) => `invalid_control:${reason}`));
					continue;
				}
				if (selectedControl.kind === "forked") {
					reasons.push(`control_fork:${selectedControl.generationRefs.map((ref) => ref.sha256).join(",")}`);
					continue;
				}
				const activeContract = await this.readArtifactRef(selectedControl.value.generation.contract, assertVaultContract);
				if (activeContract === null) {
					missingPaths.push(selectedControl.value.generation.contract.path);
					continue;
				}
				contexts.push({
					...bootstrapContext,
					contract: activeContract.value,
					contractRef: activeContract.ref,
					contractSha256: activeContract.ref.sha256,
					control: selectedControl.value,
				});
			} catch (error) {
				reasons.push(`invalid_bootstrap:${path}:${errorMessage(error)}`);
			}
		}
		const vaultIds = new Set(contexts.map((context) => context.bootstrap.vaultInstanceId));
		const bootstrapDigests = new Set(contexts.map((context) => context.bootstrapSha256));
		if (contexts.length === 0 && reasons.length === 0 && missingPaths.length > 0) {
			return { kind: "awaiting_data", missingPaths: [...new Set(missingPaths)].sort() };
		}
		if (contexts.length !== 1 || vaultIds.size !== 1 || bootstrapDigests.size !== 1 || reasons.length > 0) {
			return {
				kind: "attention",
				reasons: [
					...reasons,
					...missingPaths.map((path) => `missing_contract:${path}`),
					...(candidatePaths.length > 1 ? ["multiple_bootstrap_candidates"] : []),
				].sort(),
			};
		}
		return { kind: "ready", context: contexts[0] as CatalogV2VerifiedVaultContext };
	}

	async initializeVault(input: CatalogV2InitializeVaultInput): Promise<CatalogV2VerifiedVaultContext> {
		if (!WRITER_ID_PATTERN.test(input.initialWriterId)) throw new Error("Invalid initial writerId.");
		if (!isIsoDate(input.createdAt)) throw new Error("Invalid bootstrap createdAt.");
		assertVaultContract(input.contract);
		const existing = await this.loadVaultContext();
		if (existing.kind === "ready") return existing.context;
		if (existing.kind === "awaiting_data") {
			throw new Error(`Catalog bootstrap is still syncing: ${existing.missingPaths.join(",")}`);
		}
		if (existing.kind === "attention") throw new Error(`Catalog bootstrap requires attention: ${existing.reasons.join(",")}`);

		const contractBytes = canonicalJsonFileBytes(input.contract);
		const contractSha256 = await sha256Bytes(contractBytes);
		const contractPath = getCatalogContractPath(input.catalogDataRoot, contractSha256);
		const contractRef = await this.writeImmutable(contractPath, contractBytes);
		const vaultInstanceId = input.vaultInstanceId ?? createCatalogV2Id("v");
		const initialRegistration = await this.writeWriterRegistration({
			kind: "knomo.catalog-v2.writer-registration",
			schemaVersion: 2,
			vaultInstanceId,
			writerId: input.initialWriterId,
			createdAt: input.createdAt,
		}, input.catalogDataRoot);
		const controlGeneration: CatalogV2ControlGeneration = {
			kind: "knomo.catalog-v2.control-generation",
			schemaVersion: 2,
			vaultInstanceId,
			controlSequence: 1,
			authorityEpoch: 1,
			parent: null,
			authorityWriterId: input.initialWriterId,
			contract: contractRef,
			stateGeneration: null,
			writerFrontier: [{
				writerId: input.initialWriterId,
				registration: initialRegistration,
				head: null,
				lastSequence: 0,
				affectedMemoIds: [],
			}],
			consumedAuthorityRequestIds: [],
			action: {
				actionId: createCatalogV2Id("o"),
				kind: "genesis",
				inputDigest: null,
				memoIds: [],
				authorityRequest: null,
				nextAuthorityWriterId: null,
				nextContract: null,
			},
			createdByWriterId: input.initialWriterId,
			createdAt: input.createdAt,
		};
		const controlGenesis = await this.writeControlGenerationArtifact(input.catalogDataRoot, controlGeneration);
		const bootstrap: CatalogV2VaultBootstrap = {
			kind: "knomo.catalog-v2.vault-bootstrap",
			schemaVersion: 2,
			protocolVersion: 2,
			initializationMode: input.initializationMode ?? "native",
			vaultInstanceId,
			catalogDataRoot: normalizeCatalogDataRoot(input.catalogDataRoot),
			contract: contractRef,
			controlGenesis,
			initialWriterId: input.initialWriterId,
			createdAt: input.createdAt,
		};
		assertVaultBootstrap(bootstrap);
		const bootstrapBytes = canonicalJsonFileBytes(bootstrap);
		const bootstrapRef = await this.writeImmutable(getCatalogBootstrapPath(), bootstrapBytes);
		return {
			bootstrap,
			bootstrapSha256: bootstrapRef.sha256,
			contract: input.contract,
			contractRef,
			contractSha256,
			control: { generation: controlGeneration, generationRef: controlGenesis },
		};
	}

	async ensureWriterRegistration(
		context: CatalogV2VerifiedVaultContext,
		writerId: string,
		createdAt: string,
	): Promise<ArtifactRef> {
		if (!WRITER_ID_PATTERN.test(writerId)) throw new Error("Invalid writerId.");
		if (!isIsoDate(createdAt)) throw new Error("Invalid writer registration createdAt.");
		const prefix = `${getCatalogWriterRootPath(context.bootstrap.catalogDataRoot, writerId)}/registration-`;
		for (const file of this.app.vault.getFiles().sort((left, right) => left.path.localeCompare(right.path))) {
			if (!file.path.startsWith(prefix) || !file.path.endsWith(".json")) continue;
			try {
				const existing = await this.readCanonicalArtifact(file.path, assertWriterRegistration);
				if (existing.value.vaultInstanceId === context.bootstrap.vaultInstanceId
					&& existing.value.writerId === writerId) return existing.ref;
			} catch {
				// 无效注册不会被复用，由 generation verifier 进入 attention。
			}
		}
		const registration: CatalogV2WriterRegistration = {
			kind: "knomo.catalog-v2.writer-registration",
			schemaVersion: 2,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			writerId,
			createdAt,
		};
		return this.writeWriterRegistration(registration, context.bootstrap.catalogDataRoot);
	}

	private async writeWriterRegistration(
		registration: CatalogV2WriterRegistration,
		catalogDataRoot: string,
	): Promise<ArtifactRef> {
		assertWriterRegistration(registration);
		const bytes = canonicalJsonFileBytes(registration);
		const digest = await sha256Bytes(bytes);
		return this.writeImmutable(getCatalogWriterRegistrationPath(catalogDataRoot, registration.writerId, digest), bytes);
	}

	async refreshControl(context: CatalogV2VerifiedVaultContext): Promise<CatalogV2ControlGenerationSelection> {
		return this.selectControlGeneration({ ...context, control: context.control });
	}

	async authorizeControlAction(
		context: CatalogV2VerifiedVaultContext,
		writerId: string,
		input: {
			actionId: string;
			kind: Exclude<CatalogV2ControlGeneration["action"]["kind"], "genesis" | "authority_transfer" | "contract_change">;
			inputDigest: string;
			memoIds?: readonly string[];
		},
	): Promise<CatalogV2ControlPermit> {
		if (!SHA256_PATTERN.test(input.inputDigest)) throw new Error("Control action requires a canonical input digest.");
		const current = await this.requireCurrentControl(context, writerId);
		const memoIds = [...new Set(input.memoIds ?? [])].sort();
		if (current.generation.action.actionId === input.actionId) {
			if (current.generation.action.kind !== input.kind
				|| current.generation.action.inputDigest !== input.inputDigest
				|| canonicalJson(current.generation.action.memoIds) !== canonicalJson(memoIds)) {
				throw new Error("Control actionId is already bound to another input.");
			}
			return controlPermitFromGeneration(current);
		}
		const state = await this.selectGeneration({ ...context, control: current });
		if (state.kind !== "verified" && !(state.kind === "empty" && input.kind === "migration_finalize")) {
			throw new Error("A verified StateGeneration is required for a control commit.");
		}
		const generation = await this.writeNextControlGeneration(context, current, {
				actionId: input.actionId,
				kind: input.kind,
				inputDigest: input.inputDigest,
				memoIds,
			authorityRequest: null,
			nextAuthorityWriterId: null,
			nextContract: null,
		}, state.kind === "verified" ? state.value : null, writerId, current.generation.authorityEpoch,
			current.generation.authorityWriterId, current.generation.contract, new Date().toISOString());
		return controlPermitFromGeneration(generation);
	}

	async requestAuthorityTransfer(
		context: CatalogV2VerifiedVaultContext,
		targetWriterId: string,
		requestedAt: string,
		requestId = createCatalogV2Id("o"),
	): Promise<ArtifactRef> {
		if (!WRITER_ID_PATTERN.test(targetWriterId) || !isIsoDate(requestedAt)) {
			throw new Error("Invalid authority transfer request.");
		}
		const registration = await this.ensureWriterRegistration(context, targetWriterId, requestedAt);
		const request: CatalogV2AuthorityTransferRequest = {
			kind: "knomo.catalog-v2.authority-transfer-request",
			schemaVersion: 2,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			requestId,
			targetWriterId,
			registration,
			requestedAt,
		};
		assertAuthorityTransferRequest(request);
		const bytes = canonicalJsonFileBytes(request);
		const digest = await sha256Bytes(bytes);
		return this.writeImmutable(getCatalogAuthorityRequestPath(context.bootstrap.catalogDataRoot, requestId, digest), bytes);
	}

	async listAuthorityTransferRequests(
		context: CatalogV2VerifiedVaultContext,
	): Promise<Array<{ request: CatalogV2AuthorityTransferRequest; requestRef: ArtifactRef }>> {
		const root = `${getCatalogAuthorityRequestsRootPath(context.bootstrap.catalogDataRoot)}/`;
		const requests: Array<{ request: CatalogV2AuthorityTransferRequest; requestRef: ArtifactRef }> = [];
		for (const file of this.app.vault.getFiles().sort((left, right) => left.path.localeCompare(right.path))) {
			if (!file.path.startsWith(root) || file.path.slice(root.length).includes("/")) continue;
			const match = /\/request-(o_[a-f0-9]{32})-([a-f0-9]{64})\.json$/u.exec(file.path);
			if (match === null) continue;
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			const requestRef: ArtifactRef = { path: file.path, sha256: match[2] ?? "", byteLength: bytes.byteLength };
			const read = await this.readArtifactRef(requestRef, assertAuthorityTransferRequest);
			if (read === null || read.value.vaultInstanceId !== context.bootstrap.vaultInstanceId
				|| read.value.requestId !== match[1]) continue;
			requests.push({ request: read.value, requestRef: read.ref });
		}
		const selected = await this.refreshControl(context);
		if (selected.kind !== "verified") throw new Error(`Control generation is not singular and verified: ${selected.kind}.`);
		return requests.filter((item) => !selected.value.generation.consumedAuthorityRequestIds.includes(item.request.requestId));
	}

	async transferAuthority(
		context: CatalogV2VerifiedVaultContext,
		currentWriterId: string,
		requestRef: ArtifactRef,
		createdAt: string,
		actionId = createCatalogV2Id("o"),
	): Promise<CatalogV2VerifiedControlGeneration> {
		const current = await this.requireCurrentControl(context, currentWriterId);
		const request = await this.readArtifactRef(requestRef, assertAuthorityTransferRequest);
		if (request === null) throw new Error("Authority transfer request is still syncing.");
		if (request.value.vaultInstanceId !== context.bootstrap.vaultInstanceId) {
			throw new Error("Authority transfer request belongs to another Vault.");
		}
		const registration = await this.readArtifactRef(request.value.registration, assertWriterRegistration);
		if (registration === null || registration.value.writerId !== request.value.targetWriterId) {
			throw new Error("Authority transfer target registration is unavailable.");
		}
		const state = await this.selectGeneration({ ...context, control: current });
		if (state.kind !== "verified") throw new Error("Authority transfer requires a verified StateGeneration.");
		return this.writeNextControlGeneration(context, current, {
			actionId,
			kind: "authority_transfer",
			inputDigest: requestRef.sha256,
			memoIds: [],
			authorityRequest: requestRef,
			nextAuthorityWriterId: request.value.targetWriterId,
			nextContract: null,
		}, state.value, currentWriterId, current.generation.authorityEpoch + 1,
			request.value.targetWriterId, current.generation.contract, createdAt);
	}

	async updateContract(
		context: CatalogV2VerifiedVaultContext,
		writerId: string,
		contract: CatalogV2VaultContract,
		createdAt: string,
		actionId = createCatalogV2Id("o"),
	): Promise<CatalogV2VerifiedControlGeneration> {
		assertVaultContract(contract);
		const current = await this.requireCurrentControl(context, writerId);
		const bytes = canonicalJsonFileBytes(contract);
		const digest = await sha256Bytes(bytes);
		const nextContract = await this.writeImmutable(getCatalogContractPath(context.bootstrap.catalogDataRoot, digest), bytes);
		const state = await this.selectGeneration({ ...context, control: current });
		if (state.kind !== "verified") throw new Error("Contract change requires a verified StateGeneration.");
		return this.writeNextControlGeneration(context, current, {
			actionId,
			kind: "contract_change",
			inputDigest: nextContract.sha256,
			memoIds: [],
			authorityRequest: null,
			nextAuthorityWriterId: null,
			nextContract,
		}, state.value, writerId, current.generation.authorityEpoch, writerId, nextContract, createdAt);
	}

	async validateControlPermit(
		context: CatalogV2VerifiedVaultContext,
		permit: CatalogV2ControlPermit,
		expectedKind: CatalogV2ControlPermit["actionKind"],
		expected: { inputDigest?: string; memoIds?: readonly string[] } = {},
	): Promise<boolean> {
		if (permit.kind !== "catalog-v2-control-permit" || permit.actionKind !== expectedKind
			|| permit.vaultInstanceId !== context.bootstrap.vaultInstanceId) return false;
		const selected = await this.refreshControl(context);
		if (selected.kind !== "verified" || !sameArtifactRef(selected.value.generationRef, permit.controlGeneration)) return false;
		const control = selected.value.generation;
		return control.controlSequence === permit.controlSequence
			&& control.authorityEpoch === permit.authorityEpoch
			&& control.authorityWriterId === permit.authorityWriterId
			&& control.action.actionId === permit.actionId
			&& control.action.kind === permit.actionKind
			&& control.action.inputDigest === permit.inputDigest
			&& permit.inputDigest === (expected.inputDigest ?? control.action.inputDigest)
			&& canonicalJson(control.action.memoIds) === canonicalJson([...new Set(expected.memoIds ?? control.action.memoIds)].sort())
			&& control.contract.sha256 === permit.contractDigest
			&& control.stateGeneration?.sha256 === permit.stateGenerationId;
	}

	async selectControlGeneration(context: CatalogV2VerifiedVaultContext): Promise<CatalogV2ControlGenerationSelection> {
		const refs = await this.listControlGenerationRefs(context);
		if (!refs.some((ref) => sameArtifactRef(ref, context.bootstrap.controlGenesis))) refs.push(context.bootstrap.controlGenesis);
		const results = await Promise.all(refs.map((ref) => this.verifyControlGenerationGraph(context, ref, new Map(), new Set())));
		const awaiting = results.filter((item): item is Extract<CatalogV2ControlGenerationVerification, { kind: "awaiting_data" }> => item.kind === "awaiting_data");
		if (awaiting.length > 0) return { kind: "awaiting_data", missingPaths: [...new Set(awaiting.flatMap((item) => item.missingPaths))].sort() };
		const invalid = results.flatMap((item) => item.kind === "invalid" ? [item.reason] : []);
		if (invalid.length > 0) return { kind: "invalid", reasons: [...new Set(invalid)].sort() };
		const verified = results.flatMap((item) => item.kind === "verified" ? [item.value] : []);
		const parentDigests = new Set(verified.flatMap((item) => item.generation.parent === null ? [] : [item.generation.parent.sha256]));
		const tips = verified.filter((item) => !parentDigests.has(item.generationRef.sha256));
		const maximumEpoch = Math.max(...tips.map((item) => item.generation.authorityEpoch));
		const fencedTips = tips.filter((item) => item.generation.authorityEpoch === maximumEpoch);
		return tips.length === 1
			? { kind: "verified", value: tips[0] as CatalogV2VerifiedControlGeneration }
			: fencedTips.length === 1
				? { kind: "verified", value: fencedTips[0] as CatalogV2VerifiedControlGeneration }
				: { kind: "forked", generationRefs: fencedTips.map((item) => item.generationRef).sort(compareRefs) };
	}

	private async listControlGenerationRefs(context: CatalogV2VerifiedVaultContext): Promise<ArtifactRef[]> {
		const root = `${getCatalogControlGenerationsRootPath(context.bootstrap.catalogDataRoot)}/`;
		const refs: ArtifactRef[] = [];
		for (const file of this.app.vault.getFiles()) {
			if (!file.path.startsWith(root) || file.path.slice(root.length).includes("/")) continue;
			const match = /\/control-([a-f0-9]{64})\.json$/u.exec(file.path);
			if (match === null) continue;
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			refs.push({ path: file.path, sha256: match[1] ?? "", byteLength: bytes.byteLength });
		}
		return refs.sort(compareRefs);
	}

	private async verifyControlGenerationGraph(
		context: Omit<CatalogV2VerifiedVaultContext, "control">,
		generationRef: ArtifactRef,
		cache: Map<string, CatalogV2ControlGenerationVerification>,
		stack: Set<string>,
	): Promise<CatalogV2ControlGenerationVerification> {
		const key = generationRef.sha256;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		if (stack.has(key)) return { kind: "invalid", generationRef, reason: "control_parent_cycle" };
		stack.add(key);
		try {
			const read = await this.readArtifactRef(generationRef, assertControlGeneration);
			if (read === null) return { kind: "awaiting_data", generationRef, missingPaths: [generationRef.path] };
			const value = read.value;
			let parentGeneration: CatalogV2ControlGeneration | null = null;
			if (value.vaultInstanceId !== context.bootstrap.vaultInstanceId) {
				return { kind: "invalid", generationRef, reason: "control_vault_mismatch" };
			}
			if (value.parent === null) {
				if (!sameArtifactRef(read.ref, context.bootstrap.controlGenesis) || value.controlSequence !== 1
					|| value.authorityEpoch !== 1 || value.action.kind !== "genesis"
					|| value.authorityWriterId !== context.bootstrap.initialWriterId
					|| !sameArtifactRef(value.contract, context.bootstrap.contract)) {
					return { kind: "invalid", generationRef, reason: "invalid_control_genesis" };
				}
			} else {
				const parent = await this.verifyControlGenerationGraph(context, value.parent, cache, stack);
				if (parent.kind !== "verified") return parent.kind === "awaiting_data"
					? { kind: "awaiting_data", generationRef, missingPaths: parent.missingPaths }
					: { kind: "invalid", generationRef, reason: `invalid_control_parent:${parent.reason}` };
				const previous = parent.value.generation;
				parentGeneration = previous;
				if (value.controlSequence !== previous.controlSequence + 1
					|| value.createdByWriterId !== previous.authorityWriterId
					|| (value.action.kind === "authority_transfer"
						? value.authorityEpoch !== previous.authorityEpoch + 1
							|| value.authorityWriterId !== value.action.nextAuthorityWriterId
						: value.authorityEpoch !== previous.authorityEpoch
							|| value.authorityWriterId !== previous.authorityWriterId)
					|| (value.action.kind === "contract_change"
						? value.action.nextContract === null || !sameArtifactRef(value.contract, value.action.nextContract)
						: !sameArtifactRef(value.contract, previous.contract))) {
					return { kind: "invalid", generationRef, reason: "invalid_control_transition" };
				}
				const consumed = new Set(value.consumedAuthorityRequestIds);
				if (previous.consumedAuthorityRequestIds.some((requestId) => !consumed.has(requestId))) {
					return { kind: "invalid", generationRef, reason: "consumed_authority_request_removed" };
				}
				const added = value.consumedAuthorityRequestIds.filter((requestId) =>
					!previous.consumedAuthorityRequestIds.includes(requestId));
				const expectedRequestId = value.action.authorityRequest?.path
					.match(/request-(o_[a-f0-9]{32})-/u)?.[1] ?? null;
				if (value.action.kind === "authority_transfer"
					? expectedRequestId === null || added.length !== 1 || added[0] !== expectedRequestId
					: added.length !== 0) {
					return { kind: "invalid", generationRef, reason: "invalid_consumed_authority_request" };
				}
				const previousFrontier = new Map(previous.writerFrontier.map((frontier) => [frontier.writerId, frontier]));
				const nextFrontier = new Map(value.writerFrontier.map((frontier) => [frontier.writerId, frontier]));
				for (const [writerId, frontier] of previousFrontier) {
					const next = nextFrontier.get(writerId);
					if (next === undefined || !sameArtifactRef(next.registration, frontier.registration)
						|| next.lastSequence < frontier.lastSequence
						|| frontier.affectedMemoIds.some((memoId) => !next.affectedMemoIds.includes(memoId))) {
						return { kind: "invalid", generationRef, reason: `control_frontier_reduced:${writerId}` };
					}
					if (frontier.head !== null && (next.head === null || !await this.isHeadDescendant(next.head, frontier.head))) {
						return { kind: "invalid", generationRef, reason: `control_frontier_rewound:${writerId}` };
					}
				}
				if (value.action.kind === "authority_transfer") {
					const target = value.action.nextAuthorityWriterId === null
						? undefined
						: nextFrontier.get(value.action.nextAuthorityWriterId);
					const request = value.action.authorityRequest === null
						? null
						: await this.readArtifactRef(value.action.authorityRequest, assertAuthorityTransferRequest);
					if (target === undefined || request === null
						|| request.value.vaultInstanceId !== value.vaultInstanceId
						|| request.value.targetWriterId !== value.action.nextAuthorityWriterId
						|| value.action.inputDigest !== value.action.authorityRequest?.sha256
						|| !sameArtifactRef(target.registration, request.value.registration)) {
						return { kind: "invalid", generationRef, reason: "authority_writer_frontier_missing" };
					}
				}
			}
			for (const frontier of value.writerFrontier) {
				const registration = await this.readArtifactRef(frontier.registration, assertWriterRegistration);
				if (registration === null) return { kind: "awaiting_data", generationRef, missingPaths: [frontier.registration.path] };
				if (registration.value.vaultInstanceId !== value.vaultInstanceId
					|| registration.value.writerId !== frontier.writerId) {
					return { kind: "invalid", generationRef, reason: `control_writer_registration_mismatch:${frontier.writerId}` };
				}
				if (frontier.head !== null) {
					const chain = await this.readHeadChain(value.vaultInstanceId, frontier.writerId, frontier.head, []);
					if (chain === null) return { kind: "awaiting_data", generationRef, missingPaths: [frontier.head.path] };
					if (chain.head.lastSequence !== frontier.lastSequence) return { kind: "invalid", generationRef, reason: "control_frontier_sequence_mismatch" };
				}
			}
			if (value.stateGeneration !== null) {
				const stateRead = await this.readArtifactRef(value.stateGeneration, assertStateGeneration);
				if (stateRead === null) return { kind: "awaiting_data", generationRef, missingPaths: [value.stateGeneration.path] };
				const state = stateRead.value;
				const expectedStateContract = value.action.kind === "contract_change" && parentGeneration !== null
					? parentGeneration.contract
					: value.contract;
				if (state.vaultInstanceId !== value.vaultInstanceId || !sameArtifactRef(state.contract, expectedStateContract)) {
					return { kind: "invalid", generationRef, reason: "control_state_scope_mismatch" };
				}
				const stateFrontier = state.writers.map((writer) => ({
					writerId: writer.writerId,
					registration: writer.registration,
					head: writer.head,
					lastSequence: writer.head === null ? 0 : value.writerFrontier
						.find((frontier) => frontier.writerId === writer.writerId)?.lastSequence ?? -1,
					affectedMemoIds: writer.affectedMemoIds,
				}));
				const stateWriterIds = new Set(state.writers.map((writer) => writer.writerId));
				const comparableFrontier = value.writerFrontier.filter((frontier) => stateWriterIds.has(frontier.writerId));
				if (canonicalJson(stateFrontier) !== canonicalJson(comparableFrontier)) {
					return { kind: "invalid", generationRef, reason: "control_writer_frontier_mismatch" };
				}
				const previousFrontier = new Map(parentGeneration?.writerFrontier.map((frontier) => [frontier.writerId, frontier]) ?? []);
				for (const extra of value.writerFrontier.filter((frontier) => !stateWriterIds.has(frontier.writerId))) {
					const previous = previousFrontier.get(extra.writerId);
					const introducedByTransfer = value.action.kind === "authority_transfer"
						&& value.action.nextAuthorityWriterId === extra.writerId;
					if (extra.head !== null || extra.lastSequence !== 0 || extra.affectedMemoIds.length !== 0
						|| (!introducedByTransfer && (previous === undefined || !sameArtifactRef(previous.registration, extra.registration)))) {
						return { kind: "invalid", generationRef, reason: `control_writer_frontier_without_state:${extra.writerId}` };
					}
				}
			}
			const result = { kind: "verified", value: { generation: value, generationRef: read.ref } } as const;
			cache.set(key, result);
			return result;
		} catch (error) {
			return { kind: "invalid", generationRef, reason: errorMessage(error) };
		} finally {
			stack.delete(key);
		}
	}

	async findControlGeneration(
		context: CatalogV2VerifiedVaultContext,
		generationRef: ArtifactRef,
	): Promise<CatalogV2VerifiedControlGeneration | null> {
		const result = await this.verifyControlGenerationGraph(context, generationRef, new Map(), new Set());
		return result.kind === "verified" ? result.value : null;
	}

	async findControlPermit(
		context: CatalogV2VerifiedVaultContext,
		actionKind: CatalogV2ControlPermit["actionKind"],
		inputDigest: string,
		memoIds: readonly string[],
	): Promise<CatalogV2ControlPermit | null> {
		if (!SHA256_PATTERN.test(inputDigest)) return null;
		const selected = await this.refreshControl(context);
		if (selected.kind !== "verified") return null;
		const expectedMemoIds = [...new Set(memoIds)].sort();
		let current: CatalogV2VerifiedControlGeneration | null = selected.value;
		const visited = new Set<string>();
		while (current !== null && !visited.has(current.generationRef.sha256)) {
			visited.add(current.generationRef.sha256);
			const action = current.generation.action;
			if (action.kind === actionKind && action.inputDigest === inputDigest
				&& canonicalJson(action.memoIds) === canonicalJson(expectedMemoIds)) {
				return controlPermitFromGeneration(current);
			}
			current = current.generation.parent === null
				? null
				: await this.findControlGeneration(context, current.generation.parent);
		}
		return null;
	}

	private async requireCurrentControl(
		context: CatalogV2VerifiedVaultContext,
		writerId: string,
	): Promise<CatalogV2VerifiedControlGeneration> {
		const selected = await this.refreshControl(context);
		if (selected.kind !== "verified") throw new Error(`Control generation is not singular and verified: ${selected.kind}.`);
		if (selected.value.generation.authorityWriterId !== writerId) throw new Error("This writer is not the current Catalog control authority.");
		return selected.value;
	}

	private async writeNextControlGeneration(
		context: CatalogV2VerifiedVaultContext,
		current: CatalogV2VerifiedControlGeneration,
		action: CatalogV2ControlGeneration["action"],
		state: CatalogV2VerifiedStateGeneration | null,
		createdByWriterId: string,
		authorityEpoch: number,
		authorityWriterId: string,
		contract: ArtifactRef,
		createdAt: string,
	): Promise<CatalogV2VerifiedControlGeneration> {
		if (!isIsoDate(createdAt)) throw new Error("Invalid control generation createdAt.");
		let writerFrontier = state === null ? current.generation.writerFrontier : state.generation.writers.map((writer) => ({
			writerId: writer.writerId,
			registration: writer.registration,
			head: writer.head,
			lastSequence: state.writerHeads[writer.writerId]?.lastSequence ?? 0,
			affectedMemoIds: [...writer.affectedMemoIds],
			}));
		if (state !== null) {
			const stateWriterIds = new Set(writerFrontier.map((frontier) => frontier.writerId));
			writerFrontier = [
				...writerFrontier,
				...current.generation.writerFrontier.filter((frontier) => !stateWriterIds.has(frontier.writerId)),
			].sort((left, right) => left.writerId.localeCompare(right.writerId));
		}
		if (action.kind === "authority_transfer" && action.nextAuthorityWriterId !== null && action.authorityRequest !== null
			&& !writerFrontier.some((frontier) => frontier.writerId === action.nextAuthorityWriterId)) {
			const request = await this.readArtifactRef(action.authorityRequest, assertAuthorityTransferRequest);
			if (request === null) throw new Error("Authority transfer request is unavailable.");
			writerFrontier = [...writerFrontier, {
				writerId: action.nextAuthorityWriterId,
				registration: request.value.registration,
				head: null,
				lastSequence: 0,
				affectedMemoIds: [],
			}].sort((left, right) => left.writerId.localeCompare(right.writerId));
		}
		const value: CatalogV2ControlGeneration = {
			kind: "knomo.catalog-v2.control-generation",
			schemaVersion: 2,
			vaultInstanceId: context.bootstrap.vaultInstanceId,
			controlSequence: current.generation.controlSequence + 1,
			authorityEpoch,
			parent: current.generationRef,
			authorityWriterId,
			contract,
			stateGeneration: state?.generationRef ?? null,
			writerFrontier,
			consumedAuthorityRequestIds: action.kind === "authority_transfer" && action.authorityRequest !== null
				? [...new Set([...current.generation.consumedAuthorityRequestIds, action.authorityRequest.path
					.match(/request-(o_[a-f0-9]{32})-/u)?.[1] ?? ""])].filter(Boolean).sort()
				: [...current.generation.consumedAuthorityRequestIds],
			action,
			createdByWriterId,
			createdAt,
		};
		const generationRef = await this.writeControlGenerationArtifact(context.bootstrap.catalogDataRoot, value);
		return { generation: value, generationRef };
	}

	private async writeControlGenerationArtifact(
		catalogDataRoot: string,
		generation: CatalogV2ControlGeneration,
	): Promise<ArtifactRef> {
		assertControlGeneration(generation);
		const bytes = canonicalJsonFileBytes(generation);
		const digest = await sha256Bytes(bytes);
		return this.writeImmutable(getCatalogControlGenerationPath(catalogDataRoot, digest), bytes);
	}

	async listGenerationRefs(context: CatalogV2VerifiedVaultContext): Promise<ArtifactRef[]> {
		const root = `${getCatalogStateGenerationsRootPath(context.bootstrap.catalogDataRoot)}/`;
		const refs: ArtifactRef[] = [];
		for (const file of this.app.vault.getFiles()) {
			if (!file.path.startsWith(root) || file.path.slice(root.length).includes("/")) continue;
			const match = /\/generation-([a-f0-9]{64})\.json$/u.exec(file.path);
			if (match === null) continue;
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			refs.push({ path: file.path, sha256: match[1] ?? "", byteLength: bytes.byteLength });
		}
		return refs.sort((left, right) => left.path.localeCompare(right.path));
	}

	async verifyGeneration(
		context: CatalogV2VerifiedVaultContext,
		generationRef: ArtifactRef,
	): Promise<CatalogV2GenerationVerification> {
		return this.verifyGenerationGraph(context, generationRef, new Map(), new Set());
	}

	private async verifyGenerationGraph(
		context: CatalogV2VerifiedVaultContext,
		generationRef: ArtifactRef,
		cache: Map<string, CatalogV2GenerationVerification>,
		stack: Set<string>,
	): Promise<CatalogV2GenerationVerification> {
		const key = `${generationRef.path}\u0000${generationRef.sha256}`;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		if (stack.has(key)) return { kind: "invalid", generationRef, reason: "generation_parent_cycle" };
		stack.add(key);
		const own = await this.verifyGenerationArtifact(context, generationRef);
		if (own.kind !== "verified") {
			stack.delete(key);
			cache.set(key, own);
			return own;
		}
		const awaiting: Array<Extract<CatalogV2GenerationVerification, { kind: "awaiting_data" }>> = [];
		for (const parentRef of own.value.generation.parents) {
			const parent = await this.verifyGenerationGraph(context, parentRef, cache, stack);
			if (parent.kind === "fenced") {
				const fenced = { kind: "fenced", generationRef } as const;
				stack.delete(key);
				cache.set(key, fenced);
				return fenced;
			}
			if (parent.kind === "invalid") {
				const invalid = { kind: "invalid", generationRef, reason: `invalid_parent:${parent.reason}` } as const;
				stack.delete(key);
				cache.set(key, invalid);
				return invalid;
			}
			if (parent.kind === "awaiting_data") {
				awaiting.push(parent);
				continue;
			}
			const transitionError = await this.validateGenerationTransition(parent.value, own.value);
			if (transitionError !== null) {
				const invalid = { kind: "invalid", generationRef, reason: transitionError } as const;
				stack.delete(key);
				cache.set(key, invalid);
				return invalid;
			}
		}
		stack.delete(key);
		if (awaiting.length > 0) {
			const result: CatalogV2GenerationVerification = {
				kind: "awaiting_data",
				generationRef,
				missingPaths: [...new Set(awaiting.flatMap((item) => item.missingPaths))].sort(),
				affectedMemoIds: awaiting.some((item) => item.affectedMemoIds === null)
					? null
					: [...new Set(awaiting.flatMap((item) => item.affectedMemoIds ?? []))].sort(),
				affectedWriterIds: awaiting.some((item) => item.affectedWriterIds === null)
					? null
					: [...new Set(awaiting.flatMap((item) => item.affectedWriterIds ?? []))].sort(),
			};
			cache.set(key, result);
			return result;
		}
		cache.set(key, own);
		return own;
	}

	private async validateGenerationTransition(
		parent: CatalogV2VerifiedStateGeneration,
		child: CatalogV2VerifiedStateGeneration,
	): Promise<string | null> {
		const childWriters = new Map(child.generation.writers.map((writer) => [writer.writerId, writer]));
		for (const parentWriter of parent.generation.writers) {
			const childWriter = childWriters.get(parentWriter.writerId);
			if (childWriter === undefined) return `generation_writer_removed:${parentWriter.writerId}`;
			if (!sameArtifactRef(parentWriter.registration, childWriter.registration)) {
				return `generation_writer_registration_changed:${parentWriter.writerId}`;
			}
			const childMemoIds = new Set(childWriter.affectedMemoIds);
			if (parentWriter.affectedMemoIds.some((memoId) => !childMemoIds.has(memoId))) {
				return `generation_writer_scope_reduced:${parentWriter.writerId}`;
			}
			if (parentWriter.head !== null && (childWriter.head === null
				|| !await this.isHeadDescendant(childWriter.head, parentWriter.head))) {
				return `generation_writer_head_rewound:${parentWriter.writerId}`;
			}
		}
		if (parent.generation.migrationCommit !== null) {
			if (child.generation.migrationCommit === null) return "migration_generation_removed";
			const childMemoIds = new Set(child.generation.migrationMemoIds);
			if (parent.generation.migrationMemoIds.some((memoId) => !childMemoIds.has(memoId))) {
				return "migration_scope_reduced";
			}
			if (parent.generation.migrationGenerationDigest !== child.generation.migrationGenerationDigest) {
				const parentCommit = await this.readArtifactRef(parent.generation.migrationCommit, assertProtocolMigrationCommit);
				const childCommit = await this.readArtifactRef(child.generation.migrationCommit, assertProtocolMigrationCommit);
				if (parentCommit === null || childCommit === null
					|| !migrationCommitSupersedes(childCommit.value, parentCommit.value)) {
					return "migration_generation_not_superset";
				}
			}
		}
		const childMutationRefs = new Set((child.generation.mutationCommits ?? []).map(artifactRefKey));
		if ((parent.generation.mutationCommits ?? []).some((ref) => !childMutationRefs.has(artifactRefKey(ref)))) {
			return "mutation_commit_removed";
		}
		const childMutationMemoIds = new Set(child.generation.mutationMemoIds ?? []);
		if ((parent.generation.mutationMemoIds ?? []).some((memoId) => !childMutationMemoIds.has(memoId))) {
			return "mutation_scope_reduced";
		}
		return null;
	}

	private async isHeadDescendant(child: ArtifactRef, ancestor: ArtifactRef): Promise<boolean> {
		let current: ArtifactRef | null = child;
		const visited = new Set<string>();
		while (current !== null) {
			if (sameArtifactRef(current, ancestor)) return true;
			if (visited.has(current.sha256)) return false;
			visited.add(current.sha256);
			const head: ArtifactReadResult<CatalogV2WriterHead> | null = await this.readArtifactRef(
				current,
				assertWriterHead,
			);
			if (head === null) return false;
			current = head.value.previousHead;
		}
		return false;
	}

	private async verifyGenerationArtifact(
		context: CatalogV2VerifiedVaultContext,
		generationRef: ArtifactRef,
	): Promise<CatalogV2GenerationVerification> {
		const missingPaths: string[] = [];
		try {
			const generationRead = await this.readArtifactRef(generationRef, assertStateGeneration);
			if (generationRead === null) return {
				kind: "awaiting_data",
				generationRef,
				missingPaths: [generationRef.path],
				affectedMemoIds: null,
				affectedWriterIds: null,
			};
			const generation = generationRead.value;
			if (generation.vaultInstanceId !== context.bootstrap.vaultInstanceId) {
				return { kind: "invalid", generationRef, reason: "vault_instance_mismatch" };
			}
			const generationControl = await this.verifyControlGenerationGraph(context, generation.controlGeneration, new Map(), new Set());
			if (generationControl.kind === "awaiting_data") return {
				kind: "awaiting_data",
				generationRef,
				missingPaths: generationControl.missingPaths,
				affectedMemoIds: null,
				affectedWriterIds: null,
			};
			if (generationControl.kind === "invalid") {
				return { kind: "invalid", generationRef, reason: `invalid_generation_control:${generationControl.reason}` };
			}
			const currentControl = await this.refreshControl(context);
			if (currentControl.kind === "verified"
				&& !sameArtifactRef(generationControl.value.generationRef, currentControl.value.generationRef)) {
				const anchoredState = currentControl.value.generation.stateGeneration;
				const belongsToAnchoredHistory = anchoredState !== null
					&& await this.isGenerationAncestorRaw(anchoredState, generationRef);
				if (!await this.isControlAncestor(context, generationControl.value.generationRef, currentControl.value.generationRef)
					|| (!belongsToAnchoredHistory
						&& (!sameArtifactRef(generationControl.value.generation.contract, currentControl.value.generation.contract)
							|| !await this.generationCanCrossControlFence(anchoredState, generation, generationRef)))) {
					return { kind: "fenced", generationRef };
				}
			}
			if (!sameArtifactRef(generation.contract, generationControl.value.generation.contract)) {
				return { kind: "invalid", generationRef, reason: "contract_mismatch" };
			}
			const writerHeads: Record<string, CatalogV2WriterHead | null> = {};
			const mutationPrepares: Record<string, CatalogV2MutationPrepareArtifact> = {};
			const operations: StateOperation[] = [];
			const affectedMemoIds = new Set<string>();
			const affectedWriterIds = new Set<string>();
			if (generation.migrationCommit !== null) {
				const migration = await this.readArtifactRef(generation.migrationCommit, assertProtocolMigrationCommit);
				if (migration === null) {
					missingPaths.push(generation.migrationCommit.path);
					for (const memoId of generation.migrationMemoIds) affectedMemoIds.add(memoId);
				} else {
					const migrationDigest = await migrationCommitGenerationDigest(migration.value);
					if (generation.migrationGenerationDigest !== migration.value.generationDigest
						|| generation.migrationGenerationDigest !== migrationDigest) {
						return { kind: "invalid", generationRef, reason: "migration_generation_digest_mismatch" };
					}
					const migrationMemoIds = new Set<string>();
					const migrationArtifacts: Array<{
						required: MigrationCommit["requiredArtifacts"][number];
						value: ProtocolMigrationArtifact;
					}> = [];
					for (const required of migration.value.requiredArtifacts) {
						const absoluteRef: ArtifactRef = {
							...required,
							path: normalizePath(`${context.bootstrap.catalogDataRoot}/${required.path}`),
						};
						const artifact = await this.readArtifactRef(absoluteRef, assertProtocolMigrationArtifact);
						if (artifact === null) {
							missingPaths.push(absoluteRef.path);
							for (const memoId of generation.migrationMemoIds) affectedMemoIds.add(memoId);
							continue;
						}
						if (required.artifactKind === "migration_package") {
							if (artifact.value.kind !== "knomo.catalog-v2.migration-package") {
								return { kind: "invalid", generationRef, reason: `migration_artifact_kind:${required.path}` };
							}
							for (const memoId of migrationPackageMemoIds(artifact.value)) migrationMemoIds.add(memoId);
						} else if (required.artifactKind === "quarantine_receipt"
							? artifact.value.kind !== "knomo.catalog-v2.quarantine-receipt"
							: artifact.value.kind !== "knomo.catalog-v2.deleted-payload") {
							return { kind: "invalid", generationRef, reason: `migration_artifact_kind:${required.path}` };
						}
						migrationArtifacts.push({ required, value: artifact.value });
					}
					if (missingPaths.length === 0) {
						assertMigrationArtifactBindings(migration.value, migrationArtifacts);
						const packages = migrationArtifacts.flatMap((artifact) =>
							artifact.value.kind === "knomo.catalog-v2.migration-package" ? [artifact.value] : []);
						const actualCounts = await calculateMigrationDomainCounts(packages, migration.value.legacySources);
						if (canonicalJson(actualCounts) !== canonicalJson(migration.value.domainCounts)) {
							return { kind: "invalid", generationRef, reason: "migration_domain_counts_mismatch" };
						}
						const actual = [...migrationMemoIds].sort();
						if (actual.length !== generation.migrationMemoIds.length
							|| actual.some((memoId, index) => memoId !== generation.migrationMemoIds[index])) {
							return { kind: "invalid", generationRef, reason: "migration_scope_mismatch" };
						}
					}
				}
			}
			const mutationMemoIds = new Set<string>();
			for (const commitRef of generation.mutationCommits ?? []) {
				const commitRead = await this.readArtifactRef(commitRef, assertMutationCommit);
				if (commitRead === null) {
					missingPaths.push(commitRef.path);
					for (const memoId of generation.mutationMemoIds ?? []) affectedMemoIds.add(memoId);
					continue;
				}
				const commit = commitRead.value;
				if (commit.vaultInstanceId !== generation.vaultInstanceId) {
					return { kind: "invalid", generationRef, reason: `mutation_vault_mismatch:${commit.mutationId}` };
				}
				const prepareRead = await this.readArtifactRef(commit.prepare, assertMutationPrepare);
				if (prepareRead === null) {
					missingPaths.push(commit.prepare.path);
					for (const memoId of generation.mutationMemoIds ?? []) affectedMemoIds.add(memoId);
					continue;
				}
				const prepare = prepareRead.value;
				if (prepare.vaultInstanceId !== generation.vaultInstanceId
					|| prepare.mutationId !== commit.mutationId) {
					return { kind: "invalid", generationRef, reason: `mutation_commit_mismatch:${commit.mutationId}` };
				}
				if (await this.hasMatchingMutationAbandon(context, commit, prepareRead.ref)) {
					return { kind: "invalid", generationRef, reason: `mutation_commit_abandon_conflict:${commit.mutationId}` };
				}
				mutationPrepares[commitRef.sha256] = prepare;
				const permitError = await this.validateMutationEffects(context, generationControl.value, commit, prepare);
				if (permitError !== null) {
					return { kind: "invalid", generationRef, reason: `${permitError}:${commit.mutationId}` };
				}
				const mutationWriterId = await deriveMutationWriterId(commit.mutationId);
				for (let index = 0; index < prepare.effectDrafts.length; index += 1) {
					const draft = attachMutationControl(prepare.effectDrafts[index], commit.control);
					if (draft === undefined) continue;
					const operation: StateOperation = {
						...draft,
						schemaVersion: 1,
						writerId: mutationWriterId,
						sequence: index + 1,
					};
					assertStateOperation(operation);
					operations.push(operation);
					mutationMemoIds.add(operation.memoId);
				}
				mutationMemoIds.add(prepare.memoId);
			}
			if (missingPaths.length === 0) {
				const actual = [...mutationMemoIds].sort();
				const declared = generation.mutationMemoIds ?? [];
				if (actual.length !== declared.length || actual.some((memoId, index) => memoId !== declared[index])) {
					return { kind: "invalid", generationRef, reason: "mutation_scope_mismatch" };
				}
			}
			for (const writer of generation.writers) {
				const registration = await this.readArtifactRef(writer.registration, assertWriterRegistration);
				if (registration === null) {
					missingPaths.push(writer.registration.path);
					affectedWriterIds.add(writer.writerId);
					for (const memoId of writer.affectedMemoIds) affectedMemoIds.add(memoId);
					continue;
				}
				if (registration.value.vaultInstanceId !== generation.vaultInstanceId
					|| registration.value.writerId !== writer.writerId) {
					return { kind: "invalid", generationRef, reason: `writer_registration_mismatch:${writer.writerId}` };
				}
				if (writer.head === null) {
					writerHeads[writer.writerId] = null;
					continue;
				}
				const chain = await this.readHeadChain(generation.vaultInstanceId, writer.writerId, writer.head, missingPaths);
				if (chain === null) {
					affectedWriterIds.add(writer.writerId);
					for (const memoId of writer.affectedMemoIds) affectedMemoIds.add(memoId);
					continue;
				}
				const actualMemoIds = [...new Set(chain.operations.map((operation) => operation.memoId))].sort();
				if (actualMemoIds.length !== writer.affectedMemoIds.length
					|| actualMemoIds.some((memoId, index) => memoId !== writer.affectedMemoIds[index])) {
					return { kind: "invalid", generationRef, reason: `writer_scope_mismatch:${writer.writerId}` };
				}
				if (chain.operations.some((operation) => isControlBoundIdentityOperation(operation))) {
					return {
						kind: "invalid",
						generationRef,
						reason: `controlled_identity_operation_outside_mutation:${writer.writerId}`,
					};
				}
				writerHeads[writer.writerId] = chain.head;
				operations.push(...chain.operations);
			}
			if (missingPaths.length > 0) {
				return {
					kind: "awaiting_data",
					generationRef,
					missingPaths: [...new Set(missingPaths)].sort(),
					affectedMemoIds: [...affectedMemoIds].sort(),
					affectedWriterIds: [...affectedWriterIds].sort(),
				};
			}
			return {
				kind: "verified",
				value: {
					generation,
					generationRef: generationRead.ref,
					operations: operations.sort(compareOperations),
					writerHeads,
					mutationPrepares,
				},
			};
		} catch (error) {
			return { kind: "invalid", generationRef, reason: errorMessage(error) };
		}
	}

	private async hasMatchingMutationAbandon(
		context: CatalogV2VerifiedVaultContext,
		commit: CatalogV2MutationCommitArtifact,
		prepareRef: ArtifactRef,
	): Promise<boolean> {
		const root = `${getCatalogMutationsRootPath(context.bootstrap.catalogDataRoot)}/${commit.mutationId}/`;
		for (const file of this.app.vault.getFiles()) {
			if (!file.path.startsWith(root) || !/\/abandon-[a-f0-9]{64}\.json$/u.test(file.path)) continue;
			const read = await this.readCanonicalArtifact(file.path, assertMutationAbandon);
			if (read !== null && read.value.vaultInstanceId === commit.vaultInstanceId
				&& read.value.mutationId === commit.mutationId
				&& sameArtifactRef(read.value.prepare, prepareRef)) return true;
		}
		return false;
	}

	private async generationCanCrossControlFence(
		anchoredState: ArtifactRef | null,
		generation: CatalogV2StateGeneration,
		generationRef: ArtifactRef,
	): Promise<boolean> {
		if (anchoredState === null) return false;
		if (await this.isGenerationAncestorRaw(anchoredState, generationRef)) return true;
		if (generation.migrationCommit !== null) return false;
		for (const commitRef of generation.mutationCommits ?? []) {
			const commit = await this.readArtifactRef(commitRef, assertMutationCommit);
			if (commit === null || commit.value.control !== null) return false;
		}
		return true;
	}

	private async validateMutationEffects(
		context: CatalogV2VerifiedVaultContext,
		generationControl: CatalogV2VerifiedControlGeneration,
		commit: CatalogV2MutationCommitArtifact,
		prepare: CatalogV2MutationPrepareArtifact,
	): Promise<string | null> {
		const requiredAction = prepare.mutationKind === "adoption"
			? "identity_adoption"
			: prepare.mutationKind === "manual_repair" ? "identity_repair" : null;
		if (requiredAction === null ? commit.control !== null : commit.control === null) {
			return "invalid_mutation_control_presence";
		}
		if (requiredAction !== null) {
				const permit = commit.control as CatalogV2ControlPermit;
				if (permit.actionKind !== requiredAction || permit.inputDigest !== await mutationControlInputDigest(prepare)
					|| permit.vaultInstanceId !== context.bootstrap.vaultInstanceId
					|| permit.contractDigest === "") {
				return "invalid_mutation_control_permit";
			}
			const control = await this.findControlGeneration(context, permit.controlGeneration);
				if (control === null || !sameControlPermit(control, permit)
					|| permit.contractDigest !== control.generation.contract.sha256
				|| !control.generation.action.memoIds.includes(prepare.memoId)
				|| !await this.isControlAncestor(context, control.generationRef, generationControl.generationRef)) {
				return "invalid_mutation_control_generation";
			}
		}
		for (const draft of prepare.effectDrafts) {
			if (draft.type === "identity.claim" && draft.payload.origin !== "plugin_create") {
				if (draft.payload.origin === "explicit_copy") continue;
				const permit = commit.control;
				if (permit === null || permit === undefined || permit.actionKind !== "identity_adoption"
					|| permit.vaultInstanceId !== context.bootstrap.vaultInstanceId
					|| permit.actionId === "" || draft.memoId !== prepare.memoId) return "invalid_identity_adoption_permit";
				const control = await this.findControlGeneration(context, permit.controlGeneration);
				if (control === null || control.generation.action.actionId !== permit.actionId
					|| control.generation.action.kind !== "identity_adoption"
					|| !control.generation.action.memoIds.includes(draft.memoId)) return "invalid_identity_adoption_control";
			}
			if (draft.type === "identity.rebind" && draft.payload.reason === "manual_resolution") {
				const permit = commit.control;
				if (permit === null || permit === undefined || permit.actionKind !== "identity_repair"
					|| permit.vaultInstanceId !== context.bootstrap.vaultInstanceId
				) return "invalid_identity_repair_permit";
				const control = await this.findControlGeneration(context, permit.controlGeneration);
				if (control === null || control.generation.action.actionId !== permit.actionId
					|| control.generation.action.kind !== "identity_repair"
					|| !control.generation.action.memoIds.includes(draft.memoId)) return "invalid_identity_repair_control";
			}
		}
		return null;
	}

	private async isControlAncestor(
		context: CatalogV2VerifiedVaultContext,
		ancestor: ArtifactRef,
		descendant: ArtifactRef,
	): Promise<boolean> {
		let current: ArtifactRef | null = descendant;
		const visited = new Set<string>();
		while (current !== null && !visited.has(current.sha256)) {
			if (sameArtifactRef(current, ancestor)) return true;
			visited.add(current.sha256);
			current = (await this.findControlGeneration(context, current))?.generation.parent ?? null;
		}
		return false;
	}

	private async isGenerationAncestorRaw(descendant: ArtifactRef, ancestor: ArtifactRef): Promise<boolean> {
		const pending = [descendant];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const current = pending.pop();
			if (current === undefined || visited.has(current.sha256)) continue;
			if (sameArtifactRef(current, ancestor)) return true;
			visited.add(current.sha256);
			const generation = await this.readArtifactRef(current, assertStateGeneration);
			if (generation === null) return false;
			pending.push(...generation.value.parents);
		}
		return false;
	}

	async selectGeneration(context: CatalogV2VerifiedVaultContext): Promise<CatalogV2GenerationSelection> {
		const refs = await this.listGenerationRefs(context);
		if (refs.length === 0) return { kind: "empty" };
		const results = await Promise.all(refs.map((ref) => this.verifyGeneration(context, ref)));
		const verified = results.flatMap((result) => result.kind === "verified" ? [result.value] : []);
		const awaiting = results.filter((result): result is Extract<CatalogV2GenerationVerification, { kind: "awaiting_data" }> =>
			result.kind === "awaiting_data");
		const missingPaths = awaiting.flatMap((result) => result.missingPaths);
		const invalidReasons = results.flatMap((result) => result.kind === "invalid" ? [result.reason] : []);
		const parentDigests = new Set(verified.flatMap((item) => item.generation.parents.map((parent) => parent.sha256)));
		const tips = verified.filter((item) => !parentDigests.has(item.generationRef.sha256));
		if (missingPaths.length > 0) return {
			kind: "awaiting_data",
			missingPaths: [...new Set(missingPaths)].sort(),
			affectedMemoIds: awaiting.some((result) => result.affectedMemoIds === null)
				? null
				: [...new Set(awaiting.flatMap((result) => result.affectedMemoIds ?? []))].sort(),
			affectedWriterIds: awaiting.some((result) => result.affectedWriterIds === null)
				? null
				: [...new Set(awaiting.flatMap((result) => result.affectedWriterIds ?? []))].sort(),
			verifiedBase: invalidReasons.length === 0 && tips.length === 1 ? tips[0] ?? null : null,
		};
		if (invalidReasons.length > 0) return { kind: "invalid", reasons: [...new Set(invalidReasons)].sort() };
		if (tips.length === 1) return { kind: "verified", value: tips[0] as CatalogV2VerifiedStateGeneration };
		return { kind: "forked", generationRefs: tips.map((item) => item.generationRef).sort(compareRefs) };
	}

	async writeGeneration(context: CatalogV2VerifiedVaultContext, generation: CatalogV2StateGeneration): Promise<ArtifactRef> {
		assertStateGeneration(generation);
		if (generation.vaultInstanceId !== context.bootstrap.vaultInstanceId
			|| !sameArtifactRef(generation.contract, context.control.generation.contract)
			|| !sameArtifactRef(generation.controlGeneration, context.control.generationRef)) {
			throw new Error("State generation does not belong to the active Vault context.");
		}
		const bytes = canonicalJsonFileBytes(generation);
		const digest = await sha256Bytes(bytes);
		return this.writeImmutable(getCatalogStateGenerationPath(context.bootstrap.catalogDataRoot, digest), bytes);
	}

	async hasGenerationAncestor(
		context: CatalogV2VerifiedVaultContext,
		descendantRef: ArtifactRef,
		ancestorSha256: string,
	): Promise<boolean> {
		if (!SHA256_PATTERN.test(ancestorSha256)) return false;
		const pending: ArtifactRef[] = [descendantRef];
		const visited = new Set<string>();
		while (pending.length > 0) {
			const current = pending.pop();
			if (current === undefined || visited.has(current.sha256)) continue;
			if (current.sha256 === ancestorSha256) return true;
			visited.add(current.sha256);
			const read = await this.readArtifactRef(current, assertStateGeneration);
			if (read === null || read.value.vaultInstanceId !== context.bootstrap.vaultInstanceId
				|| !sameArtifactRef(read.value.contract, context.control.generation.contract)) return false;
			pending.push(...read.value.parents);
		}
		return false;
	}

	async writeImmutable(path: string, bytes: Uint8Array): Promise<ArtifactRef> {
		const normalizedPath = normalizePath(path);
		const digest = await sha256Bytes(bytes);
		const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
		if (existing instanceof TFile) {
			const existingBytes = new Uint8Array(await this.app.vault.readBinary(existing));
			const existingDigest = await sha256Bytes(existingBytes);
			if (existingDigest !== digest || existingBytes.byteLength !== bytes.byteLength) {
				throw new Error(`Immutable Catalog artifact collision: ${normalizedPath}`);
			}
			return { path: normalizedPath, sha256: digest, byteLength: bytes.byteLength };
		}
		if (existing !== null) throw new Error(`Catalog artifact path is not a file: ${normalizedPath}`);
		const parent = getParentFolderPath(normalizedPath);
		if (parent !== null) await ensureFolder(this.app, parent);
		try {
			await this.app.vault.create(normalizedPath, new TextDecoder().decode(bytes));
		} catch (error) {
			const raced = this.app.vault.getAbstractFileByPath(normalizedPath);
			if (!(raced instanceof TFile)) throw error;
			const racedBytes = new Uint8Array(await this.app.vault.readBinary(raced));
			if (await sha256Bytes(racedBytes) !== digest) throw error;
		}
		return { path: normalizedPath, sha256: digest, byteLength: bytes.byteLength };
	}

	private listBootstrapCandidatePaths(): string[] {
		const canonical = getCatalogBootstrapPath();
		const separator = canonical.lastIndexOf("/");
		const root = separator < 0 ? "" : canonical.slice(0, separator + 1);
		return this.app.vault.getFiles()
			.map((file) => normalizePath(file.path))
			.filter((path) => path === canonical || (path.startsWith(`${root}manifest`) && path.endsWith(".json") && !path.slice(root.length).includes("/")))
			.sort();
	}

	private async readHeadChain(
		vaultInstanceId: string,
		writerId: string,
		headRef: ArtifactRef,
		missingPaths: string[],
	): Promise<HeadChainResult | null> {
		const visited = new Set<string>();
		const heads: CatalogV2WriterHead[] = [];
		const operations: StateOperation[] = [];
		let currentRef: ArtifactRef | null = headRef;
		while (currentRef !== null) {
			if (visited.has(currentRef.sha256)) throw new Error(`Writer head cycle: ${writerId}`);
			visited.add(currentRef.sha256);
			const headRead: ArtifactReadResult<CatalogV2WriterHead> | null = await this.readArtifactRef<CatalogV2WriterHead>(
				currentRef,
				assertWriterHead,
			);
			if (headRead === null) {
				missingPaths.push(currentRef.path);
				return null;
			}
			const head: CatalogV2WriterHead = headRead.value;
			if (head.vaultInstanceId !== vaultInstanceId || head.writerId !== writerId) {
				throw new Error(`Writer head scope mismatch: ${writerId}`);
			}
			const segmentRead = await this.readArtifactRef(head.segment, assertImmutableStateSegment);
			if (segmentRead === null) {
				missingPaths.push(head.segment.path);
				return null;
			}
			const segment = segmentRead.value;
			if (segment.vaultInstanceId !== vaultInstanceId || segment.writerId !== writerId
				|| segment.firstSequence !== head.firstSequence || segment.lastSequence !== head.lastSequence
				|| segment.previousHeadSha256 !== (head.previousHead?.sha256 ?? null)) {
				throw new Error(`Writer segment scope mismatch: ${writerId}`);
			}
			heads.push(head);
			operations.push(...segment.operations);
			currentRef = head.previousHead;
		}
		const tipHead = heads[0];
		const orderedHeads = [...heads].reverse();
		for (let index = 0; index < orderedHeads.length; index += 1) {
			const head = orderedHeads[index];
			const previous = orderedHeads[index - 1];
			const expectedFirst = previous === undefined ? 1 : previous.lastSequence + 1;
			if (head?.firstSequence !== expectedFirst) throw new Error(`Writer sequence gap: ${writerId}`);
		}
		const orderedOperations = operations.sort((left, right) => left.sequence - right.sequence || left.opId.localeCompare(right.opId));
		for (let index = 0; index < orderedOperations.length; index += 1) {
			const operation = orderedOperations[index];
			if (operation?.writerId !== writerId || operation.sequence !== index + 1) {
				throw new Error(`Writer operation sequence mismatch: ${writerId}`);
			}
		}
		return { head: tipHead as CatalogV2WriterHead, operations: orderedOperations };
	}

	private async readArtifactRef<T>(
		ref: ArtifactRef,
		assertValue: (value: unknown) => asserts value is T,
	): Promise<ArtifactReadResult<T> | null> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(ref.path));
		if (!(file instanceof TFile)) return null;
		const result = await this.readCanonicalArtifact(file.path, assertValue);
		if (!sameArtifactRef(result.ref, ref)) throw new Error(`Catalog artifact digest mismatch: ${ref.path}`);
		return result;
	}

	private async readCanonicalArtifact<T>(
		path: string,
		assertValue: (value: unknown) => asserts value is T,
	): Promise<ArtifactReadResult<T>> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) throw new Error(`Catalog artifact is missing: ${path}`);
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (!text.endsWith("\n") || text.startsWith("\ufeff")) throw new Error(`Catalog artifact bytes are invalid: ${path}`);
		const value = JSON.parse(text.slice(0, -1)) as unknown;
		assertValue(value);
		const canonical = canonicalJsonFileBytes(value);
		if (!equalBytes(canonical, bytes)) throw new Error(`Catalog artifact is not canonical JSON: ${path}`);
		return {
			value,
			bytes,
			ref: { path: normalizePath(path), sha256: await sha256Bytes(bytes), byteLength: bytes.byteLength },
		};
	}
}

export function assertVaultBootstrap(value: unknown): asserts value is CatalogV2VaultBootstrap {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.vault-bootstrap" || value.schemaVersion !== 2
		|| value.protocolVersion !== 2
		|| (value.initializationMode !== "native" && value.initializationMode !== "legacy_upgrade")
		|| !VAULT_ID_PATTERN.test(readString(value.vaultInstanceId))
		|| !isCatalogPath(value.catalogDataRoot) || !isArtifactRef(value.contract) || !isArtifactRef(value.controlGenesis)
		|| !WRITER_ID_PATTERN.test(readString(value.initialWriterId))
		|| "projectionAuthorityWriterId" in value
		|| !isIsoDate(value.createdAt)) throw new Error("Invalid Catalog v2 Vault bootstrap.");
}

export function assertControlGeneration(value: unknown): asserts value is CatalogV2ControlGeneration {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.control-generation" || value.schemaVersion !== 2
		|| !VAULT_ID_PATTERN.test(readString(value.vaultInstanceId))
		|| !isPositiveInteger(value.controlSequence) || !isPositiveInteger(value.authorityEpoch)
		|| (value.parent !== null && !isArtifactRef(value.parent))
		|| !WRITER_ID_PATTERN.test(readString(value.authorityWriterId)) || !isArtifactRef(value.contract)
		|| (value.stateGeneration !== null && !isArtifactRef(value.stateGeneration))
		|| !Array.isArray(value.writerFrontier) || value.writerFrontier.length === 0
		|| !Array.isArray(value.consumedAuthorityRequestIds)
		|| !isSortedUniqueStrings(value.consumedAuthorityRequestIds)
		|| value.consumedAuthorityRequestIds.some((requestId) => !isStateEntryId(requestId))
		|| !isRecord(value.action) || !isStateEntryId(value.action.actionId)
		|| !["genesis", "identity_adoption", "identity_repair", "migration_finalize", "contract_change", "authority_transfer"].includes(readString(value.action.kind))
		|| (value.action.inputDigest !== null && !SHA256_PATTERN.test(readString(value.action.inputDigest)))
		|| !Array.isArray(value.action.memoIds) || !isSortedUniqueStrings(value.action.memoIds)
		|| "period" in value.action
		|| (value.action.authorityRequest !== null && !isArtifactRef(value.action.authorityRequest))
		|| (value.action.nextAuthorityWriterId !== null && !WRITER_ID_PATTERN.test(readString(value.action.nextAuthorityWriterId)))
		|| (value.action.nextContract !== null && !isArtifactRef(value.action.nextContract))
		|| !WRITER_ID_PATTERN.test(readString(value.createdByWriterId)) || !isIsoDate(value.createdAt)) {
		throw new Error("Invalid Catalog v2 control generation.");
	}
	let previousWriterId = "";
	for (const frontier of value.writerFrontier) {
		const writerId = isRecord(frontier) ? readString(frontier.writerId) : "";
		if (!isRecord(frontier) || !WRITER_ID_PATTERN.test(writerId) || writerId <= previousWriterId
			|| !isArtifactRef(frontier.registration) || (frontier.head !== null && !isArtifactRef(frontier.head))
			|| !Number.isInteger(frontier.lastSequence) || Number(frontier.lastSequence) < 0
			|| (frontier.head === null ? frontier.lastSequence !== 0 : frontier.lastSequence === 0)
			|| !Array.isArray(frontier.affectedMemoIds) || !isSortedUniqueStrings(frontier.affectedMemoIds)) {
			throw new Error("Invalid Catalog v2 control writer frontier.");
		}
		previousWriterId = writerId;
	}
	if (value.action.kind === "genesis" ? value.parent !== null || value.controlSequence !== 1 || value.authorityEpoch !== 1
		: value.parent === null || value.controlSequence === 1) throw new Error("Invalid Catalog v2 control action position.");
	if (value.action.kind === "genesis" ? value.action.inputDigest !== null : value.action.inputDigest === null) {
		throw new Error("Invalid Catalog v2 control input digest.");
	}
	if (value.action.kind === "authority_transfer"
		? value.action.authorityRequest === null || value.action.nextAuthorityWriterId === null
		: value.action.authorityRequest !== null || value.action.nextAuthorityWriterId !== null) {
		throw new Error("Invalid Catalog v2 authority transfer action.");
	}
	if (value.action.kind === "contract_change" ? value.action.nextContract === null : value.action.nextContract !== null) {
		throw new Error("Invalid Catalog v2 contract action.");
	}
}

export function assertAuthorityTransferRequest(value: unknown): asserts value is CatalogV2AuthorityTransferRequest {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.authority-transfer-request" || value.schemaVersion !== 2
		|| !VAULT_ID_PATTERN.test(readString(value.vaultInstanceId)) || !isStateEntryId(value.requestId)
		|| !WRITER_ID_PATTERN.test(readString(value.targetWriterId)) || !isArtifactRef(value.registration)
		|| !isIsoDate(value.requestedAt)) throw new Error("Invalid Catalog v2 authority transfer request.");
}

export function assertVaultContract(value: unknown): asserts value is CatalogV2VaultContract {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.vault-contract" || value.schemaVersion !== 2
		|| value.parserVersion !== CATALOG_PARSER_VERSION
		|| !isRecord(value.daily) || (value.daily.folder !== null && typeof value.daily.folder !== "string")
		|| typeof value.daily.dateFormat !== "string" || value.daily.dateFormat.length === 0
		|| !Array.isArray(value.daily.headings) || value.daily.headings.length === 0
		|| value.daily.headings.some((heading) => typeof heading !== "string" || heading.length === 0)
		|| value.daily.allowRootMemos !== true || !isRecord(value.monthly)
		|| typeof value.monthly.folder !== "string" || typeof value.monthly.fileFormat !== "string"
		|| typeof value.monthly.dateHeadingFormat !== "string"
		|| (value.monthly.dateOrder !== "asc" && value.monthly.dateOrder !== "desc")
		|| value.monthly.rendererVersion !== CATALOG_V2_MONTHLY_RENDERER_VERSION
		|| value.monthly.newline !== "lf") throw new Error("Invalid Catalog v2 Vault contract.");
}

export function assertWriterRegistration(value: unknown): asserts value is CatalogV2WriterRegistration {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.writer-registration" || value.schemaVersion !== 2
		|| !VAULT_ID_PATTERN.test(readString(value.vaultInstanceId))
		|| !WRITER_ID_PATTERN.test(readString(value.writerId)) || !isIsoDate(value.createdAt)) {
		throw new Error("Invalid Catalog v2 writer registration.");
	}
}

export function assertImmutableStateSegment(value: unknown): asserts value is CatalogV2ImmutableStateSegment {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.state-segment" || value.schemaVersion !== 2
		|| !VAULT_ID_PATTERN.test(readString(value.vaultInstanceId))
		|| !WRITER_ID_PATTERN.test(readString(value.writerId))
		|| !isPositiveInteger(value.firstSequence) || !isPositiveInteger(value.lastSequence)
		|| Number(value.lastSequence) < Number(value.firstSequence)
		|| (value.previousHeadSha256 !== null && !SHA256_PATTERN.test(readString(value.previousHeadSha256)))
		|| !Array.isArray(value.operations) || value.operations.length !== Number(value.lastSequence) - Number(value.firstSequence) + 1) {
		throw new Error("Invalid immutable Catalog v2 state segment.");
	}
	for (let index = 0; index < value.operations.length; index += 1) {
		const operation = value.operations[index];
		assertStateOperation(operation);
		if (!isRecord(operation) || operation.writerId !== value.writerId
			|| operation.sequence !== Number(value.firstSequence) + index) {
			throw new Error("Invalid operation in immutable Catalog v2 state segment.");
		}
	}
}

export function assertWriterHead(value: unknown): asserts value is CatalogV2WriterHead {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.writer-head" || value.schemaVersion !== 2
		|| !VAULT_ID_PATTERN.test(readString(value.vaultInstanceId))
		|| !WRITER_ID_PATTERN.test(readString(value.writerId))
		|| !isPositiveInteger(value.firstSequence) || !isPositiveInteger(value.lastSequence)
		|| Number(value.lastSequence) < Number(value.firstSequence)
		|| (value.previousHead !== null && !isArtifactRef(value.previousHead)) || !isArtifactRef(value.segment)
		|| !Array.isArray(value.affectedMemoIds) || value.affectedMemoIds.some((memoId) => typeof memoId !== "string" || memoId.length === 0)
		|| !isSortedUniqueStrings(value.affectedMemoIds) || !isIsoDate(value.committedAt)) {
		throw new Error("Invalid Catalog v2 writer head.");
	}
}

export function assertStateGeneration(value: unknown): asserts value is CatalogV2StateGeneration {
	if (!isRecord(value) || value.kind !== "knomo.catalog-v2.state-generation" || value.schemaVersion !== 2
		|| !VAULT_ID_PATTERN.test(readString(value.vaultInstanceId)) || !isArtifactRef(value.contract)
		|| !isArtifactRef(value.controlGeneration)
		|| !Array.isArray(value.parents) || value.parents.some((parent) => !isArtifactRef(parent))
		|| !Array.isArray(value.writers) || value.writers.length === 0
		|| (value.mutationCommits !== undefined && (!Array.isArray(value.mutationCommits)
			|| value.mutationCommits.some((commit) => !isArtifactRef(commit))
			|| !isSortedUniqueArtifactRefs(value.mutationCommits)))
		|| (value.mutationMemoIds !== undefined && (!Array.isArray(value.mutationMemoIds)
			|| !isSortedUniqueStrings(value.mutationMemoIds)))
		|| ((value.mutationCommits === undefined) !== (value.mutationMemoIds === undefined))
		|| (value.migrationCommit !== null && !isArtifactRef(value.migrationCommit))
		|| (value.migrationGenerationDigest !== null
			&& !SHA256_PATTERN.test(readString(value.migrationGenerationDigest)))
		|| !Array.isArray(value.migrationMemoIds) || !isSortedUniqueStrings(value.migrationMemoIds)
		|| (value.migrationCommit === null
			? value.migrationGenerationDigest !== null || value.migrationMemoIds.length !== 0
			: value.migrationGenerationDigest === null)
		|| !Array.isArray(value.retiredWriterIds) || value.retiredWriterIds.length !== 0
		|| "projectionAuthorityWriterId" in value
		|| !WRITER_ID_PATTERN.test(readString(value.createdByWriterId)) || !isIsoDate(value.createdAt)) {
		throw new Error("Invalid Catalog v2 state generation.");
	}
	const createdByWriterId = readString(value.createdByWriterId);
	const retiredWriterIds = value.retiredWriterIds.map(readString);
	let previousWriterId = "";
	const writerIds = new Set<string>();
	for (const writer of value.writers) {
		const writerId = isRecord(writer) ? readString(writer.writerId) : "";
		if (!isRecord(writer) || !WRITER_ID_PATTERN.test(writerId)
			|| writerId <= previousWriterId || !isArtifactRef(writer.registration)
			|| (writer.head !== null && !isArtifactRef(writer.head))
			|| !Array.isArray(writer.affectedMemoIds)
			|| writer.affectedMemoIds.some((memoId) => typeof memoId !== "string" || memoId.length === 0)
			|| !isSortedUniqueStrings(writer.affectedMemoIds)
			|| (writer.head === null ? writer.affectedMemoIds.length !== 0 : writer.affectedMemoIds.length === 0)) {
			throw new Error("Invalid writer entry in Catalog v2 state generation.");
		}
		writerIds.add(writerId);
		previousWriterId = writerId;
	}
	if (!writerIds.has(createdByWriterId)
		|| retiredWriterIds.some((writerId) => writerIds.has(writerId))) {
		throw new Error("Invalid Catalog v2 generation writer membership.");
	}
}

type ProtocolMigrationArtifact = MigrationPackage | QuarantineReceipt | DeletedMemoPayload;

function assertProtocolMigrationCommit(value: unknown): asserts value is MigrationCommit {
	assertMigrationCommit(value);
}

function assertProtocolMigrationArtifact(value: unknown): asserts value is ProtocolMigrationArtifact {
	if (!isRecord(value)) throw new Error("Invalid protocol-v2 migration artifact.");
	if (value.kind === "knomo.catalog-v2.deleted-payload") return assertDeletedMemoPayload(value);
	if (value.kind === "knomo.catalog-v2.quarantine-receipt") return assertQuarantineReceipt(value);
	assertMigrationPackage(value);
}

function assertMigrationArtifactBindings(
	commit: MigrationCommit,
	artifacts: ReadonlyArray<{
		required: MigrationCommit["requiredArtifacts"][number];
		value: ProtocolMigrationArtifact;
	}>,
): void {
	for (const source of commit.legacySources) {
		const expectedKind = source.disposition === "imported" ? "migration_package" : "quarantine_receipt";
		const artifact = artifacts.find((item) => item.required.artifactKind === expectedKind
			&& sameArtifactRef(item.required, source.receipt));
		if (artifact === undefined) throw new Error("Migration source artifact is missing from its commit.");
		if (source.disposition === "imported") {
			if (artifact.value.kind !== "knomo.catalog-v2.migration-package"
				|| artifact.value.source.artifactDigest !== source.artifactDigest
				|| artifact.value.source.artifactKind !== source.artifactKind) {
				throw new Error("Migration package does not match its legacy source.");
			}
		} else if (artifact.value.kind !== "knomo.catalog-v2.quarantine-receipt"
			|| artifact.value.artifactDigest !== source.artifactDigest
			|| artifact.value.artifactKind !== source.artifactKind) {
			throw new Error("Migration quarantine receipt does not match its legacy source.");
		}
	}
	const packages = artifacts.flatMap((artifact) =>
		artifact.value.kind === "knomo.catalog-v2.migration-package" ? [artifact.value] : []);
	const deletedArtifacts = artifacts.filter((artifact) => artifact.required.artifactKind === "deleted_payload");
	for (const packageValue of packages) {
		for (const deleted of packageValue.deletedRecords) {
			const artifact = deletedArtifacts.find((item) => sameArtifactRef(item.required, deleted.payload));
			if (artifact === undefined || artifact.value.kind !== "knomo.catalog-v2.deleted-payload"
				|| artifact.value.memoId !== deleted.memoId || artifact.value.deleteOpId !== deleted.deleteOpId
				|| (deleted.deletedAt !== null && artifact.value.deletedAt !== deleted.deletedAt)) {
				throw new Error("Deleted migration payload does not match its package record.");
			}
		}
	}
	for (const artifact of deletedArtifacts) {
		if (!packages.some((packageValue) => packageValue.deletedRecords.some((deleted) =>
			sameArtifactRef(deleted.payload, artifact.required)))) {
			throw new Error("Migration commit contains an unowned deleted payload.");
		}
	}
}

function migrationPackageMemoIds(value: MigrationPackage): string[] {
	return [...new Set([
		...value.identityClaims.map((item) => item.memoId),
		...value.deletedRecords.map((item) => item.memoId),
		...value.relations.map((item) => item.memoId),
		...value.reviews.map((item) => item.memoId),
		...value.pendingCreates.map((item) => item.memoId),
	])].sort();
}

async function migrationCommitGenerationDigest(value: MigrationCommit): Promise<string> {
	return sha256Text(canonicalJson({
		schemaVersion: value.schemaVersion,
		importerVersion: value.importerVersion,
		legacySources: value.legacySources.map((source) => ({
			artifactDigest: source.artifactDigest,
			artifactKind: source.artifactKind,
			disposition: source.disposition,
			receiptSha256: source.receipt.sha256,
		})),
		requiredArtifacts: value.requiredArtifacts,
		domainCounts: value.domainCounts,
	}));
}

function migrationCommitSupersedes(next: MigrationCommit, previous: MigrationCommit): boolean {
	if (next.generationDigest === previous.generationDigest) return true;
	const nextSources = new Map(next.legacySources.map((source) => [
		`${source.artifactKind}\u0000${source.artifactDigest}`,
		canonicalJson(source),
	]));
	if (previous.legacySources.some((source) =>
		nextSources.get(`${source.artifactKind}\u0000${source.artifactDigest}`) !== canonicalJson(source))) return false;
	const nextArtifacts = new Map(next.requiredArtifacts.map((artifact) => [
		`${artifact.artifactKind}\u0000${artifact.path}`,
		canonicalJson(artifact),
	]));
	return previous.requiredArtifacts.every((artifact) =>
		nextArtifacts.get(`${artifact.artifactKind}\u0000${artifact.path}`) === canonicalJson(artifact));
}

function isArtifactRef(value: unknown): value is ArtifactRef {
	return isRecord(value) && isCatalogPath(value.path) && SHA256_PATTERN.test(readString(value.sha256))
		&& Number.isInteger(value.byteLength) && Number(value.byteLength) > 0;
}

function isCatalogPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && normalizePath(value) === value
		&& !value.startsWith("/") && !/(^|\/)\.{1,2}(\/|$)/u.test(value) && !/[\\\u0000-\u001f]/u.test(value);
}

function normalizeCatalogDataRoot(value: string): string {
	const normalized = normalizePath(value.trim()).replace(/^\/+|\/+$/gu, "");
	if (!isCatalogPath(normalized)) throw new Error("Invalid Catalog data root.");
	return normalized;
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && ISO_DATE_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isPositiveInteger(value: unknown): boolean {
	return Number.isInteger(value) && Number(value) > 0;
}

function isStateEntryId(value: unknown): value is string {
	return typeof value === "string" && /^o_[a-f0-9]{32}$/u.test(value);
}

function isSortedUniqueStrings(value: unknown[]): value is string[] {
	return value.every((item) => typeof item === "string")
		&& value.every((item, index) => index === 0 || String(value[index - 1]) < item);
}

function sameArtifactRef(left: ArtifactRef, right: ArtifactRef): boolean {
	return left.path === right.path && left.sha256 === right.sha256 && left.byteLength === right.byteLength;
}

function sameControlPermit(
	control: CatalogV2VerifiedControlGeneration,
	permit: CatalogV2ControlPermit,
): boolean {
	const action = control.generation.action;
	return sameArtifactRef(control.generationRef, permit.controlGeneration)
		&& control.generation.vaultInstanceId === permit.vaultInstanceId
		&& control.generation.controlSequence === permit.controlSequence
		&& control.generation.authorityEpoch === permit.authorityEpoch
		&& control.generation.authorityWriterId === permit.authorityWriterId
		&& action.actionId === permit.actionId
		&& action.kind === permit.actionKind
		&& action.inputDigest === permit.inputDigest
		&& control.generation.createdAt === permit.authorizedAt
		&& (control.generation.stateGeneration?.sha256 ?? "0".repeat(64)) === permit.stateGenerationId;
}

function attachMutationControl(
	draft: StateOperationDraft | undefined,
	control: CatalogV2ControlPermit | null,
): StateOperationDraft | undefined {
	if (draft === undefined || control === null) return draft;
	if (draft.type === "identity.claim" && draft.payload.origin === "manual_adoption") {
		return { ...draft, payload: { ...draft.payload, control } };
	}
	if (draft.type === "identity.rebind" && draft.payload.reason === "manual_resolution") {
		return { ...draft, payload: { ...draft.payload, control } };
	}
	return draft;
}

function isControlBoundIdentityOperation(operation: StateOperation): boolean {
	return operation.type === "identity.claim" && operation.payload.origin === "manual_adoption"
		|| operation.type === "identity.rebind" && operation.payload.reason === "manual_resolution";
}

function controlPermitFromGeneration(
	control: CatalogV2VerifiedControlGeneration,
): CatalogV2ControlPermit {
	const action = control.generation.action;
	if (action.kind === "genesis" || action.inputDigest === null) {
		throw new Error("Control genesis cannot be used as an action permit.");
	}
	return {
		kind: "catalog-v2-control-permit",
		vaultInstanceId: control.generation.vaultInstanceId,
		controlGeneration: control.generationRef,
		controlSequence: control.generation.controlSequence,
		authorityEpoch: control.generation.authorityEpoch,
		authorityWriterId: control.generation.authorityWriterId,
		actionId: action.actionId,
		actionKind: action.kind,
		inputDigest: action.inputDigest,
		authorizedAt: control.generation.createdAt,
		stateGenerationId: control.generation.stateGeneration?.sha256 ?? "0".repeat(64),
		contractDigest: control.generation.contract.sha256,
	};
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function compareOperations(left: StateOperation, right: StateOperation): number {
	return left.writerId.localeCompare(right.writerId) || left.sequence - right.sequence || left.opId.localeCompare(right.opId);
}

function compareRefs(left: ArtifactRef, right: ArtifactRef): number {
	return left.sha256.localeCompare(right.sha256) || left.path.localeCompare(right.path);
}

function artifactRefKey(ref: ArtifactRef): string {
	return `${ref.sha256}\u0000${ref.path}\u0000${ref.byteLength}`;
}

function isSortedUniqueArtifactRefs(values: readonly unknown[]): boolean {
	let previous = "";
	for (const value of values) {
		if (!isArtifactRef(value)) return false;
		const key = artifactRefKey(value);
		if (key <= previous) return false;
		previous = key;
	}
	return true;
}

async function deriveMutationWriterId(mutationId: string): Promise<string> {
	return `w_${(await sha256Text(`catalog-v2-mutation-writer\u0000${mutationId}`)).slice(0, 32)}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
