export type SelfWriteReason = "monthly_projection";

export interface SelfWriteMarker {
	opId: string;
	path: string;
	reason: SelfWriteReason;
	writtenAt: number;
	expiresAt: number;
	expectedHash: string | null;
}
