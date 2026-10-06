import fs from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";

export async function prepareReleaseAssets(root = process.cwd()) {
	const destination = path.join(root, "dist");
	const source = await fs.readFile(path.join(root, "styles.css"), "utf8");
	const { code } = await transform(source, { loader: "css", minify: true, legalComments: "none" });
	await fs.mkdir(destination, { recursive: true });
	await Promise.all([
		...["main.js", "manifest.json"].map(file => fs.copyFile(path.join(root, file), path.join(destination, file))),
		fs.writeFile(path.join(destination, "styles.css"), code),
	]);
}
