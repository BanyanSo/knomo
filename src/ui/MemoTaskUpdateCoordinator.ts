import type { MemoRecord } from "../types/memo";

interface MemoTaskUpdateCoordinatorOptions {
	updateMemo: (memo: MemoRecord, content: string) => Promise<MemoRecord>;
	onSaved: (memo: MemoRecord) => void | Promise<void>;
	onIssue: (memo: MemoRecord) => void | Promise<void>;
	onFailed: (memo: MemoRecord, error: unknown) => void | Promise<void>;
}

interface MemoTaskUpdateState {
	lastConfirmedMemo: MemoRecord;
	latestContent: string;
	inFlight: boolean;
	sequence: number;
	operationToken: number;
}

export class MemoTaskUpdateCoordinator {
	private readonly states = new Map<string, MemoTaskUpdateState>();

	constructor(private readonly options: MemoTaskUpdateCoordinatorOptions) {}

	getLatestContent(memo: MemoRecord): string {
		return this.states.get(memo.id)?.latestContent ?? memo.contentSnapshot;
	}

	enqueue(memo: MemoRecord, content: string): void {
		const state = this.states.get(memo.id) ?? {
			lastConfirmedMemo: memo,
			latestContent: memo.contentSnapshot,
			inFlight: false,
			sequence: 0,
			operationToken: 0,
		};
		state.latestContent = content;
		state.sequence += 1;
		this.states.set(memo.id, state);
		void this.flush(memo.id);
	}

	private async flush(memoId: string): Promise<void> {
		const state = this.states.get(memoId);
		if (state === undefined || state.inFlight) {
			return;
		}

		const contentToSave = state.latestContent;
		state.inFlight = true;
		state.operationToken += 1;
		const operationToken = state.operationToken;
		try {
			const savedMemo = await this.options.updateMemo(state.lastConfirmedMemo, contentToSave);
			const currentState = this.states.get(memoId);
			if (currentState !== state || currentState.operationToken !== operationToken) {
				return;
			}
			if (savedMemo.contentSnapshot !== contentToSave || savedMemo.syncStatus !== "synced" || savedMemo.issue !== null) {
				this.states.delete(memoId);
				await this.options.onIssue(savedMemo);
				return;
			}
			if (state.latestContent === savedMemo.contentSnapshot) {
				this.states.delete(memoId);
				await this.options.onSaved(savedMemo);
				return;
			}
			state.lastConfirmedMemo = savedMemo;
			state.inFlight = false;
			void this.flush(memoId);
		} catch (error) {
			const currentState = this.states.get(memoId);
			if (currentState !== state || currentState.operationToken !== operationToken) {
				return;
			}
			this.states.delete(memoId);
			await this.options.onFailed(state.lastConfirmedMemo, error);
		}
	}
}
