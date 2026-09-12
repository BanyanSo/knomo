interface NativeImagePickerControllerOptions<T> {
	captureContext?(): T | undefined;
	isContextCurrent?(context: T | undefined): boolean;
	createInput(): HTMLInputElement;
	beginFocusGuard(): boolean;
	finishFocusGuard(shouldRestoreFocus: boolean): void;
	insertImageFiles(files: FileList, context?: T): Promise<void>;
}

export class NativeImagePickerController<T = undefined> {
	private cleanupActivePicker: (() => void) | null = null;

	constructor(private readonly options: NativeImagePickerControllerOptions<T>) {}

	open(): void {
		this.dispose();
		const shouldRestoreMobileFocus = this.options.beginFocusGuard();
		const context = this.options.captureContext?.();
		const input = this.options.createInput();
		let handledChange = false;
		let cleanedUp = false;
		let releasedFocusGuardWithoutRestore = false;

		const cleanup = () => {
			if (cleanedUp) {
				return;
			}
			cleanedUp = true;
			input.removeEventListener("change", handleChange);
			input.removeEventListener("cancel", handleCancel);
			input.detach();
			if (this.cleanupActivePicker === cleanup) {
				this.cleanupActivePicker = null;
			}
		};

		const finishWithoutFiles = () => {
			if (handledChange) {
				return;
			}
			handledChange = true;
			cleanup();
			finishFocusGuard(shouldRestoreMobileFocus && (this.options.isContextCurrent?.(context) ?? true));
		};

		const finishFocusGuard = (shouldRestoreFocus: boolean) => {
			if (!shouldRestoreFocus) {
				if (releasedFocusGuardWithoutRestore) {
					return;
				}
				releasedFocusGuardWithoutRestore = true;
			}
			this.options.finishFocusGuard(shouldRestoreFocus);
		};

		const handleChange = () => {
			if (handledChange) {
				return;
			}
			const files = input.files;
			if (files === null || files.length === 0) {
				finishWithoutFiles();
				return;
			}
			handledChange = true;
			void this.options.insertImageFiles(files, context)
				.then(
					() => { if (!cleanedUp) finishFocusGuard(shouldRestoreMobileFocus && (this.options.isContextCurrent?.(context) ?? true)); },
					() => { if (!cleanedUp) finishFocusGuard(shouldRestoreMobileFocus && (this.options.isContextCurrent?.(context) ?? true)); },
				)
				.finally(cleanup);
		};

		const handleCancel = () => {
			finishWithoutFiles();
		};

		this.cleanupActivePicker = cleanup;
		input.addEventListener("change", handleChange);
		input.addEventListener("cancel", handleCancel);
		input.click();
	}

	dispose(): void {
		this.cleanupActivePicker?.();
	}
}
