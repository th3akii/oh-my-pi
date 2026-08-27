import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { OFFICIAL_DISTRIBUTION } from "../config/distribution";

export interface ReleaseBinaryAsset {
	url: string;
	size: number;
	digest: string;
}

/**
 * Select and validate the binary asset from GitHub release metadata.
 *
 * Draft releases are always rejected. Prereleases are rejected unless
 * `options.allowPrerelease` is set, which the canary channel passes: canary
 * GitHub releases are published as prereleases, and the exact-tag match below
 * still pins the download to the specific requested version.
 *
 * `options.repo` names the repository the asset download URL must match. It
 * defaults to the official repository; updater callers pass the active
 * distribution's repository.
 */
export function resolveReleaseBinaryAsset(
	release: unknown,
	expectedTag: string,
	binaryName: string,
	options: { allowPrerelease?: boolean; repo?: string } = {},
): ReleaseBinaryAsset {
	if (!isRecord(release)) {
		throw new Error("Invalid GitHub release metadata");
	}
	if (release.tag_name !== expectedTag) {
		throw new Error(`GitHub release tag mismatch: expected ${expectedTag}`);
	}
	if (release.draft !== false) {
		throw new Error(`GitHub release ${expectedTag} is a draft, not a published release`);
	}
	if (release.prerelease !== false && !options.allowPrerelease) {
		throw new Error(`GitHub release ${expectedTag} is a prerelease; only canary updates install prerelease assets`);
	}
	if (!Array.isArray(release.assets)) {
		throw new Error(`GitHub release ${expectedTag} has no asset list`);
	}

	const matches = release.assets.filter(asset => isRecord(asset) && asset.name === binaryName);
	if (matches.length !== 1) {
		throw new Error(`GitHub release ${expectedTag} has ${matches.length} assets named ${binaryName}`);
	}

	const asset = matches[0];
	if (!isRecord(asset) || asset.state !== "uploaded") {
		throw new Error(`GitHub release asset ${binaryName} is not fully uploaded`);
	}
	if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
		throw new Error(`GitHub release asset ${binaryName} has an invalid size`);
	}
	if (typeof asset.digest !== "string") {
		throw new Error(`GitHub release asset ${binaryName} has no digest`);
	}
	const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1];
	if (!digest) {
		throw new Error(`GitHub release asset ${binaryName} has an unsupported digest`);
	}

	const expectedUrl = `https://github.com/${options.repo ?? OFFICIAL_DISTRIBUTION.repo}/releases/download/${expectedTag}/${binaryName}`;
	if (asset.browser_download_url !== expectedUrl) {
		throw new Error(`GitHub release asset ${binaryName} has an unexpected download URL`);
	}

	return {
		url: expectedUrl,
		size: asset.size,
		digest: `sha256:${digest.toLowerCase()}`,
	};
}
