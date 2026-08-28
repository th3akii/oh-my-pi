import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	inProgressGitOperation,
	isOfficialUpstreamUrl,
	latestStableTag,
	parseStableTag,
	upstreamTagCommits,
} from "./fork-sync";

const REPO_ROOT = path.join(import.meta.dir, "..");

describe("stable tag parsing", () => {
	test("accepts bare stable vX.Y.Z tags", () => {
		expect(parseStableTag("v18.0.8")).toEqual([18, 0, 8]);
		expect(parseStableTag("v0.0.0")).toEqual([0, 0, 0]);
		expect(parseStableTag("v117.234.5")).toEqual([117, 234, 5]);
	});

	test("rejects prerelease suffixes, partial versions, and malformed tags", () => {
		// Upstream irregular tags (v0.5.0-rc1, v0.5.3-pods) must never win.
		expect(parseStableTag("v18.0.8-rc1")).toBe(null);
		expect(parseStableTag("v18.0.8-canary.1")).toBe(null);
		expect(parseStableTag("v18.0")).toBe(null);
		expect(parseStableTag("v18")).toBe(null);
		expect(parseStableTag("18.0.8")).toBe(null);
		expect(parseStableTag("v18.0.x")).toBe(null);
		expect(parseStableTag("")).toBe(null);
	});

	test("rejects leading zeroes so tags sort by value, not string", () => {
		expect(parseStableTag("v018.0.0")).toBe(null);
		expect(parseStableTag("v18.00.0")).toBe(null);
	});
});

describe("upstream ls-remote tag parsing", () => {
	test("maps lightweight and annotated tags to their commit sha", () => {
		// Annotated tag: plain entry = tag object sha, peeled `^{}` = commit.
		const commits = upstreamTagCommits(
			[
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v1.0.0",
				"cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v2.0.0",
				"dddddddddddddddddddddddddddddddddddddddd\trefs/tags/v2.0.0^{}",
				"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\trefs/heads/main",
				"garbage line",
			].join("\n"),
		);
		expect(commits.get("v1.0.0")).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		expect(commits.get("v2.0.0")).toBe("dddddddddddddddddddddddddddddddddddddddd"); // peeled wins
		expect(commits.size).toBe(2); // branches and malformed lines ignored
	});
});

describe("latest stable tag selection", () => {
	test("selects the highest semantic version, not the lexicographically last", () => {
		expect(latestStableTag(["v1.9.9", "v1.10.0", "v1.2.0"])).toBe("v1.10.0");
		expect(latestStableTag(["v2.0.0", "v10.0.0"])).toBe("v10.0.0");
	});

	test("ignores prereleases and malformed tags", () => {
		expect(latestStableTag(["v18.0.8", "v18.0.9-canary.1", "v18.0.9-rc1"])).toBe("v18.0.8");
		expect(latestStableTag(["junk", "v0.5.0-rc1"])).toBe(null);
		expect(latestStableTag([])).toBe(null);
	});
});

describe("upstream remote URL validation", () => {
	test("accepts official can1357/oh-my-pi in https and ssh spellings", () => {
		expect(isOfficialUpstreamUrl("https://github.com/can1357/oh-my-pi.git")).toBe(true);
		expect(isOfficialUpstreamUrl("https://github.com/can1357/oh-my-pi")).toBe(true);
		expect(isOfficialUpstreamUrl("git@github.com:can1357/oh-my-pi.git")).toBe(true);
	});

	test("rejects any other repository so an existing upstream remote is never repointed silently", () => {
		expect(isOfficialUpstreamUrl("https://github.com/th3akii/oh-my-pi.git")).toBe(false);
		expect(isOfficialUpstreamUrl("https://github.com/can1357/other.git")).toBe(false);
		expect(isOfficialUpstreamUrl("https://gitlab.com/can1357/oh-my-pi.git")).toBe(false);
	});
});

describe("in-progress git operation detection", () => {
	test("names the active operation from its marker file, null when none", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fork-sync-op-"));
		try {
			await fs.mkdir(path.join(dir, "rebase-merge"), { recursive: true });
			expect(inProgressGitOperation(name => path.join(dir, name))).toBe("rebase");
			const empty = await fs.mkdtemp(path.join(os.tmpdir(), "fork-sync-clean-"));
			try {
				expect(inProgressGitOperation(name => path.join(empty, name))).toBe(null);
			} finally {
				await fs.rm(empty, { recursive: true, force: true });
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

// ---- End-to-end behavior against isolated temp repositories ---------------
async function gitIn(cwd: string, args: string[]): Promise<void> {
	const result = await $`git ${args}`.cwd(cwd).nothrow();
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

async function runSync(args: string[]): Promise<{ exitCode: number; output: string }> {
	const proc = Bun.spawn(["bun", "scripts/fork-sync.ts", ...args], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	return { exitCode, output: `${stdout}\n${stderr}` };
}

interface TempRepos {
	upstream: string;
	fork: string;
	cleanup: () => Promise<void>;
}

async function createTempRepos(): Promise<TempRepos> {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "fork-sync-e2e-"));
	const upstream = path.join(base, "upstream");
	const fork = path.join(base, "fork");
	await fs.mkdir(upstream, { recursive: true });
	await gitIn(upstream, ["init", "-b", "main"]);
	await gitIn(upstream, ["config", "user.email", "sync-test@example.com"]);
	await gitIn(upstream, ["config", "user.name", "Sync Test"]);
	await Bun.write(path.join(upstream, "README.md"), "base\n");
	await Bun.write(path.join(upstream, "app.txt"), "upstream base\n");
	await gitIn(upstream, ["add", "."]);
	await gitIn(upstream, ["commit", "-m", "base"]);
	await gitIn(upstream, ["tag", "v1.0.0"]);
	await $`git clone ${upstream} ${fork}`.quiet();
	await gitIn(fork, ["config", "user.email", "sync-test@example.com"]);
	await gitIn(fork, ["config", "user.name", "Sync Test"]);
	await Bun.write(path.join(fork, "fork-feature.txt"), "fork only\n");
	await gitIn(fork, ["add", "."]);
	await gitIn(fork, ["commit", "-m", "feat(fork): fork-specific feature"]);
	return {
		upstream,
		fork,
		cleanup: async () => {
			await fs.rm(base, { recursive: true, force: true });
		},
	};
}

async function advanceUpstream(upstream: string, appContent: string, tag: string): Promise<void> {
	await Bun.write(path.join(upstream, "app.txt"), appContent);
	await gitIn(upstream, ["add", "."]);
	await gitIn(upstream, ["commit", "-m", `release ${tag}`]);
	await gitIn(upstream, ["tag", tag]);
}

const SYNC_FLAGS = ["--skip-verify"] as const;

describe("fork-sync end to end (temp repositories)", () => {
	test("merges a new upstream release, preserves fork commits, and detects already-integrated state", async () => {
		const repos = await createTempRepos();
		try {
			await advanceUpstream(repos.upstream, "upstream v1.1.0\n", "v1.1.0");
			const first = await runSync(["--repo", repos.fork, "--upstream-url", repos.upstream, ...SYNC_FLAGS]);
			expect(first.exitCode).toBe(0);
			expect(first.output).toContain("merged v1.1.0");

			const feature = await Bun.file(path.join(repos.fork, "fork-feature.txt")).text();
			expect(feature).toBe("fork only\n"); // fork commit preserved across merge
			const ancestry = await $`git merge-base --is-ancestor refs/remotes/upstream-tag/v1.1.0 HEAD`
				.cwd(repos.fork)
				.nothrow();
			expect(ancestry.exitCode).toBe(0); // upstream release commit is now in fork ancestry
			const message = await $`git log -1 --format=%s`.cwd(repos.fork).text();
			expect(message).toContain("Merge official release v1.1.0");

			const second = await runSync(["--repo", repos.fork, "--upstream-url", repos.upstream, ...SYNC_FLAGS]);
			expect(second.exitCode).toBe(0);
			expect(second.output).toContain("already integrated");
		} finally {
			await repos.cleanup();
		}
	}, 30000);

	test("a higher fork-only local vX.Y.Z tag survives sync and is never selected as the upstream release", async () => {
		const repos = await createTempRepos();
		try {
			await advanceUpstream(repos.upstream, "upstream v1.1.0\n", "v1.1.0");
			await gitIn(repos.fork, ["tag", "v9.9.9"]); // fork-owned, higher than any upstream tag
			await gitIn(repos.fork, ["tag", "v0.1.0-fork"]); // fork-owned prerelease-shaped

			const result = await runSync(["--repo", repos.fork, "--upstream-url", repos.upstream, ...SYNC_FLAGS]);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("merged v1.1.0"); // upstream tag selected, not v9.9.9

			const tags = await $`git tag --list`.cwd(repos.fork).text();
			expect(tags).toContain("v9.9.9"); // fork-owned tags never pruned/deleted
			expect(tags).toContain("v0.1.0-fork");
		} finally {
			await repos.cleanup();
		}
	}, 30000);

	test("a same-named fork tag diverging from upstream never blocks sync and is never clobbered", async () => {
		const repos = await createTempRepos();
		try {
			await advanceUpstream(repos.upstream, "upstream v1.1.0\n", "v1.1.0");
			// Fork publishes its own release under the same tag name, pointing at the
			// fork commit — a different commit than upstream's v1.1.0.
			await gitIn(repos.fork, ["tag", "v1.1.0"]);
			const forkTagBefore = await $`git rev-parse v1.1.0`.cwd(repos.fork).text();

			const result = await runSync(["--repo", repos.fork, "--upstream-url", repos.upstream, ...SYNC_FLAGS]);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("merged v1.1.0"); // upstream release integrated, not skipped/refused

			const ancestry = await $`git merge-base --is-ancestor refs/remotes/upstream-tag/v1.1.0 HEAD`
				.cwd(repos.fork)
				.nothrow();
			expect(ancestry.exitCode).toBe(0); // merged the upstream commit, not the fork tag's
			expect(await $`git rev-parse v1.1.0`.cwd(repos.fork).text()).toBe(forkTagBefore); // fork tag untouched
		} finally {
			await repos.cleanup();
		}
	}, 30000);

	test("an explicit --tag that only exists locally (fork-owned) is rejected", async () => {
		const repos = await createTempRepos();
		try {
			await gitIn(repos.fork, ["tag", "v3.0.0"]);
			const result = await runSync([
				"--repo",
				repos.fork,
				"--upstream-url",
				repos.upstream,
				"--tag",
				"v3.0.0",
				...SYNC_FLAGS,
			]);
			expect(result.exitCode).toBe(3);
			expect(result.output).toContain("does not exist on upstream");
		} finally {
			await repos.cleanup();
		}
	}, 30000);

	test("refuses to start on a dirty working tree and changes nothing", async () => {
		const repos = await createTempRepos();
		try {
			await advanceUpstream(repos.upstream, "upstream v1.1.0\n", "v1.1.0");
			const dirtyFile = path.join(repos.fork, "uncommitted.txt");
			await Bun.write(dirtyFile, "precious work\n");
			const before = await $`git rev-parse HEAD`.cwd(repos.fork).text();

			const result = await runSync(["--repo", repos.fork, "--upstream-url", repos.upstream, ...SYNC_FLAGS]);
			expect(result.exitCode).toBe(2);
			expect(result.output).toContain("dirty working tree");
			expect(await Bun.file(dirtyFile).text()).toBe("precious work\n"); // no auto-stash/discard
			expect(await $`git rev-parse HEAD`.cwd(repos.fork).text()).toBe(before); // HEAD untouched
		} finally {
			await repos.cleanup();
		}
	}, 30000);

	test("stops on merge conflict, reports the files, and leaves a recoverable merge state", async () => {
		const repos = await createTempRepos();
		try {
			await Bun.write(path.join(repos.fork, "app.txt"), "fork edit\n");
			await gitIn(repos.fork, ["add", "."]);
			await gitIn(repos.fork, ["commit", "-m", "feat(fork): touch app.txt"]);
			await advanceUpstream(repos.upstream, "upstream edit\n", "v1.2.0");

			const result = await runSync(["--repo", repos.fork, "--upstream-url", repos.upstream, ...SYNC_FLAGS]);
			expect(result.exitCode).toBe(4);
			expect(result.output).toContain("integration");
			expect(result.output).toContain("app.txt");
			expect(result.output).toContain("git merge --abort");

			const status = await $`git status --porcelain`.cwd(repos.fork).text();
			expect(status).toContain("UU app.txt"); // normal unresolved merge state

			await gitIn(repos.fork, ["merge", "--abort"]);
			const clean = await $`git status --porcelain`.cwd(repos.fork).text();
			expect(clean.trim()).toBe(""); // documented abort command restores the tree
		} finally {
			await repos.cleanup();
		}
	}, 30000);
});
