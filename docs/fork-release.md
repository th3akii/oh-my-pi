# Windows fork distribution

`th3akii/oh-my-pi` keeps `main` as the only maintained fork branch. The fork
has two separate GitHub Actions paths:

- `fork-sync.yml` checks the official `can1357/oh-my-pi` tags three times daily
  (`00:17`, `08:17`, and `16:17` UTC) and supports `workflow_dispatch`.
- `fork-release.yml` is manual-only. It always checks out `th3akii/main`, builds
  one Windows x64 executable, verifies it, and publishes one stable GitHub
  Release asset.

## Upstream sync lifecycle

The sync workflow has `contents: write` and `pull-requests: write`. It configures
an `upstream` remote to `https://github.com/can1357/oh-my-pi.git`, then runs
`bun run fork:sync --dry-run` on `main`. Phase 5 remains the source of truth for
stable-tag selection, tag identity, merge behavior, and verification.

If the latest official stable tag is already an ancestor of `main`, the run
ends successfully without creating a branch or PR. Otherwise it resets
`fork-sync/vX.Y.Z` from current `origin/main`, runs:

```sh
bun run fork:sync --branch fork-sync/vX.Y.Z
```

Only a fully verified branch is pushed. The workflow opens or updates the one
open PR for that branch, targeting `main`; it never merges the PR. A failed
Phase 5 run happens before the push step, so the remote `main` and remote sync
branch remain unchanged. The workflow is schedule/dispatch-only, avoiding
push/PR feedback loops.

## Windows release path

After a human merges the sync PR, run **Fork Windows release** manually and
enter the exact stable version already present on canonical `main` (an
optional leading `v` is accepted). The workflow:

1. verifies the checkout is exactly `origin/main`;
2. reads the canonical OMP version from `packages/utils/package.json`;
3. requires the input version to match that version and rejects an existing
   fork Release or fork tag;
4. verifies the corresponding official upstream tag is integrated;
5. sets `RELEASE_TARGETS=win32-x64` and runs the existing
   `bun run ci:release:build-binaries` machinery;
6. runs the resulting executable with `--version`;
7. creates a published, non-draft, non-prerelease Release containing exactly
   `omp-windows-x64.exe`;
8. reads the published GitHub API object and reuses the Phase 4 strict asset
   validator, including the API-provided `sha256:<64 hex>` digest.

The existing project build path is `scripts/ci-release-build-binaries.ts` →
`packages/coding-agent/scripts/compile-binary.ts`; it already defines the
`bun-windows-x64-baseline` target and the required output name. The new workflow
runs this same command on `windows-2025` so the produced `.exe` is executed
before publication. The existing upstream CI still cross-builds its Windows
asset on Ubuntu; that path is unchanged.

## Build identity and versioning

A fork release reports:

```text
omp/18.0.8 (th3akii/oh-my-pi, abc1234)
```

`18.0.8` is the exact upstream semantic version used by the fork. It is not a
fork allocation. `th3akii/oh-my-pi` is the immutable distribution label and
`abc1234` is the seven-character source commit SHA. The compiler replaces the
build-only `PI_BUILD_VERSION` and `PI_BUILD_COMMIT` expressions with literals;
ordinary user configuration and environment do not supply the published
binary's identity. Official/default builds retain the existing `omp/18.0.8`
output.

The release workflow reads the canonical application version from
`packages/utils/package.json`, which is the package manifest used by
`packages/utils/src/dirs.ts` for `VERSION`. The requested workflow version must
match that value exactly. The corresponding official upstream `vX.Y.Z` tag must
exist and be an ancestor of `main`. Fork commits may be added on top of that
release, but they never change the semantic version.

Examples:

```text
upstream release:                  v18.0.8
fork main:                         upstream v18.0.8 + fork commit abc1234
fork release/tag/binary version:   v18.0.8 / 18.0.8
binary identity:                   omp/18.0.8 (th3akii/oh-my-pi, abc1234)
next upstream release:             v18.0.9 -> sync, then publish v18.0.9
fork-only semantic version:        not supported
```

There is at most one published fork Release for each upstream semantic version.
A later fork-only commit on the same upstream base keeps the same version and
must not overwrite the existing tag or Release; the workflow rejects that
collision. SemVer build metadata (`+fork.1`) is not used because it does not
increase precedence. This keeps updater comparison aligned with upstream and
lets the commit identity distinguish the exact published build.

## First-time Windows bootstrap

The bootstrap script downloads `omp-windows-x64.exe` from the latest published
fork Release, validates the release shape and GitHub SHA-256 digest, validates
`--version` contains the fork identity, and then swaps the executable with a
rollback copy:

```powershell
irm https://raw.githubusercontent.com/th3akii/oh-my-pi/main/scripts/bootstrap-fork.ps1 | iex
```

By default it replaces the `omp.exe` found on `PATH`. To make the target
explicit:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/th3akii/oh-my-pi/main/scripts/bootstrap-fork.ps1))) `
  -TargetPath "$env:LOCALAPPDATA\omp\omp.exe"
```

The script prints the exact executable path before replacement. It does not
create, delete, migrate, or rewrite `~/.omp`; it does not touch a project-local
`.omp` directory. If download, digest, identity, replacement, or post-swap
verification fails, the previous executable is restored. A successful swap
removes the rollback copy.

## Actions configuration

The workflows use only the repository-provided `GITHUB_TOKEN`; no extra secret
is required. The repository must allow Actions and the default workflow token
must permit the job-level permissions above (Settings → Actions → General →
Workflow permissions → **Read and write permissions**). The token also needs
pull-request write permission for the sync workflow to create/update its PR.
`main` branch protection should continue to require human review; no workflow
needs bypass permission. The release workflow additionally requires an
available `windows-2025` GitHub-hosted runner and is deliberately not triggered
by sync PRs or ordinary pushes.
