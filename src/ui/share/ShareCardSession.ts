import type { ShareCardTemplateId } from "./ShareCardTemplates";

// 串行生成，快速切换只发布最新模板；关闭后不再发布结果。
export class ShareCardSession<T> {
	private version = 0;
	private closed = false;
	private running = false;
	private requested: ShareCardTemplateId = "paper";
	constructor(private readonly render: (template: ShareCardTemplateId) => Promise<T>,
		private readonly publish: (result: T, template: ShareCardTemplateId) => void,
		private readonly fail: (error: unknown) => void) {}
	select(template: ShareCardTemplateId): void {
		if (this.closed) return;
		this.requested = template; this.version++;
		if (!this.running) void this.run();
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
				} catch (error) {
					if (this.closed) return;
					if (version !== this.version) continue;
					this.fail(error);
				}
				break;
			}
		} finally { this.running = false; }
	}
}
