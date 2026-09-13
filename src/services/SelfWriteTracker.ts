import type { SelfWriteMarker } from "../types";

// 职责：记录 Monthly 投影自身写入，避免文件监听形成重建循环。
export class SelfWriteTracker {
	private readonly markersByPath = new Map<string, SelfWriteMarker[]>();

	constructor(private readonly ttlMs = 5000) {}

	mark(path: string, marker: SelfWriteMarker): void {
		this.cleanup();
		const markers = this.markersByPath.get(path) ?? [];
		const writtenAt = marker.writtenAt;
		markers.push({
			...marker,
			path,
			writtenAt,
			expiresAt: marker.expiresAt > writtenAt ? marker.expiresAt : writtenAt + this.ttlMs,
		});
		this.markersByPath.set(path, markers);
	}

	consumeByExpectedHash(path: string, expectedHash: string): SelfWriteMarker | null {
		this.cleanup();
		const markers = this.markersByPath.get(path);
		if (!markers || markers.length === 0) {
			return null;
		}

		const matchIndex = markers.findIndex((marker) => marker.expectedHash === expectedHash);
		if (matchIndex === -1) {
			return null;
		}
		const [marker] = markers.splice(matchIndex, 1);
		if (markers.length === 0) {
			this.markersByPath.delete(path);
		}
		return marker ?? null;
	}

	discard(path: string, opId: string): void {
		this.cleanup();
		const markers = this.markersByPath.get(path);
		if (!markers) {
			return;
		}
		const activeMarkers = markers.filter((marker) => marker.opId !== opId);
		if (activeMarkers.length === 0) {
			this.markersByPath.delete(path);
		} else {
			this.markersByPath.set(path, activeMarkers);
		}
	}

	cleanup(): void {
		const now = Date.now();
		for (const [path, markers] of this.markersByPath.entries()) {
			const activeMarkers = markers.filter((marker) => marker.expiresAt > now);
			if (activeMarkers.length === 0) {
				this.markersByPath.delete(path);
			} else {
				this.markersByPath.set(path, activeMarkers);
			}
		}
	}
}
