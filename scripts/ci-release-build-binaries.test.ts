import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";
import { conventionOutputPaths, resolveTargetLabels } from "./bazel-natives";

const repoRoot = path.join(import.meta.dir, "..");

describe("Windows release binary target", () => {
	it("builds the generic Windows release asset with the baseline runtime", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();

		expect(output).toContain("Building packages/coding-agent/binaries/omp-windows-x64.exe...");
		expect(output).toContain(
			"DRY RUN Bun.build target=bun-windows-x64-baseline outfile=packages/coding-agent/binaries/omp-windows-x64.exe",
		);
		expect(output).toContain("external=fastembed,onnxruntime-node");
		expect(output).not.toContain("bun-windows-x64-modern");
	});

	it("uses the baseline runtime for local Windows cross-build aliases", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
	});

	it("maps the Windows release target to the native artifact consumed by embedding", () => {
		const host = { platform: "linux", arch: "x64", avx2: true };
		expect(resolveTargetLabels(["win32-x64-baseline"], host)).toEqual(["//:natives-win32-x64-baseline"]);
		expect(conventionOutputPaths(["win32-x64-baseline"], host)).toEqual([
			"bazel-bin/natives-win32-x64-baseline/pi_natives.win32-x64-baseline.node",
		]);
	});
});
