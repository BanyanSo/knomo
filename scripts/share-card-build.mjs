import { fileURLToPath } from "node:url";

export const shareCardBuildPlugin = {
	name: "share-card-static-markdown",
	setup(build) {
		build.onResolve({ filter: /^linkify-it$/ }, ({ importer }) => {
			if (/[/\\]node_modules[/\\]markdown-it[/\\]/u.test(importer)) {
				return { path: fileURLToPath(new URL("../src/ui/share/ShareCardLinkifyDisabled.ts", import.meta.url)) };
			}
		});
	},
};
