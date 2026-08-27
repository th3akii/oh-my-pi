import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	forkUnsupportedMethodMessage,
	getLatestRelease,
	resolveReleaseBinaryAsset,
	runUpdateCommand,
	updateViaBinaryAt,
} from "../../src/cli/update-cli";
import {
	DISTRIBUTION,
	getDistribution,
	OFFICIAL_DISTRIBUTION,
	setDistributionForTest,
} from "../../src/config/distribution";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	beforeEach(() => {
		// These tests exercise the official npm updater path; the fork build's
		// committed distribution must not reroute them.
		setDistributionForTest(OFFICIAL_DISTRIBUTION);
	});
	afterEach(() => {
		setDistributionForTest(undefined);
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ version: "999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("getLatestRelease rename pointers", () => {
	beforeEach(() => {
		setDistributionForTest(OFFICIAL_DISTRIBUTION);
	});
	afterEach(() => {
		setDistributionForTest(undefined);
		vi.restoreAllMocks();
	});

	function stubRegistry(manifests: Record<string, unknown>): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = String(input);
				urls.push(url);
				let manifest: unknown;
				for (const pkg in manifests) {
					if (url.includes(pkg)) {
						manifest = manifests[pkg];
						break;
					}
				}
				if (!manifest) return new Response(null, { status: 404, statusText: "Not Found" });
				return Response.json(manifest);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("follows omp.rename to the new package and resolves version, dist, and names from its manifest", async () => {
		const urls = stubRegistry({
			"@new/omp": { version: "999.1.0", omp: { dist: "npm" } },
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { dist: "binary", rename: { package: "@new/omp", natives: "@new/natives" } },
			},
		});

		const release = await getLatestRelease();

		expect(release.version).toBe("999.1.0");
		expect(release.dist).toBe("npm");
		expect(release.packages).toEqual({ pkg: "@new/omp", natives: "@new/natives" });
		expect(urls).toEqual([
			"https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest",
			"https://registry.npmjs.org/@new/omp/latest",
		]);
	});
	it("fetches the canary dist-tag when checking the canary channel", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": { version: "999.0.0-canary.1" },
		});

		await getLatestRelease({ channel: "canary" });

		expect(urls).toEqual(["https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/canary"]);
	});

	it("ignores a rename pointer that cycles back to an already-visited package", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { rename: { package: "@oh-my-pi/pi-coding-agent" } },
			},
		});

		const release = await getLatestRelease();

		expect(urls).toHaveLength(1);
		expect(release.version).toBe("999.0.0");
		expect(release.packages).toEqual({ pkg: "@oh-my-pi/pi-coding-agent", natives: "@oh-my-pi/pi-natives" });
	});
});

describe("getLatestRelease proxy errors", () => {
	beforeEach(() => {
		setDistributionForTest(OFFICIAL_DISTRIBUTION);
	});
	afterEach(() => {
		setDistributionForTest(undefined);
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest". ' +
						"For more information, pass `verbose: true` in the second argument to fetch()",
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const err = await getLatestRelease({ timeoutMs: 5000 }).then(
			() => null,
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(Error);
		// The raw fetch() instruction the CLI user cannot act on must not leak through.
		expect(err?.message).not.toContain("verbose: true");
		expect(err?.message).not.toContain("fetch()");
		// Instead the user gets actionable guidance about supported proxy schemes.
		expect(err?.message).toMatch(/SOCKS/i);
		expect(err?.message).toMatch(/https?:\/\//i);
	});
});

const FORK_SOURCE = { discovery: "github-releases" as const, repo: "th3akii/oh-my-pi" };
const FORK_RELEASES_URL = `https://api.github.com/repos/${FORK_SOURCE.repo}/releases/latest`;
const OFFICIAL_ASSET_URL = "https://github.com/can1357/oh-my-pi/releases/download/v1.2.3/omp-windows-x64.exe";

function stubForkResponses(responses: Record<string, unknown>): string[] {
	const urls: string[] = [];
	const fetchStub = Object.assign(
		async (input: FetchInput) => {
			const url = String(input);
			urls.push(url);
			const match = Object.keys(responses).find(key => url === key);
			if (!match) return new Response(null, { status: 404, statusText: "Not Found" });
			const value = responses[match];
			return value instanceof Response ? value : Response.json(value);
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
	return urls;
}

describe("distribution source", () => {
	afterEach(() => {
		setDistributionForTest(undefined);
		vi.restoreAllMocks();
	});

	it("exposes the official npm + can1357/oh-my-pi distribution as the built-in default", () => {
		expect(OFFICIAL_DISTRIBUTION).toEqual({ discovery: "npm", repo: "can1357/oh-my-pi" });
	});

	it("serves the build's distribution configuration when no test override is set", () => {
		expect(getDistribution()).toBe(DISTRIBUTION);
	});
});

describe("fork distribution release discovery", () => {
	beforeEach(() => {
		setDistributionForTest(FORK_SOURCE);
	});
	afterEach(() => {
		setDistributionForTest(undefined);
		vi.restoreAllMocks();
	});

	it("discovers the latest stable release from the fork's GitHub releases, never the npm registry", async () => {
		const urls = stubForkResponses({
			[FORK_RELEASES_URL]: { tag_name: "v999.1.0", draft: false, prerelease: false },
		});

		const release = await getLatestRelease();

		expect(release).toEqual({
			tag: "v999.1.0",
			version: "999.1.0",
			dist: "binary",
			packages: { pkg: "@oh-my-pi/pi-coding-agent", natives: "@oh-my-pi/pi-natives" },
		});
		expect(urls).toEqual([FORK_RELEASES_URL]);
	});

	it("keeps using the fork's stable release line regardless of channel", async () => {
		const urls = stubForkResponses({
			[FORK_RELEASES_URL]: { tag_name: "v999.1.0", draft: false, prerelease: false },
		});

		const release = await getLatestRelease({ channel: "canary" });

		expect(release.version).toBe("999.1.0");
		expect(urls).toEqual([FORK_RELEASES_URL]);
	});

	it("rejects malformed, draft, and prerelease fork release metadata instead of updating", async () => {
		stubForkResponses({
			[FORK_RELEASES_URL]: { tag_name: "v999.1.0", draft: true, prerelease: false },
		});
		await expect(getLatestRelease()).rejects.toThrow("not a published stable release");

		stubForkResponses({
			[FORK_RELEASES_URL]: { tag_name: "v999.1.0", draft: false, prerelease: true },
		});
		await expect(getLatestRelease()).rejects.toThrow("not a published stable release");

		stubForkResponses({
			[FORK_RELEASES_URL]: { tag_name: "999.1.0", draft: false, prerelease: false },
		});
		await expect(getLatestRelease()).rejects.toThrow("Malformed GitHub release tag");

		stubForkResponses({ [FORK_RELEASES_URL]: "not-an-object" });
		await expect(getLatestRelease()).rejects.toThrow("Malformed GitHub release metadata");
	});

	it("fails safely when the fork has no reachable release", async () => {
		stubForkResponses({});
		await expect(getLatestRelease()).rejects.toThrow(`Failed to fetch ${FORK_SOURCE.repo} release info: Not Found`);
	});
});

describe("fork distribution update command", () => {
	beforeEach(() => {
		setDistributionForTest(FORK_SOURCE);
	});
	afterEach(() => {
		setDistributionForTest(undefined);
		vi.restoreAllMocks();
	});

	it("`omp update --check` reports the fork release and never queries official sources", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.join(" ")));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const urls = stubForkResponses({
			[FORK_RELEASES_URL]: { tag_name: "v999.1.0", draft: false, prerelease: false },
		});

		await runUpdateCommand({ force: false, check: true });

		expect(logs.some(line => line.includes("New version available: 999.1.0"))).toBe(true);
		expect(urls).toEqual([FORK_RELEASES_URL]);
	});

	it("does not report an update when the fork has no newer release, even though upstream does", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.join(" ")));
		vi.spyOn(console, "error").mockImplementation(() => {});
		// The only queried source is the fork: an npm-registry (upstream) release
		// newer than the running build is never seen by a fork build.
		const urls = stubForkResponses({
			[FORK_RELEASES_URL]: { tag_name: "v0.0.1", draft: false, prerelease: false },
			"https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest": { version: "999.0.0" },
		});

		await runUpdateCommand({ force: false, check: true });

		expect(logs.some(line => line.includes("Already up to date"))).toBe(true);
		expect(logs.some(line => line.includes("New version available"))).toBe(false);
		expect(urls).toEqual([FORK_RELEASES_URL]);
	});

	it("blocks package-manager and Nix routes that would install the official build", () => {
		expect(forkUnsupportedMethodMessage("brew")).toMatch(/official build/);
		expect(forkUnsupportedMethodMessage("mise")).toMatch(/official build/);
		expect(forkUnsupportedMethodMessage("nix")).toMatch(/official build/);
		expect(forkUnsupportedMethodMessage("bun")).toBeUndefined();
		expect(forkUnsupportedMethodMessage("npm")).toBeUndefined();
		expect(forkUnsupportedMethodMessage("binary")).toBeUndefined();
	});
});

describe("fork distribution binary install", () => {
	beforeEach(() => {
		setDistributionForTest(FORK_SOURCE);
	});
	afterEach(() => {
		setDistributionForTest(undefined);
		vi.restoreAllMocks();
	});

	function hostBinaryName(): string {
		if (process.platform === "win32") return "omp-windows-x64.exe";
		if (process.platform === "darwin") return "omp-darwin-x64";
		return "omp-linux-x64";
	}

	it("downloads and verifies the binary from the configured fork repository", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const binaryName = hostBinaryName();
		const tag = "v999.1.0";
		const content = "fork-binary-payload";
		const digest = createHash("sha256").update(content).digest("hex");
		const downloadUrl = `https://github.com/${FORK_SOURCE.repo}/releases/download/${tag}/${binaryName}`;
		const urls = stubForkResponses({
			[`https://api.github.com/repos/${FORK_SOURCE.repo}/releases/tags/${tag}`]: {
				tag_name: tag,
				draft: false,
				prerelease: false,
				assets: [
					{
						name: binaryName,
						state: "uploaded",
						size: Buffer.byteLength(content),
						digest: `sha256:${digest}`,
						browser_download_url: downloadUrl,
					},
				],
			},
			[downloadUrl]: new Response(content),
		});
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-update-"));
		const targetPath = path.join(dir, "omp");

		await updateViaBinaryAt(targetPath, "999.1.0", {
			fetchImpl: globalThis.fetch,
			verifyInstalledVersion: async () => ({ ok: true }),
		});

		expect(urls).toContain(`https://api.github.com/repos/${FORK_SOURCE.repo}/releases/tags/${tag}`);
		expect(urls).toContain(downloadUrl);
		expect(await Bun.file(targetPath).text()).toBe(content);
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("never installs an asset hosted by the official repository", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const binaryName = hostBinaryName();
		const tag = "v999.1.0";
		stubForkResponses({
			[`https://api.github.com/repos/${FORK_SOURCE.repo}/releases/tags/${tag}`]: {
				tag_name: tag,
				draft: false,
				prerelease: false,
				assets: [
					{
						name: binaryName,
						state: "uploaded",
						size: 10,
						digest: `sha256:${"a".repeat(64)}`,
						browser_download_url: OFFICIAL_ASSET_URL,
					},
				],
			},
		});
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-update-"));
		const targetPath = path.join(dir, "omp");

		await expect(
			updateViaBinaryAt(targetPath, "999.1.0", {
				verifyInstalledVersion: async () => ({ ok: true }),
			}),
		).rejects.toThrow("unexpected download URL");
		expect(await Bun.file(targetPath).exists()).toBe(false);
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("keeps asset URL validation strict against the configured fork repository", () => {
		const release = (browser_download_url: string) => ({
			tag_name: "v1.2.3",
			draft: false,
			prerelease: false,
			assets: [
				{
					name: "omp-windows-x64.exe",
					state: "uploaded",
					size: 10,
					digest: `sha256:${"b".repeat(64)}`,
					browser_download_url,
				},
			],
		});
		const forkUrl = `https://github.com/${FORK_SOURCE.repo}/releases/download/v1.2.3/omp-windows-x64.exe`;
		const forkOptions = { repo: FORK_SOURCE.repo };
		expect(() =>
			resolveReleaseBinaryAsset(release(OFFICIAL_ASSET_URL), "v1.2.3", "omp-windows-x64.exe", forkOptions),
		).toThrow("unexpected download URL");
		expect(resolveReleaseBinaryAsset(release(forkUrl), "v1.2.3", "omp-windows-x64.exe", forkOptions)).toEqual({
			url: forkUrl,
			size: 10,
			digest: `sha256:${"b".repeat(64)}`,
		});
	});
});
