import { renderKnomoLoadMoreButton } from "./KnomoFeed";

export interface CardFlowSentinelRenderOptions {
	root: HTMLElement;
	remainingCount: number;
	generation: number;
	Observer?: typeof IntersectionObserver;
	isCurrentGeneration: (generation: number) => boolean;
	onIntersect: (generation: number) => void;
}

export class KnomoCardFlowSentinel {
	private observer: IntersectionObserver | null = null;
	private sentinelEl: HTMLElement | null = null;

	get isObserving(): boolean {
		return this.observer !== null;
	}

	render(options: CardFlowSentinelRenderOptions): void {
		this.remove();
		const sentinel = renderKnomoLoadMoreButton(options.root, {
			remainingCount: options.remainingCount,
			action: "load-more",
			sentinel: true,
		});
		this.sentinelEl = sentinel;
		this.observe(sentinel, options);
	}

	remove(): void {
		this.disconnect();
		this.sentinelEl?.detach();
		this.sentinelEl = null;
	}

	disconnect(): void {
		this.observer?.disconnect();
		this.observer = null;
	}

	private observe(sentinel: HTMLElement, options: CardFlowSentinelRenderOptions): void {
		const Observer = options.Observer;
		if (Observer === undefined) {
			return;
		}
		const observer = new Observer((entries: IntersectionObserverEntry[]) => {
			if (!options.isCurrentGeneration(options.generation) || !entries.some((entry) => entry.isIntersecting)) {
				return;
			}
			options.onIntersect(options.generation);
		}, {
			root: options.root,
			rootMargin: "240px 0px",
			threshold: 0,
		});
		this.observer = observer;
		observer.observe(sentinel);
	}
}
