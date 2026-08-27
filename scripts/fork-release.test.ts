import { describe, expect, it } from "bun:test";
import { compareVersions } from "../packages/utils/src/version";
import {
	FORK_REPOSITORY,
	normalizeStableVersion,
	parseForkVersionOutput,
	validateForkBinaryVersion,
	validateForkReleaseVersion,
	validatePublishedForkRelease,
	WINDOWS_BINARY_NAME,
} from "./fork-release";

describe("fork release version validation", () => {
	it("accepts stable semver and strips one leading v", () => {
		expect(normalizeStableVersion(" v18.0.9 ")).toBe("18.0.9");
	});

	it("rejects prerelease and malformed versions", () => {
		expect(() => normalizeStableVersion("18.0.9-fork.1")).toThrow("Invalid stable semver");
		expect(() => normalizeStableVersion("18.00.9")).toThrow("Invalid stable semver");
	});

	it("requires the fork release to preserve the integrated upstream version", () => {
		expect(validateForkReleaseVersion("v18.0.8", "18.0.8")).toBe("18.0.8");
		expect(() => validateForkReleaseVersion("18.0.9", "18.0.8")).toThrow("must exactly match upstream base version");
	});
});

describe("fork binary identity", () => {
	it("parses the fork identity while retaining an independently comparable version", () => {
		const output = "omp/18.0.8 (th3akii/oh-my-pi, abc1234)";
		const identity = parseForkVersionOutput(output);
		expect(identity.repository).toBe(FORK_REPOSITORY);
		expect(compareVersions(identity.version, "18.0.8")).toBe(0);
		expect(compareVersions(identity.version, "18.0.9")).toBe(-1);
	});

	it("requires the expected version, distribution, and source commit", () => {
		expect(validateForkBinaryVersion("omp/18.0.8 (th3akii/oh-my-pi, abc1234)", "18.0.8", "abc1234")).toEqual({
			version: "18.0.8",
			repository: FORK_REPOSITORY,
			commit: "abc1234",
		});
		expect(() => validateForkBinaryVersion("omp/18.0.8 (th3akii/oh-my-pi, abc1234)", "18.0.9", "abc1234")).toThrow(
			"does not match release",
		);
	});
});

describe("published fork release metadata", () => {
	it("accepts exactly one updater-compatible Windows asset and its SHA-256 digest", () => {
		const release = {
			tag_name: "v18.0.8",
			draft: false,
			prerelease: false,
			assets: [
				{
					name: WINDOWS_BINARY_NAME,
					state: "uploaded",
					size: 123,
					digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
					browser_download_url: `https://github.com/${FORK_REPOSITORY}/releases/download/v18.0.8/${WINDOWS_BINARY_NAME}`,
				},
			],
		};
		expect(validatePublishedForkRelease(release, "18.0.8")).toMatchObject({
			size: 123,
			digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		});
	});

	it("rejects a release missing GitHub's strict digest metadata", () => {
		const release = {
			tag_name: "v18.0.8",
			draft: false,
			prerelease: false,
			assets: [
				{
					name: WINDOWS_BINARY_NAME,
					state: "uploaded",
					size: 123,
					browser_download_url: `https://github.com/${FORK_REPOSITORY}/releases/download/v18.0.8/${WINDOWS_BINARY_NAME}`,
				},
			],
		};
		expect(() => validatePublishedForkRelease(release, "18.0.8")).toThrow("has no digest");
	});
});
