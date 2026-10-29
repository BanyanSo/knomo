// 宿主 helper 创建的离屏节点须归入目标文档，隔离 iframe 不依赖 Obsidian 扩展原型。
export function createShareCardElement<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K): HTMLElementTagNameMap[K];
export function createShareCardElement(doc: Document, tag: string): HTMLElement;
export function createShareCardElement(doc: Document, tag: string): HTMLElement {
	return doc.adoptNode(createEl(tag as keyof HTMLElementTagNameMap));
}
