import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

interface Digest { bytes: number; sha256: string }
interface Inputs { fingerprint: string; environment: { installedLock: string | null } }
interface AssetResult { name: string; result: string; http?: number; sha256?: string }
interface GithubResult {
	tag: string;
	prs: { state: string; value: { headRefOid: string; mergeCommit: { oid: string } }[] };
	runs: { value: { headSha: string }[] };
	release: { state: string };
}
interface ReleaseCheck {
	verificationInputs(root: string): Inputs;
	artifactDigests(root: string): Record<string, Digest | null>;
	candidateAssetDigests(root: string, sha: string, artifacts: Record<string, Digest | null>): Record<string, Digest | null>;
	canReuseVerification(record: unknown, inputs: Inputs, artifacts: Record<string, Digest | null>): boolean;
	checkPublicAssets(release: unknown, expected: Record<string, Digest | null>, fetcher: (url: string, init: RequestInit) => Promise<Response>): Promise<AssetResult[]>;
	githubStatus(root: string, version: string, sha: string, execute: (root: string, command: string, args: string[]) => { status: number; stdout: string; stderr: string }): GithubResult;
}

const script = path.resolve("scripts/release-check.mjs");
const version = "2.3.4";
const importModule = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<ReleaseCheck>;
const load = () => importModule(pathToFileURL(script).href);
const digest = (bytes: Buffer): Digest => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });

function git(root: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

function buildFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "knomo-release-check-"));
	const files: Record<string, string> = {
		".gitignore": ".tmp/\nnode_modules/\ndist/\nmain.js\n.agents/\ndocs/\n",
		"manifest.json": JSON.stringify({ id: "knomo", version, minAppVersion: "1.11.0" }),
		"package.json": JSON.stringify({ version, scripts: { verify: "node scripts/verify.mjs" } }),
		"package-lock.json": JSON.stringify({ version, packages: { "": { version } } }),
		"versions.json": JSON.stringify({ [version]: "1.11.0" }),
		[`release-notes/${version}.md`]: "Release notes\n",
		"node_modules/.package-lock.json": '{"name":"fixture"}',
		"scripts/check-release-version.mjs": fs.readFileSync("scripts/check-release-version.mjs", "utf8"),
		"styles.css": ".knomo { color: red; }\n",
		"scripts/verify.mjs": `import fs from 'node:fs';
fs.mkdirSync('dist', { recursive: true });
fs.mkdirSync('.tmp', { recursive: true });
fs.appendFileSync('.tmp/count', 'run\\n');
fs.writeFileSync('dist/main.js', Buffer.from([0, 255, 1]));
fs.copyFileSync('manifest.json', 'dist/manifest.json');
fs.writeFileSync('dist/styles.css', '.knomo{color:red}\\n');
console.log('PRIVATE_SUCCESS_LOG');
console.log('# tests 1\\n# pass 1\\n# fail 0');
`,
	};
	for (const [name, contents] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
		fs.writeFileSync(path.join(root, name), contents);
	}
	git(root, "init", "--quiet");
	git(root, "config", "core.autocrlf", "false");
	git(root, "config", "user.email", "release-check@example.invalid");
	git(root, "config", "user.name", "Release check fixture");
	git(root, "add", "--all");
	git(root, "commit", "--quiet", "-m", "fixture");
	return root;
}

let template: string | undefined;
after(() => { if (template) removeFixture(template); });

function fixture(): string {
	// 基础仓库只读复用，每个场景复制完整文件与 .git，避免共享可变状态。
	template ??= buildFixture();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "knomo-release-check-"));
	fs.cpSync(template, root, { recursive: true });
	return root;
}

function removeFixture(root: string): void {
	assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
	assert.ok(path.basename(root).startsWith("knomo-release-check-"));
	fs.rmSync(root, { recursive: true, force: true });
}

function cli(root: string, action = "status", ...args: string[]) {
	return spawnSync(process.execPath, [script, action, "--version", version, "--json", ...args], { cwd: root, encoding: "utf8" });
}

test("release checker starts without local skills, design documents, build or saved evidence", () => {
	const root = fixture();
	try {
		const result = cli(root);
		assert.equal(result.status, 0, result.stderr);
		const status = JSON.parse(result.stdout);
		assert.equal(status.metadata, "PASS");
		assert.equal(status.verification.result, "NEEDED");
		assert.equal(status.artifacts["main.js"], null);
		assert.equal(status.github, undefined);
		assert.equal(status.sha, git(root, "rev-parse", "HEAD"));
		assert.equal(cli(root, "status", "--sha", "a".repeat(40)).status, 1);
		assert.equal(cli(root, "assets").status, 1);
		fs.unlinkSync(path.join(root, "release-notes", `${version}.md`));
		assert.equal(cli(root).status, 1);
	} finally { removeFixture(root); }
});

test("verification reuses identical bytes after commit and only emits summary, with explicit force available", () => {
	const root = fixture();
	try {
		fs.appendFileSync(path.join(root, "styles.css"), "/* current candidate */\n");
		const first = cli(root, "verify");
		assert.equal(first.status, 0, first.stderr);
		assert.doesNotMatch(first.stdout + first.stderr, /PRIVATE_SUCCESS_LOG/u);
		const firstStatus = JSON.parse(first.stdout);
		assert.equal(firstStatus.verification.result, "REUSABLE");
		assert.match(fs.readFileSync(firstStatus.verification.log, "utf8"), /PRIVATE_SUCCESS_LOG/u);
		git(root, "add", "styles.css");
		git(root, "commit", "--quiet", "-m", "candidate");
		const second = cli(root, "verify");
		assert.equal(second.status, 0, second.stderr);
		const secondStatus = JSON.parse(second.stdout);
		assert.notEqual(firstStatus.sha, secondStatus.sha);
		assert.equal(firstStatus.fingerprint, secondStatus.fingerprint);
		assert.equal(fs.readFileSync(path.join(root, ".tmp/count"), "utf8"), "run\n");
		assert.equal(cli(root, "verify", "--force").status, 0);
		assert.equal(fs.readFileSync(path.join(root, ".tmp/count"), "utf8"), "run\nrun\n");
	} finally { removeFixture(root); }
});

test("source, untracked inputs, installed dependencies and artifact tampering invalidate reuse", async () => {
	const root = fixture();
	try {
		assert.equal(cli(root, "verify").status, 0);
		const checker = await load();
		const record = JSON.parse(fs.readFileSync(path.join(root, `.tmp/releases/${version}/verification.json`), "utf8"));
		const current = checker.verificationInputs(root);
		const artifacts = checker.artifactDigests(root);
		assert.equal(checker.canReuseVerification(record, current, artifacts), true);
		for (const file of ["styles.css", "package-lock.json", "scripts/verify.mjs", "node_modules/.package-lock.json"]) {
			const absolute = path.join(root, file);
			const original = fs.readFileSync(absolute);
			fs.appendFileSync(absolute, " ");
			assert.equal(checker.canReuseVerification(record, checker.verificationInputs(root), artifacts), false, file);
			fs.writeFileSync(absolute, original);
		}
		fs.writeFileSync(path.join(root, "new-source.ts"), "export {};\n");
		assert.notEqual(checker.verificationInputs(root).fingerprint, current.fingerprint);
		fs.unlinkSync(path.join(root, "new-source.ts"));
		fs.appendFileSync(path.join(root, "dist/main.js"), Buffer.from([2]));
		assert.equal(checker.canReuseVerification(record, current, checker.artifactDigests(root)), false);
		assert.equal(checker.canReuseVerification(record, { ...current, environment: { installedLock: null } }, artifacts), false);
	} finally { removeFixture(root); }
});

test("failed checks and inputs changing during successful checks never save reusable evidence", () => {
	const root = fixture();
	try {
		const verifyFile = path.join(root, "scripts/verify.mjs");
		const original = fs.readFileSync(verifyFile, "utf8");
		fs.appendFileSync(verifyFile, "fs.appendFileSync('styles.css', '/* changed during verify */');\n");
		assert.equal(cli(root, "verify").status, 1);
		const recordFile = path.join(root, `.tmp/releases/${version}/verification.json`);
		assert.equal(JSON.parse(fs.readFileSync(recordFile, "utf8")).inputsChanged, true);
		fs.writeFileSync(verifyFile, `${original}\nconsole.error('EXPECTED_FAILURE'); process.exitCode = 1;\n`);
		const failed = cli(root, "verify");
		assert.equal(failed.status, 1);
		assert.match(failed.stderr, /EXPECTED_FAILURE/u);
		assert.equal(JSON.parse(fs.readFileSync(recordFile, "utf8")).result, "FAIL");
		assert.equal(JSON.parse(cli(root).stdout).verification.result, "NEEDED");
	} finally { removeFixture(root); }
});

test("GitHub summary binds PR, CI and peeled tag to exact SHA and preserves auth uncertainty", async () => {
	const checker = await load();
	const sha = "a".repeat(40);
	const stale = "b".repeat(40);
	const status = checker.githubStatus("fixture", version, sha, (_root, command, args) => {
		let stdout: string;
		if (command === "git") stdout = args[0] === "remote" ? "git@github.com:example/knomo.git\n"
			: `${stale}\trefs/tags/${version}\n${sha}\trefs/tags/${version}^{}\n${sha}\trefs/heads/main\n`;
		else if (args[0] === "pr") stdout = JSON.stringify([
			{ headRefOid: stale, mergeCommit: { oid: sha } },
			{ headRefOid: stale, mergeCommit: { oid: stale } },
		]);
		else if (args[0] === "run") {
			assert.equal(args[args.indexOf("--commit") + 1], sha);
			stdout = JSON.stringify([{ headSha: sha }, { headSha: stale }]);
		} else return { status: 4, stdout: "", stderr: "authentication required" };
		return { status: 0, stdout, stderr: "" };
	});
	assert.equal(status.tag, sha);
	assert.equal(status.prs.value.length, 1);
	assert.equal(status.runs.value.length, 1);
	assert.equal(status.release.state, "INCONCLUSIVE");
});

test("public asset checks fetch anonymously, compare raw bundle and built CSS, and distinguish failures", async () => {
	const checker = await load();
	const contents: Record<string, Buffer> = {
		"main.js": Buffer.from([0, 255, 1]),
		"manifest.json": Buffer.from('{"id":"knomo","version":"2.3.4"}\n'),
		"styles.css": Buffer.from(".knomo{color:red}\n"),
	};
	const assets = Object.keys(contents).map(name => ({ name, url: `https://example.invalid/${name}` }));
	const expected = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, digest(bytes)]));
	const fetcher = async (url: string, init: RequestInit) => {
		assert.deepEqual(init.headers, { Accept: "application/octet-stream" });
		return new Response(new Uint8Array(contents[url.split("/").pop()!]), { status: 200 });
	};
	assert.ok((await checker.checkPublicAssets({ assets }, expected, fetcher)).every(result => result.result === "PASS"));
	const wrong = await checker.checkPublicAssets({ assets }, expected, async () => new Response("login page", { status: 200 }));
	assert.ok(wrong.every(result => result.result === "FAIL"));
	const missing = await checker.checkPublicAssets({ assets: assets.slice(1) }, expected, fetcher);
	assert.equal(missing[0].result, "FAIL");
	const network = await checker.checkPublicAssets({ assets }, expected, async () => { throw new Error("offline"); });
	assert.ok(network.every(result => result.result === "INCONCLUSIVE"));
});

test("candidate manifest uses Git bytes across CRLF while CSS uses the verified compressed build", async () => {
	const root = fixture();
	try {
		const checker = await load();
		const manifestFile = path.join(root, "manifest.json");
		const manifest = `${fs.readFileSync(manifestFile, "utf8")}\n`;
		fs.writeFileSync(manifestFile, manifest);
		git(root, "add", "manifest.json");
		git(root, "commit", "--quiet", "-m", "manifest LF");
		fs.writeFileSync(manifestFile, manifest.replace(/\n/gu, "\r\n"));
		assert.equal(cli(root, "verify").status, 0);
		const built = checker.artifactDigests(root);
		const expected = checker.candidateAssetDigests(root, git(root, "rev-parse", "HEAD"), built);
		assert.deepEqual(expected["manifest.json"], digest(Buffer.from(manifest)));
		assert.notDeepEqual(expected["manifest.json"], built["manifest.json"]);
		assert.deepEqual(expected["styles.css"], built["styles.css"]);
		assert.notDeepEqual(expected["styles.css"], digest(fs.readFileSync(path.join(root, "styles.css"))));
		fs.writeFileSync(path.join(root, "dist/manifest.json"), '{"id":"other"}');
		assert.throws(() => checker.candidateAssetDigests(root, git(root, "rev-parse", "HEAD"), built), /differs/u);
	} finally { removeFixture(root); }
});
