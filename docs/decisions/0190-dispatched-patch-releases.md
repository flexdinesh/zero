# 0190: Dispatched patch releases

- Status: Accepted
- Date: 2026-11-23
- Revises: [0079](0079-releases-edge-prerelease-and-install-scripts.md)
  (stable releases start only from a pushed tag; `tools/release-version`
  only suggests)

## Context

0079 made pushing a `vX.Y.Z` tag the only way to publish a stable release.
Releasing then means running `tools/release-version` locally, tagging
`origin/main`, and pushing the tag. The operator wants to release from the
GitHub web UI, with the major and minor controlled in the repository and
every release the next patch.

## Decision

- `release.yml` also runs on `workflow_dispatch`, on `main` only. Its `check`
  job runs `tools/release-version` on the dispatched `main` commit: the next
  patch of `.release-version`'s `major.minor` series, or the series tag
  already on that commit. Changing `.release-version` (for example to `0.3`
  or `1.0`) starts a new series at patch 0.
- A dispatched tag does not exist until `publish`: `gh release create
  --target <commit>` creates it only after every asset built, so a failed
  build leaves no tag and a re-run selects the same version.
- A dispatch on a commit that is already released publishes nothing (`check`
  skips an existing release).
- Pushing a `vX.Y.Z` tag on a `main` commit still releases that tag, for
  versions outside the series rule.
- The tag `publish` creates with `GITHUB_TOKEN` starts no second run.

## Consequences

- Releasing needs no local checkout: Actions, Release, Run workflow on
  `main`.
- `publish` no longer passes `--verify-tag`; a pushed tag already exists, so
  `--target` is ignored for it.
