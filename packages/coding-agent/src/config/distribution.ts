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
};

/** The distribution this build belongs to. */
export const DISTRIBUTION: DistributionSource = FORK_DISTRIBUTION ?? OFFICIAL_DISTRIBUTION;

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
