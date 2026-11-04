import type { ShareCardTemplateId } from "./ShareCardTemplates";

// 串行生成，快速切换只发布最新模板；关闭后不再发布结果。
export class ShareCardSession<T> {
	private version = 0;
	private closed = false;
	private running = false;
	private requested: ShareCardTemplateId = "paper";
	private state: "idle" | "pending" | "ready" = "idle";
	constructor(private readonly render: (template: ShareCardTemplateId) => Promise<T>,
		private readonly publish: (result: T, template: ShareCardTemplateId) => void,
		private readonly fail: (error: unknown) => void) {}
	select(template: ShareCardTemplateId): boolean {
		if (this.closed || (template === this.requested && this.state !== "idle")) return false;
		this.requested = template; this.version++; this.state = "pending";
		if (!this.running) void this.run();
		return true;
	}
	close(): void { this.closed = true; this.version++; }
	private async run(): Promise<void> {
		this.running = true;
		try {
			while (!this.closed) {
				const version = this.version; const template = this.requested;
				try {
					const result = await this.render(template);
					if (this.closed) return;
					if (version !== this.version) continue;
					this.publish(result, template);
					if (version === this.version) this.state = "ready";
				} catch (error) {
					if (this.closed) return;
					if (version !== this.version) continue;
					this.state = "idle";
					this.fail(error);
				}
				if (version === this.version) break;
			}
		} finally { this.running = false; }
	}
}
