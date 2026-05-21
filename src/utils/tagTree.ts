export interface TagSummary {
	name: string;
	count: number;
}

export interface TagTreeNode {
	name: string;
	label: string;
	count: number;
	children: TagTreeNode[];
}

interface MutableTagTreeNode {
	name: string;
	label: string;
	count: number;
	children: Map<string, MutableTagTreeNode>;
}

export function buildTagTree(tags: TagSummary[]): TagTreeNode[] {
	const roots = new Map<string, MutableTagTreeNode>();
	for (const tag of tags) {
		const parts = tag.name.split("/").filter((part) => part.length > 0);
		let children = roots;
		let fullName = "";
		for (let index = 0; index < parts.length; index += 1) {
			const part = parts[index];
			fullName = fullName.length === 0 ? part : `${fullName}/${part}`;
			let node = children.get(part);
			if (node === undefined) {
				node = {
					name: fullName,
					label: part,
					count: 0,
					children: new Map<string, MutableTagTreeNode>(),
				};
				children.set(part, node);
			}
			if (index === parts.length - 1) {
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
