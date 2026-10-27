// 在解码常见压缩图片前读取尺寸，避免小文件展开为超大位图后才拒绝。
export function shareCardImageDimensions(bytes: Uint8Array): readonly [number, number] | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (offset: number, text: string) => offset + text.length <= bytes.length && Array.from(text).every((char, i) => bytes[offset + i] === char.charCodeAt(0));
	if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, "PNG\r\n\u001a\n")) return [view.getUint32(16), view.getUint32(20)];
	if (bytes.length >= 10 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) return [view.getUint16(6, true), view.getUint16(8, true)];
	if (bytes.length >= 26 && ascii(0, "BM")) return [Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true))];
	if (bytes.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
		if (ascii(12, "VP8X")) return [1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)];
		if (ascii(12, "VP8 ")) return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
		if (ascii(12, "VP8L") && bytes[20] === 0x2f) return [1 + bytes[21] + ((bytes[22] & 0x3f) << 8), 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10)];
	}
	if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 4 <= bytes.length) {
			if (bytes[offset] !== 0xff) break;
			const marker = bytes[offset + 1];
			if (marker === 0xff) { offset++; continue; }
			if (marker === 0xda || marker === 0xd9) break;
			const length = view.getUint16(offset + 2);
			if (length < 2) break;
			if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && offset + 9 <= bytes.length) return [view.getUint16(offset + 7), view.getUint16(offset + 5)];
			offset += length + 2;
		}
	}
	return null;
}
