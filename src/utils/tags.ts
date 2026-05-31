export function normalizeTagKey(tag: string): string {
	return tag.trim().replace(/^#/, "").toLowerCase();
}

export interface TagDisplaySource {
	tag: string;
	modifiedTime: number;
	order: number;
}

interface TagDisplayCandidate {
	displayName: string;
	count: number;
	modifiedTime: number;
	order: number;
}

export function buildTagDisplayMap(sources: TagDisplaySource[]): Map<string, string> {
	const candidates = new Map<string, Map<string, TagDisplayCandidate>>();
	for (const source of sources) {
		const key = normalizeTagKey(source.tag);
		const displayName = normalizeTagDisplay(source.tag);
		if (key.length === 0 || displayName.length === 0) {
			continue;
		}
		addTagDisplayPathCandidates(candidates, key, displayName, source.modifiedTime, source.order);
	}
	const displayTags = new Map<string, string>();
	for (const [key, candidatesForKey] of candidates) {
		const candidate = chooseTagDisplayCandidate(candidatesForKey);
		if (candidate !== null) {
			displayTags.set(key, candidate.displayName);
		}
	}
	return displayTags;
}

export function normalizeTagDisplay(tag: string): string {
	return tag.trim().replace(/^#/, "");
}

function addTagDisplayPathCandidates(
	candidates: Map<string, Map<string, TagDisplayCandidate>>,
	key: string,
	displayName: string,
	modifiedTime: number,
	order: number,
): void {
	const keyParts = key.split("/").filter((part) => part.length > 0);
	const displayParts = displayName.split("/").filter((part) => part.length > 0);
	let currentKey = "";
	let currentName = "";
	for (let index = 0; index < keyParts.length; index += 1) {
		const keyPart = keyParts[index];
		const displayPart = displayParts[index] ?? keyPart;
		currentKey = currentKey.length === 0 ? keyPart : `${currentKey}/${keyPart}`;
		currentName = currentName.length === 0 ? displayPart : `${currentName}/${displayPart}`;
		addTagDisplayCandidate(candidates, currentKey, currentName, modifiedTime, order);
	}
}

function addTagDisplayCandidate(
	candidates: Map<string, Map<string, TagDisplayCandidate>>,
	key: string,
	displayName: string,
	modifiedTime: number,
	order: number,
): void {
	let candidatesForKey = candidates.get(key);
	if (candidatesForKey === undefined) {
		candidatesForKey = new Map<string, TagDisplayCandidate>();
		candidates.set(key, candidatesForKey);
	}
	const candidateKey = displayName;
	const candidate = candidatesForKey.get(candidateKey);
	if (candidate === undefined) {
		candidatesForKey.set(candidateKey, {
			displayName,
			count: 1,
			modifiedTime,
			order,
		});
		return;
	}
	candidate.count += 1;
	candidate.modifiedTime = Math.max(candidate.modifiedTime, modifiedTime);
	candidate.order = Math.min(candidate.order, order);
}

function chooseTagDisplayCandidate(candidates: Map<string, TagDisplayCandidate>): TagDisplayCandidate | null {
	let selected: TagDisplayCandidate | null = null;
	for (const candidate of candidates.values()) {
		if (selected === null || compareTagDisplayCandidate(candidate, selected) < 0) {
			selected = candidate;
		}
	}
	return selected;
}

function compareTagDisplayCandidate(left: TagDisplayCandidate, right: TagDisplayCandidate): number {
	if (left.count !== right.count) {
		return right.count - left.count;
	}
	if (left.modifiedTime !== right.modifiedTime) {
		return right.modifiedTime - left.modifiedTime;
	}
	return left.order - right.order;
}
