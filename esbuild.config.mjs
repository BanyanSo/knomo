import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";
import { prepareReleaseAssets } from "./scripts/prepare-release-assets.mjs";

const isProduction = process.argv[2] === "production";
const nodeExternals = builtinModules.flatMap((moduleName) => [
	moduleName,
	`node:${moduleName}`,
]);

const context = await esbuild.context({
	banner: {
		js: "",
	},
	entryPoints: ["src/main.ts"],
	bundle: true,
	loader: { ".png": "dataurl", ".jpg": "dataurl" },
	external: [
		"obsidian",
		"electron",
		"@codemirror/commands",
		"@codemirror/state",
		"@codemirror/view",
		...nodeExternals,
	],
	format: "cjs",
	target: "es2018",
	charset: isProduction ? "utf8" : "ascii",
	logLevel: "info",
	sourcemap: isProduction ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: isProduction,
	define: {
		__KNOMO_DIAGNOSTIC_BUILD__: JSON.stringify(!isProduction),
	},
});

if (isProduction) {
	try {
		await context.rebuild();
	} finally {
		await context.dispose();
	}
	await prepareReleaseAssets();
} else {
	await context.watch();
}
