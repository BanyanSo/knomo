// 仅用于图片资源比较，不改变 Vault 实际路径或大小写。
export function normalizeImagePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

export function getImagePathBasename(path: string): string {
	const separatorIndex = path.lastIndexOf("/");
	return separatorIndex === -1 ? path : path.slice(separatorIndex + 1);
}
