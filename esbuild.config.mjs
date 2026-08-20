import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";

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
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...nodeExternals,
	],
	format: "cjs",
	target: "es2018",
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
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}
