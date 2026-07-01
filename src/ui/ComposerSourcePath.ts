interface ComposerSourceFile {
	path: string;
	extension: string;
}

interface ComposerSourcePathOptions {
	todayDailyNotePath: string | null;
	activeFile: ComposerSourceFile | null;
}

export function getPreferredComposerSourcePath(options: ComposerSourcePathOptions): string | null {
	if (options.todayDailyNotePath !== null) {
		return options.todayDailyNotePath;
	}
	if (options.activeFile !== null && options.activeFile.extension === "md") {
		return options.activeFile.path;
	}
	return null;
}
