import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ASSETS = ["main.js", "manifest.json", "styles.css"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function run(root, command, args, options = {}) {
	const windowsNpm = process.platform === "win32" && command === "npm";
	return spawnSync(windowsNpm ? (process.env.ComSpec ?? "cmd.exe") : command,
		windowsNpm ? ["/d", "/s", "/c", "npm.cmd", ...args] : args,
		{ cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...options });
}

function output(result) {
	if (result.error || result.status !== 0) {
		throw new Error(result.error?.message ?? result.stderr?.toString().trim() ?? `Exit ${result.status}`);
	}
	return result.stdout;
}

function git(root, ...args) {
	return output(run(root, "git", args)).trim();
}

function readJson(file) {
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function artifactDigests(root) {
	return Object.fromEntries(ASSETS.map(name => {
		const file = path.join(root, "dist", name);
		if (!fs.existsSync(file)) return [name, null];
		const bytes = fs.readFileSync(file);
		return [name, { bytes: bytes.length, sha256: sha256(bytes) }];
	}));
}

export function verificationInputs(root) {
	const files = [...new Set(output(run(root, "git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
		.split("\0").filter(Boolean))].sort();
	const hash = createHash("sha256");
	for (const file of files) {
		const absolute = path.join(root, file);
		const stat = fs.existsSync(absolute) ? fs.lstatSync(absolute) : null;
		const bytes = stat?.isSymbolicLink() ? Buffer.from(fs.readlinkSync(absolute))
			: stat?.isFile() ? fs.readFileSync(absolute) : Buffer.alloc(0);
		hash.update(`${file}\0${stat?.mode ?? "missing"}\0${bytes.length}\0`).update(bytes);
	}
	const installedLock = path.join(root, "node_modules", ".package-lock.json");
	const environment = {
		node: process.version, npm: output(run(root, "npm", ["--version"])).trim(),
		platform: process.platform, arch: process.arch,
		installedLock: fs.existsSync(installedLock) ? sha256(fs.readFileSync(installedLock)) : null,
		options: sha256(JSON.stringify([process.env.NODE_OPTIONS, process.env.NODE_ENV, process.env.CI, process.env.TZ,
			process.env.ESBUILD_BINARY_PATH])),
	};
	const inputs = hash.digest("hex");
	return { inputs, environment, fingerprint: sha256(JSON.stringify({ inputs, environment })) };
}

export function canReuseVerification(record, current, artifacts) {
	return record?.result === "PASS" && record.command === "npm run verify"
		&& current.environment.installedLock !== null && record.fingerprint === current.fingerprint
		&& ASSETS.every(name => artifacts[name] !== null
			&& artifacts[name]?.sha256 === record.artifacts?.[name]?.sha256
			&& artifacts[name]?.bytes === record.artifacts?.[name]?.bytes);
}

export function candidateAssetDigests(root, sha, artifacts) {
	// manifest 由 Git blob 确定发布字节；CSS 已由构建压缩，保留经过验证的 dist 基线。
	const blob = run(root, "git", ["show", `${sha}:manifest.json`], { encoding: null });
	output(blob);
	const builtManifest = readJson(path.join(root, "dist", "manifest.json"));
	if (JSON.stringify(JSON.parse(blob.stdout)) !== JSON.stringify(builtManifest)) throw new Error("Built manifest differs from candidate Git blob");
	return { ...artifacts, "manifest.json": { bytes: blob.stdout.length, sha256: sha256(blob.stdout) } };
}

function githubJson(root, args, execute) {
	const result = execute(root, "gh", args);
	if (result.error || result.status !== 0) {
		const error = result.error?.message ?? result.stderr?.trim() ?? `Exit ${result.status}`;
		return { state: /release not found/iu.test(error) ? "NOT_FOUND" : "INCONCLUSIVE", error };
	}
	return { state: "OK", value: JSON.parse(result.stdout) };
}

export function githubStatus(root, version, sha, execute = run) {
	const remote = output(execute(root, "git", ["remote", "get-url", "origin"])).trim();
	const match = /^(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/](.+)$/u.exec(remote);
	if (!match) throw new Error(`Cannot resolve GitHub repository from origin: ${remote}`);
	const repository = match[2].replace(/\.git$/u, "");
	if (!/^[^/]+\/[^/]+$/u.test(repository)) throw new Error("origin must identify one OWNER/REPO");
	const repo = `${match[1]}/${repository}`;
	const ref = `refs/tags/${version}`;
	const refs = Object.fromEntries(output(execute(root, "git", ["ls-remote", "origin", "refs/heads/main", "refs/heads/dev", ref, `${ref}^{}`])).trim()
		.split("\n").filter(Boolean).map(line => line.split(/\s+/u).reverse()));
	const prs = githubJson(root, ["pr", "list", "--repo", repo, "--base", "main", "--head", "dev", "--state", "all",
		"--limit", "30", "--json", "number,url,state,headRefOid,mergeCommit,statusCheckRollup"], execute);
	if (prs.state === "OK") prs.value = prs.value.filter(pr => pr.headRefOid === sha || pr.mergeCommit?.oid === sha);
	const runs = githubJson(root, ["run", "list", "--repo", repo, "--commit", sha, "--limit", "20",
		"--json", "headSha,name,event,status,conclusion,url"], execute);
	if (runs.state === "OK") runs.value = runs.value.filter(run => run.headSha === sha);
	return {
		repository: repo, observedAt: new Date().toISOString(),
		main: refs["refs/heads/main"] ?? null, dev: refs["refs/heads/dev"] ?? null,
		tag: refs[`${ref}^{}`] ?? refs[ref] ?? null,
		prs,
		runs,
		release: githubJson(root, ["release", "view", version, "--repo", repo,
			"--json", "tagName,isDraft,isPrerelease,publishedAt,url,assets"], execute),
	};
}

export async function checkPublicAssets(release, expected, fetchAsset = fetch) {
	const results = [];
	for (const name of ASSETS) {
		const matches = release.assets.filter(asset => asset.name === name);
		const result = { name, observedAt: new Date().toISOString(), expected: expected[name] };
		if (matches.length !== 1) {
			results.push({ ...result, result: "FAIL", error: `Expected one release asset, got ${matches.length}` });
			continue;
		}
		try {
			if (!expected[name]) throw new Error("Expected a trusted baseline");
			result.url = matches[0].url;
			if (new URL(result.url).protocol !== "https:") throw new Error("Expected an HTTPS asset URL");
			// 匿名读取实际附件；不传 GitHub token，也不以 API 元数据代替字节核验。
			const response = await fetchAsset(result.url, { headers: { Accept: "application/octet-stream" }, signal: AbortSignal.timeout(30_000) });
			result.http = response.status;
			result.finalUrl = response.url;
			const bytes = Buffer.from(await response.arrayBuffer());
			result.bytes = bytes.length;
			result.sha256 = sha256(bytes);
			result.result = response.status === 200 && bytes.length === expected[name].bytes
				&& result.sha256 === expected[name].sha256 ? "PASS" : "FAIL";
		} catch (error) {
			result.result = "INCONCLUSIVE";
			result.error = error.message;
		}
		results.push(result);
	}
	return results;
}

function verify(root, directory, current, artifacts, previous, force) {
	if (!force && canReuseVerification(previous, current, artifacts)) return previous;
	const log = path.join(directory, `verify-${Date.now()}.log`);
	const fd = fs.openSync(log, "w");
	let result;
	try {
		result = run(root, "npm", ["run", "verify"], { stdio: ["ignore", fd, fd], timeout: 30 * 60_000 });
	} finally { fs.closeSync(fd); }
	const after = verificationInputs(root);
	const built = artifactDigests(root);
	const passed = !result.error && result.status === 0 && current.fingerprint === after.fingerprint
		&& ASSETS.every(name => built[name] !== null);
	const record = {
		result: passed ? "PASS" : "FAIL", command: "npm run verify", observedAt: new Date().toISOString(),
		head: git(root, "rev-parse", "HEAD"), ...after, artifacts: built, log,
		exitCode: result.status, error: result.error?.message,
		inputsChanged: current.fingerprint !== after.fingerprint,
	};
	writeJson(path.join(directory, "verification.json"), record);
	// 成功只返回摘要；失败详情保留完整日志并输出有限尾部。
	const lines = fs.readFileSync(log, "utf8").trimEnd().split(/\r?\n/u);
	console.error(passed ? lines.filter(line => /^(?:ℹ|#) (?:tests|pass|fail|skipped) /u.test(line)).join("\n") : lines.slice(-60).join("\n"));
	return record;
}

export async function main(args, root = process.cwd()) {
	const action = args.shift();
	const options = {};
	while (args.length > 0) {
		const flag = args.shift();
		if (["--github", "--force", "--json"].includes(flag)) options[flag.slice(2)] = true;
		else if (["--version", "--sha"].includes(flag) && args.length > 0) options[flag.slice(2)] = args.shift();
		else throw new Error(`Unknown or incomplete option: ${flag}`);
	}
	if (!["status", "verify", "assets"].includes(action) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(options.version ?? "")) {
		throw new Error("Usage: node scripts/release-check.mjs status|verify|assets --version X.Y.Z [--sha FULL_SHA] [--github] [--force] [--json]");
	}
	root = git(root, "rev-parse", "--show-toplevel");
	const sha = git(root, "rev-parse", "HEAD");
	if (options.sha && (!/^[a-f0-9]{40}$/u.test(options.sha) || options.sha !== sha)) throw new Error("--sha must be the full current HEAD SHA");
	if (action === "assets" && !options.sha) throw new Error("assets requires --sha FULL_SHA");
	if (options.force && action !== "verify") throw new Error("--force is only valid with verify");
	const directory = path.join(root, ".tmp", "releases", options.version);
	fs.mkdirSync(directory, { recursive: true });
	const current = verificationInputs(root);
	const versionCheck = run(root, process.execPath, ["scripts/check-release-version.mjs"], { env: { ...process.env, GITHUB_REF_NAME: options.version } });
	const notes = path.join(root, "release-notes", `${options.version}.md`);
	const manifest = readJson(path.join(root, "manifest.json"));
	const summary = {
		version: options.version, sha, branch: git(root, "branch", "--show-current"), observedAt: new Date().toISOString(),
		dirty: git(root, "status", "--porcelain=v1", "--untracked-files=normal"), ...current,
		metadata: versionCheck.status === 0 && manifest?.id === "knomo" && fs.existsSync(notes) && fs.statSync(notes).size > 0 ? "PASS" : "FAIL",
		metadataDetails: (versionCheck.stderr || versionCheck.stdout || versionCheck.error?.message || "").trim(),
		artifacts: artifactDigests(root),
		scans: "Browser evidence required: record exact version/SHA, status, all completed findings and decisions in record.md",
	};
	let record = readJson(path.join(directory, "verification.json"));
	if (action === "verify") {
		if (summary.metadata !== "PASS") throw new Error(`Release metadata/notes invalid: ${summary.metadataDetails}`);
		record = verify(root, directory, current, summary.artifacts, record, options.force);
		summary.artifacts = artifactDigests(root);
	}
	const reusable = canReuseVerification(record, verificationInputs(root), summary.artifacts);
	summary.verification = { result: reusable ? "REUSABLE" : "NEEDED", head: record?.head, log: record?.log };
	if (options.github || action === "assets") {
		try { summary.github = githubStatus(root, options.version, sha); }
		catch (error) { summary.github = { state: "INCONCLUSIVE", error: error.message }; }
	}
	if (action === "assets") {
		const release = summary.github.release;
		if (summary.dirty || summary.metadata !== "PASS" || !reusable || summary.github.tag !== sha
			|| release?.state !== "OK" || release.value.tagName !== options.version
			|| release.value.isDraft || release.value.isPrerelease || !release.value.publishedAt) {
			throw new Error("Asset check requires clean candidate, matching verification/build, exact remote tag and published stable release");
		}
		const expected = candidateAssetDigests(root, sha, summary.artifacts);
		summary.assets = await checkPublicAssets(release.value, expected);
		writeJson(path.join(directory, "assets.json"), { sha, version: options.version, results: summary.assets });
	}
	writeJson(path.join(directory, "status.json"), summary);
	if (options.json) console.log(JSON.stringify(summary, null, 2));
	else {
		console.log(`${summary.version} ${summary.sha}\nBranch: ${summary.branch}; worktree: ${summary.dirty ? "DIRTY" : "clean"}`);
		console.log(`Metadata/notes: ${summary.metadata}; verification: ${summary.verification.result}`);
		if (record?.log) console.log(`Verification log: ${record.log}`);
		if (summary.metadata !== "PASS") console.log(summary.metadataDetails);
		if (summary.github?.state === "INCONCLUSIVE") console.log(`GitHub: INCONCLUSIVE; ${summary.github.error}`);
		else if (summary.github) {
			const github = summary.github;
			console.log(`Remote main: ${github.main}; tag: ${github.tag ?? "absent"}`);
			console.log(`PR: ${github.prs.state === "OK" ? github.prs.value.map(pr => `${pr.url} (${pr.state})`).join(", ") || "no candidate match in latest 30" : github.prs.state}`);
			for (const pr of github.prs.value ?? []) console.log(`PR head ${pr.headRefOid} checks: ${pr.statusCheckRollup.map(check => `${check.name ?? check.context}: ${check.conclusion || check.state || check.status}`).join(", ") || "none"}`);
			console.log(`CI: ${github.runs.state === "OK" ? github.runs.value.map(run => `${run.name} ${run.status}/${run.conclusion} ${run.url}`).join("\n") || "no candidate runs in latest 20" : github.runs.state}`);
			console.log(`Release: ${github.release.value?.url ?? github.release.state}`);
		}
		for (const asset of summary.assets ?? []) console.log(`${asset.name}: ${asset.result}; HTTP ${asset.http ?? "?"}; ${asset.bytes ?? "?"} bytes; ${asset.sha256 ?? asset.error}`);
		console.log(`Scans: ${summary.scans}\nEvidence: ${path.join(directory, "status.json")}`);
	}
	return summary.metadata !== "PASS" || summary.github?.state === "INCONCLUSIVE" || (action === "verify" && !reusable)
		|| summary.assets?.some(asset => asset.result !== "PASS") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try { process.exitCode = await main(process.argv.slice(2)); }
	catch (error) { console.error(error.message); process.exitCode = 1; }
}
