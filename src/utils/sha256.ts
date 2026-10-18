export async function sha256Text(value: string): Promise<string> {
	return sha256Bytes(new TextEncoder().encode(value));
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
	const cryptoApi = typeof crypto === "undefined" ? undefined : crypto;
	if (cryptoApi?.subtle === undefined) throw new Error("Web Crypto SHA-256 is unavailable.");
	const input = new Uint8Array(bytes.byteLength);
	input.set(bytes);
	const digest = await cryptoApi.subtle.digest("SHA-256", input.buffer);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
