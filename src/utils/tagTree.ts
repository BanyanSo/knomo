import { normalizeTagKey } from "./tags";

export interface TagSummary {
	key: string;
	name: string;
	count: number;
}

export interface TagTreeNode {
	key: string;
	name: string;
	label: string;
	count: number;
	children: TagTreeNode[];
}

interface MutableTagTreeNode {
	key: string;
	name: string;
	label: string;
	count: number;
	children: Map<string, MutableTagTreeNode>;
}

export function buildTagTree(tags: TagSummary[]): TagTreeNode[] {
	const roots = new Map<string, MutableTagTreeNode>();
	for (const tag of tags) {
		const displayParts = tag.name.split("/").filter((part) => part.length > 0);
		const keyParts = tag.key.split("/").filter((part) => part.length > 0);
		if (displayParts.length === 0 || keyParts.length === 0) {
			continue;
		}
		let children = roots;
		let fullKey = "";
		let fullName = "";
		for (let index = 0; index < keyParts.length; index += 1) {
			const keyPart = keyParts[index];
			const displayPart = displayParts[index] ?? keyPart;
			const normalizedPart = normalizeTagKey(keyPart);
			if (normalizedPart.length === 0) {
				continue;
			}
			fullKey = fullKey.length === 0 ? normalizedPart : `${fullKey}/${normalizedPart}`;
			fullName = fullName.length === 0 ? displayPart : `${fullName}/${displayPart}`;
			let node = children.get(fullKey);
			if (node === undefined) {
				node = {
					key: fullKey,
					name: fullName,
					label: displayPart,
					count: 0,
					children: new Map<string, MutableTagTreeNode>(),
				};
				children.set(fullKey, node);
			}
			if (index === keyParts.length - 1) {
				node.count += tag.count;
			}
			children = node.children;
		}
	}
	return finalizeTagTree(roots);
}

function finalizeTagTree(nodes: Map<string, MutableTagTreeNode>): TagTreeNode[] {
	return Array.from(nodes.values())
		.map((node) => {
			const children = finalizeTagTree(node.children);
			return {
				key: node.key,
				name: node.name,
				label: node.label,
				count: node.count + children.reduce((sum, child) => sum + child.count, 0),
				children,
			};
		})
		.sort((left, right) => {
			return right.count - left.count || left.label.localeCompare(right.label, "zh");
		});
}
