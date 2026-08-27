#!/usr/bin/env bun
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { resolveReleaseBinaryAsset } from "../packages/coding-agent/src/cli/release-metadata";

export const FORK_REPOSITORY = "th3akii/oh-my-pi";
export const WINDOWS_BINARY_NAME = "omp-windows-x64.exe";
const STABLE_VERSION_RE = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const FORK_VERSION_OUTPUT_RE =
	/^omp\/((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)) \(([^(),]+), ([0-9a-f]{7,40})\)$/i;

export interface ForkBuildIdentity {
	version: string;
	repository: string;
	commit: string;
}

export function normalizeStableVersion(value: string): string {
	const match = STABLE_VERSION_RE.exec(value.trim());
	if (!match) throw new Error(`Invalid stable semver "${value}"; expected X.Y.Z`);
	return match[1];
}

export function validateForkReleaseVersion(input: string, upstreamVersion: string): string {
	const version = normalizeStableVersion(input);
	const baseVersion = normalizeStableVersion(upstreamVersion);
	if (version !== baseVersion) {
		throw new Error(`Fork release ${version} must exactly match upstream base version ${baseVersion}`);
	}
	return version;
}

export function parseForkVersionOutput(output: string): ForkBuildIdentity {
	const match = FORK_VERSION_OUTPUT_RE.exec(output.trim());
	if (!match) throw new Error(`Unexpected fork binary version output: ${output.trim()}`);
	return { version: match[1], repository: match[2], commit: match[3] };
}

export function validateForkBinaryVersion(
	output: string,
	expectedVersion: string,
	expectedCommit: string,
): ForkBuildIdentity {
	const identity = parseForkVersionOutput(output);
	if (identity.version !== normalizeStableVersion(expectedVersion)) {
		throw new Error(`Binary version ${identity.version} does not match release ${expectedVersion}`);
	}
	if (identity.repository !== FORK_REPOSITORY) {
		throw new Error(`Binary distribution ${identity.repository} does not match ${FORK_REPOSITORY}`);
	}
	if (identity.commit !== expectedCommit) {
		throw new Error(`Binary commit ${identity.commit} does not match build commit ${expectedCommit}`);
	}
	return identity;
}

export function validatePublishedForkRelease(release: unknown, expectedVersion: string) {
	if (!isRecord(release) || !Array.isArray(release.assets) || release.assets.length !== 1) {
		throw new Error(`Fork release v${expectedVersion} must contain exactly one asset`);
	}
	return resolveReleaseBinaryAsset(release, `v${normalizeStableVersion(expectedVersion)}`, WINDOWS_BINARY_NAME, {
		repo: FORK_REPOSITORY,
	});
}

async function runCli(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === "validate-version") {
		const [input, upstreamVersion] = args;
		if (!input || !upstreamVersion)
			throw new Error("Usage: fork-release.ts validate-version <version> <upstream-version>");
		console.log(validateForkReleaseVersion(input, upstreamVersion));
		return;
	}
	if (command === "verify-release") {
		const [expectedVersion, releaseFile] = args;
		if (!expectedVersion || !releaseFile)
			throw new Error("Usage: fork-release.ts verify-release <version> <release-json>");
		const release: unknown = await Bun.file(releaseFile).json();
		const asset = validatePublishedForkRelease(release, expectedVersion);
		console.log(`verified ${WINDOWS_BINARY_NAME} ${asset.digest} ${asset.size} bytes`);
		return;
	}
	throw new Error("Usage: fork-release.ts <validate-version|verify-release> ...");
}

if (import.meta.main) {
	try {
		await runCli();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
