export function hashText(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function normalizeMemoContentForHash(content: string): string {
	// 调用方传入已按源范围解码的逻辑正文；再次猜测 ID 会忽略可见子块或字面 token。
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function hashMemoContent(content: string): string {
	return hashText(normalizeMemoContentForHash(content));
}
