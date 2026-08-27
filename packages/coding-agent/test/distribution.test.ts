import { describe, expect, it } from "bun:test";
import { compareVersions } from "@oh-my-pi/pi-utils";
import { parseReportedVersion } from "../src/cli/update-cli";
import {
	DISTRIBUTION,
	formatVersionOutput,
	OFFICIAL_DISTRIBUTION,
	setDistributionForTest,
} from "../src/config/distribution";

describe("distribution version identity", () => {
	it("keeps official builds on the existing omp/version output", () => {
		expect(formatVersionOutput("18.0.8", OFFICIAL_DISTRIBUTION, "abc1234")).toBe("omp/18.0.8");
	});

	it("reports the fork repository and immutable source commit", () => {
		expect(formatVersionOutput("18.0.8", DISTRIBUTION, "abc1234")).toBe("omp/18.0.8 (th3akii/oh-my-pi, abc1234)");
	});

	it("keeps updater version parsing independent from fork identity", () => {
		const output = formatVersionOutput("18.0.8", DISTRIBUTION, "abc1234");
		const version = parseReportedVersion(output);
		expect(version).toBe("18.0.8");
		expect(compareVersions(version ?? "", "18.0.9")).toBe(-1);
	});

	it("allows tests to route identity formatting through the official distribution", () => {
		setDistributionForTest(OFFICIAL_DISTRIBUTION);
		try {
			expect(formatVersionOutput("18.0.8", undefined, "abc1234")).toBe("omp/18.0.8");
		} finally {
			setDistributionForTest(undefined);
		}
	});
});
