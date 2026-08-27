#!/usr/bin/env bun
// fork-sync: integrate the latest official stable release of can1357/oh-my-pi
// into the fork branch, then run the fork's focused regression checks.
//
// Stage flow (each failure class has its own exit code, so CI can classify):
//   preconditions (2) → upstream (3) → integration (4) → deps (5)
//   → static checks (6) → approval-review seam tests (7) → updater tests (8);
//   unexpected verification errors exit 9. Success and already-up-to-date exit 0.
//
// Integration strategy: a normal `git merge` of the official release tag. The
// fork branch is upstream main plus fork commits, so a tag merge preserves fork
// commits, keeps release ancestry (`git merge-base --is-ancestor v`), never
// rewrites history, and is repeatable. Conflicts stop the run with the exact
// abort command; nothing is auto-resolved, stashed, or rolled back.
//
// Which upstream release is integrated: the highest stable tag (`vX.Y.Z`)
// listed by `git ls-remote --tags upstream` — provably sourced from the
// official upstream, never from fork-owned local tags — merged into the
// branch so tag ancestry answers the question. No metadata file. `--dry-run`
// reports it.
//
// CI compatibility: non-interactive, deterministic exit codes, one progress
// line per stage (`fork-sync: <stage>: ...`), final `fork-sync: result: ...`.
// A future Action creates/resets a temp branch, then runs:
//   bun run fork:sync --branch <temp-branch>
// Test escape hatches (--upstream-url, --skip-verify) exist for temp-repo
// tests only; CI must never pass them.
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

const UPSTREAM_REMOTE = "upstream";
const OFFICIAL_REPO_URL = "https://github.com/can1357/oh-my-pi.git";
const OFFICIAL_REPO_SLUG = "can1357/oh-my-pi";
const STABLE_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEAM_TEST_FILE = "test/extensions-runner.test.ts";
const SEAM_TEST_FILTER = "tool_approval_review";
const UPDATER_TEST_FILE = "test/cli/update-cli.test.ts";
const DEPS_TRIGGER_FILES: Record<string, true> = { "package.json": true, "bun.lock": true, "bun.lockb": true };
const PRECONDITION_DELAYED_HINT = "resolve the state above (or run the shown recovery command), then retry";

const EXIT_CODES = {
	ok: 0,
	preconditions: 2,
	upstream: 3,
	integration: 4,
	deps: 5,
	static: 6,
	seam: 7,
	updater: 8,
	verify: 9,
} as const;
type FailureClass = Exclude<keyof typeof EXIT_CODES, "ok">;

export function parseStableTag(tag: string): [number, number, number] | null {
	const match = STABLE_TAG_RE.exec(tag);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Parses `git ls-remote --tags upstream` output into tag → commit sha.
// Annotated tags appear twice (`refs/tags/x` = tag object, `refs/tags/x^{}` =
// peeled commit); the peeled entry wins so the map always holds commit shas.
export function upstreamTagCommits(lsRemoteOutput: string): Map<string, string> {
	const commits = new Map<string, string>();
	for (const line of lsRemoteOutput.split("\n")) {
		const match = /^([0-9a-f]{40})\trefs\/tags\/(.+)$/.exec(line.trim());
		if (!match) continue;
		const [, sha, ref] = match;
		if (ref.endsWith("^{}")) {
			commits.set(ref.slice(0, -3), sha);
		} else if (!commits.has(ref)) {
			commits.set(ref, sha);
		}
	}
	return commits;
}

export function latestStableTag(tags: string[]): string | null {
	let best: string | null = null;
	let bestVersion: [number, number, number] | null = null;
	for (const tag of tags) {
		const version = parseStableTag(tag);
		if (!version) continue;
		const newer =
			!bestVersion ||
			(version[0] !== bestVersion[0]
				? version[0] > bestVersion[0]
				: version[1] !== bestVersion[1]
					? version[1] > bestVersion[1]
					: version[2] > bestVersion[2]);
		if (newer) {
			best = tag;
			bestVersion = version;
		}
	}
	return best;
}

function normalizeRepoUrl(url: string): string {
	return url
		.trim()
		.replace(/\.git\/?$/i, "")
		.replace(/\/$/, "")
		.toLowerCase();
}

export function isOfficialUpstreamUrl(url: string): boolean {
	const normalized = normalizeRepoUrl(url);
	return (
		normalized === `https://github.com/${OFFICIAL_REPO_SLUG}` ||
		normalized === `git@github.com:${OFFICIAL_REPO_SLUG}` ||
		normalized === `ssh://git@github.com/${OFFICIAL_REPO_SLUG}`
	);
}

export function inProgressGitOperation(gitPath: (name: string) => string): string | null {
	const markers: Array<[string, string]> = [
		["MERGE_HEAD", "merge"],
		["CHERRY_PICK_HEAD", "cherry-pick"],
		["REVERT_HEAD", "revert"],
		["rebase-merge", "rebase"],
		["rebase-apply", "rebase"],
	];
	for (const [name, op] of markers) {
		if (fs.existsSync(gitPath(name))) return op;
	}
	return null;
}

interface Options {
	repo: string;
	tag?: string;
	branch?: string;
	upstreamUrl?: string;
	dryRun: boolean;
	skipVerify: boolean;
}

function parseArgs(argv: string[]): Options {
	const options: Options = { repo: ".", dryRun: false, skipVerify: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			i++;
			if (i >= argv.length) fail("preconditions", `missing value for ${arg}`);
			return argv[i];
		};
		switch (arg) {
			case "--repo":
				options.repo = next();
				break;
			case "--tag":
				options.tag = next();
				break;
			case "--branch":
				options.branch = next();
				break;
			case "--upstream-url":
				options.upstreamUrl = next();
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--skip-verify":
				options.skipVerify = true;
				break;
			default:
				fail("preconditions", `unknown argument: ${arg}`);
		}
	}
	return options;
}

function log(stage: string, message: string): void {
	console.log(`fork-sync: ${stage}: ${message}`);
}

function fail(cls: FailureClass, message: string): never {
	console.error(`fork-sync: FAILED (${cls}): ${message}`);
	console.error(`fork-sync: result: failed (${cls})`);
	process.exit(EXIT_CODES[cls]);
}

interface RunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function makeGit(cwd: string) {
	return async (args: string[]): Promise<RunResult> => {
		const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
		return {
			ok: result.exitCode === 0,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	};
}

// Runs a long verification command with inherited stdio so live output reaches
// the console/CI log; returns false on non-zero exit.
async function runStreaming(cwd: string, args: string[]): Promise<boolean> {
	const result = await $`${args}`.cwd(cwd).nothrow();
	return result.exitCode === 0;
}

async function main(): Promise<number> {
	const options = parseArgs(process.argv.slice(2));
	const repo = path.resolve(options.repo);
	const git = makeGit(repo);

	// ---- Stage: preconditions -------------------------------------------
	log("preconditions", `repository: ${repo}`);

	const toplevel = await git(["rev-parse", "--show-toplevel"]);
	if (!toplevel.ok) fail("preconditions", `not a git repository: ${repo}`);
	const workTree = toplevel.stdout.trim();

	const gitPath = (name: string) => path.join(workTree, ".git", name);
	const inProgress = inProgressGitOperation(gitPath);
	if (inProgress) {
		console.error(`fork-sync: an in-progress ${inProgress} operation is active.`);
		console.error(`fork-sync: ${PRECONDITION_DELAYED_HINT}.`);
		fail("preconditions", `in-progress ${inProgress} operation`);
	}

	const status = await git(["status", "--porcelain"]);
	if (status.stdout.trim().length > 0) {
		console.error("fork-sync: working tree is not clean; refusing to sync.");
		for (const entry of status.stdout.split("\n").filter(line => line.trim())) {
			console.error(`  ${entry}`);
		}
		console.error("fork-sync: commit, stash, or remove these changes first (no auto-stash).");
		fail("preconditions", "dirty working tree");
	}

	const headRef = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (!headRef.ok) fail("preconditions", "detached HEAD; check out a branch before syncing");
	let branch = headRef.stdout.trim();

	if (options.branch && options.branch !== branch) {
		const checkout = await git(["checkout", options.branch]);
		if (!checkout.ok) {
			console.error(checkout.stderr);
			fail("preconditions", `cannot check out branch ${options.branch} (must already exist)`);
		}
		branch = options.branch;
	}
	log("preconditions", `target branch: ${branch}`);

	// ---- Stage: upstream --------------------------------------------------
	const officialUrl = options.upstreamUrl ?? OFFICIAL_REPO_URL;
	const remoteUrl = await git(["remote", "get-url", UPSTREAM_REMOTE]);
	if (!remoteUrl.ok) {
		log("upstream", `remote '${UPSTREAM_REMOTE}' missing; adding ${officialUrl}`);
		const add = await git(["remote", "add", UPSTREAM_REMOTE, officialUrl]);
		if (!add.ok) {
			console.error(add.stderr);
			fail("upstream", `could not add remote '${UPSTREAM_REMOTE}'`);
		}
	} else if (!options.upstreamUrl && !isOfficialUpstreamUrl(remoteUrl.stdout)) {
		fail(
			"upstream",
			`remote '${UPSTREAM_REMOTE}' points at '${remoteUrl.stdout.trim()}' instead of ${OFFICIAL_REPO_SLUG}; not repointing automatically`,
		);
	}

	log(
		"upstream",
		`fetching branches and tags from '${UPSTREAM_REMOTE}' (no pruning; fork-owned tags are never deleted)`,
	);
	const fetch = await git(["fetch", UPSTREAM_REMOTE, "--tags"]);
	if (!fetch.ok) {
		console.error(fetch.stderr);
		fail("upstream", `git fetch ${UPSTREAM_REMOTE} failed`);
	}

	// ---- Stage: release resolution ---------------------------------------
	// The candidate set comes from `ls-remote --tags upstream`, i.e. provably
	// from the official upstream — a fork-only local vX.Y.Z tag can never be
	// selected as an upstream release.
	const lsRemote = await git(["ls-remote", "--tags", UPSTREAM_REMOTE]);
	if (!lsRemote.ok) {
		console.error(lsRemote.stderr);
		fail("upstream", `git ls-remote --tags ${UPSTREAM_REMOTE} failed`);
	}
	const upstreamTags = upstreamTagCommits(lsRemote.stdout);

	let tag: string;
	if (options.tag) {
		if (!parseStableTag(options.tag)) {
			fail("upstream", `--tag ${options.tag} is not a stable release tag (expected vX.Y.Z)`);
		}
		if (!upstreamTags.has(options.tag)) {
			fail("upstream", `tag ${options.tag} does not exist on upstream '${UPSTREAM_REMOTE}'`);
		}
		tag = options.tag;
	} else {
		const selected = latestStableTag([...upstreamTags.keys()]);
		if (!selected) fail("upstream", "no stable vX.Y.Z tags found on upstream");
		tag = selected;
	}

	// A fork-owned local tag with the same name must not shadow the official
	// release commit; refuse instead of merging the wrong code.
	const localResolve = await git(["rev-parse", "-q", "--verify", `${tag}^{commit}`]);
	const upstreamCommit = upstreamTags.get(tag);
	if (localResolve.ok && localResolve.stdout.trim() !== upstreamCommit) {
		fail(
			"upstream",
			`local tag ${tag} points at ${localResolve.stdout.trim()} but upstream '${UPSTREAM_REMOTE}' has ${upstreamCommit}; refusing to merge the wrong commit (repoint or delete the local tag manually)`,
		);
	}
	log("release", `latest stable upstream release: ${tag}`);

	const isAncestor = await git(["merge-base", "--is-ancestor", tag, branch]);
	if (isAncestor.ok) {
		log("result", `${tag} is already integrated into ${branch}; nothing to do`);
		console.log("fork-sync: result: ok (already integrated)");
		return EXIT_CODES.ok;
	}
	log("release", `${tag} is NOT yet integrated into ${branch}`);

	if (options.dryRun) {
		console.log(`fork-sync: result: ok (dry-run; would merge ${tag} into ${branch})`);
		return EXIT_CODES.ok;
	}

	// ---- Stage: integration ----------------------------------------------
	log("integration", `merging ${tag} into ${branch}`);
	const merge = await git(["merge", "--no-edit", "-m", `Merge official release ${tag} (${OFFICIAL_REPO_SLUG})`, tag]);
	if (!merge.ok) {
		const conflicted = await git(["diff", "--name-only", "--diff-filter=U"]);
		const files = conflicted.stdout.split("\n").filter(line => line.trim());
		console.error("fork-sync: source integration FAILED with merge conflicts in:");
		for (const file of files) console.error(`  ${file}`);
		console.error("fork-sync: recovery: git merge --abort");
		fail("integration", `merge of ${tag} reported conflicts`);
	}
	const mergeCommit = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
	log("integration", `merged ${tag} as ${mergeCommit}`);

	// ---- Stage: deps --------------------------------------------------------
	const changedFiles = await git(["diff", "--name-only", "ORIG_HEAD", "HEAD"]);
	const touchedDeps = changedFiles.stdout
		.split("\n")
		.some(file => DEPS_TRIGGER_FILES[path.basename(file.trim())] === true);
	if (touchedDeps) {
		log("deps", "package manifest/lockfile changed; running bun install");
		if (!(await runStreaming(repo, ["bun", "install"]))) {
			fail("deps", "bun install failed after merge");
		}
	} else {
		log("deps", "no dependency changes; skipping install");
	}

	// ---- Stage: verification -------------------------------------------------
	if (options.skipVerify) {
		log("verify", "--skip-verify set; skipping static checks and focused tests");
		console.log(`fork-sync: result: ok (integration only, verification skipped)`);
		return EXIT_CODES.ok;
	}

	const packageDir = path.join(repo, FOCUS_PACKAGE_DIR);
	const checks: Array<{ name: string; cls: FailureClass; cwd: string; args: string[] }> = [
		{ name: "static checks (biome + typecheck)", cls: "static", cwd: repo, args: ["bun", "run", "check:ts"] },
		{
			name: "tool_approval_review seam tests",
			cls: "seam",
			cwd: packageDir,
			args: ["bun", "test", SEAM_TEST_FILE, "-t", SEAM_TEST_FILTER],
		},
		{
			name: "fork updater/distribution tests",
			cls: "updater",
			cwd: packageDir,
			args: ["bun", "test", UPDATER_TEST_FILE],
		},
	];

	for (const check of checks) {
		log("verify", `running ${check.name}`);
		let passed: boolean;
		try {
			passed = await runStreaming(check.cwd, check.args);
		} catch (error) {
			fail("verify", `${check.name} could not run: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!passed) {
			console.error(
				`fork-sync: source integration SUCCEEDED (${tag} as ${mergeCommit}); only ${check.name} failed.`,
			);
			console.error(`fork-sync: inspect the integration: git show ${mergeCommit}`);
			console.error(
				"fork-sync: OPTIONAL destructive undo — this DISCARDS the integration commit and the resulting local state: git reset --hard ORIG_HEAD",
			);
			fail(check.cls, `${check.name} failed`);
		}
	}

	console.log(`fork-sync: result: ok (integrated ${tag} as ${mergeCommit}; all checks passed)`);
	console.log("fork-sync: fork is compatible and ready for release.");
	return EXIT_CODES.ok;
}

// Post-integration verification failure: integration itself succeeded and the
// merged state is left in place. Inspect with `git show`, undo with
// `git reset --hard ORIG_HEAD` (deliberate, manual), or fix forward.

if (import.meta.main) {
	process.exit(await main());
}
