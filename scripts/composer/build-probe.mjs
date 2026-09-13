import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

const outdir = ".tmp/knomo-composer-probe";
await mkdir(outdir, { recursive: true });
const result = await build({
	entryPoints: ["scripts/composer/probePlugin.ts"],
	outfile: `${outdir}/main.js`,
	bundle: true,
	format: "cjs",
	target: "es2018",
	external: ["obsidian", "@codemirror/state", "@codemirror/view"],
	metafile: true,
});
const externalImports = [...new Set(Object.values(result.metafile.outputs)
	.flatMap(output => output.imports.filter(item => item.external).map(item => item.path)))].sort();
if (externalImports.join(",") !== "@codemirror/state,@codemirror/view,obsidian") {
	throw new Error(`Unexpected host dependencies: ${externalImports.join(", ")}`);
}
await writeFile(`${outdir}/manifest.json`, JSON.stringify({
	id: "knomo-composer-probe", name: "Knomo Composer Probe", version: "0.0.1",
	minAppVersion: "1.11.0", description: "Isolated Composer kernel validation; never writes notes.",
	author: "BanyanSo", isDesktopOnly: false,
}, null, 2));
await writeFile(`${outdir}/dependencies.json`, JSON.stringify({ externalImports,
	bundledInputs: Object.keys(result.metafile.inputs).filter(path => path.includes("node_modules/")) }, null, 2));
console.log(`Composer probe built: ${outdir}; host dependencies: ${externalImports.join(", ")}`);
