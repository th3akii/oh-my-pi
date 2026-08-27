import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";

/**
 * Build-only compile define. Published binaries replace this expression with a
 * literal; source launches without a commit remain unbranded.
 */
const COMPILED_BUILD_COMMIT = process.env.PI_BUILD_COMMIT?.trim() || undefined;

/**
 * Distribution / release-source configuration.
 *
 * Single centralized point that decides where release metadata and binary
 * assets come from. The official upstream default is npm-registry release
 * discovery plus binary releases from `can1357/oh-my-pi`; no other updater
 * code names a repository — everything reads {@link getDistribution}.
 *
 * A fork build selects an alternate release source by setting
 * {@link FORK_DISTRIBUTION} below and committing that one-line change. With
 * the fork entry absent (upstream source) official OMP behavior is unchanged.
 *
 * This fork (`th3akii/oh-my-pi`) uses GitHub Releases for both latest-version
 * discovery and Windows binary assets; no fork npm package is required.
 */
export type ReleaseDiscovery = "npm" | "github-releases";

export interface DistributionSource {
	discovery: ReleaseDiscovery;
	/** GitHub `owner/repo` that owns the binary release assets. */
	repo: string;
	/** Immutable distribution label embedded in fork release binaries. */
	identity?: string;
}

/** Official upstream distribution. */
export const OFFICIAL_DISTRIBUTION: DistributionSource = {
	discovery: "npm",
	repo: "can1357/oh-my-pi",
};

/**
 * Fork distribution override. Defined in the fork build; set to `undefined`
 * to restore the official upstream distribution.
 */
const FORK_DISTRIBUTION: DistributionSource | undefined = {
	discovery: "github-releases",
	repo: "th3akii/oh-my-pi",
	identity: "th3akii/oh-my-pi",
};

/** The distribution this build belongs to. */
export const DISTRIBUTION: DistributionSource = FORK_DISTRIBUTION ?? OFFICIAL_DISTRIBUTION;

/** Render the stable semantic version plus an immutable fork build identity. */
export function formatVersionOutput(
	version: string,
	source: DistributionSource = getDistribution(),
	buildCommit: string | undefined = COMPILED_BUILD_COMMIT,
): string {
	if (!source.identity || !buildCommit) return `${APP_NAME}/${version}`;
	return `${APP_NAME}/${version} (${source.identity}, ${buildCommit})`;
}

let distributionOverride: DistributionSource | undefined;

/**
 * Test seam: temporarily route the updater through a non-default
 * distribution. Pass `undefined` to restore the build's configuration.
 */
export function setDistributionForTest(source: DistributionSource | undefined): void {
	distributionOverride = source;
}

/** Active distribution: the build configuration, or a test override. */
export function getDistribution(): DistributionSource {
	return distributionOverride ?? DISTRIBUTION;
}
