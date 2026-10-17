// 只记录操作阶段和错误类别，错误对象及 message 可能含有正文或附件数据。
export function logContinuationFailure(operation: string, stage: string, error: unknown, generation?: number): void {
	console.warn("[Knomo] Background continuation failed", {
		operation, stage, generation,
		errorType: error instanceof Error ? error.constructor.name : typeof error,
	});
}
