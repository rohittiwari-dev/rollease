# Rollease Alpha Release Plan

This package is prepared for npm alpha releases through GitHub Actions.

## Current Alpha

- Package: `rollease`
- Starting version: `2.0.0-alpha.0`
- npm dist-tag: `alpha`
- Install command for consumers: `npm install rollease@alpha`

## One-Time Setup

1. Create the npm package if it does not exist.
2. Configure npm publishing in one of two ways:
   - Preferred: npm trusted publishing for this repository and the workflow `.github/workflows/publish.yml`.
   - Fallback: create an npm automation token and add it as the GitHub secret `NPM_TOKEN`.
3. Protect `main` and require the `Rollease package CI` workflow before merging.

## Alpha Release Checklist

1. Merge the release candidate into `main`.
2. Confirm CI passes for `packages/rollease`.
3. Open GitHub Actions, run `Publish rollease to npm`, and use:
   - `version`: `2.0.0-alpha.0` for the first alpha, then increment to `2.0.0-alpha.1`, `2.0.0-alpha.2`, etc.
   - `dist_tag`: `alpha`
   - `dry_run`: `true`
4. Review the dry-run package contents.
5. Re-run the same workflow with `dry_run: false`.
6. Verify the release:
   - `npm view rollease@alpha version`
   - `npm install rollease@alpha`
   - Smoke test imports from `rollease`, `rollease/react`, `rollease/next`, and adapter subpaths.

## Tag-Based Release Option

The publish workflow also accepts tags named `rollease-v<version>`.

```bash
git tag rollease-v2.0.0-alpha.0
git push origin rollease-v2.0.0-alpha.0
```

Tag releases are not dry runs. Use the manual workflow for the first alpha.

## Promotion Path

- Alpha: `2.0.0-alpha.x`, publish with `--tag alpha`
- Beta: `2.0.0-beta.x`, publish with `--tag beta`
- Release candidate: `2.0.0-rc.x`, publish with `--tag rc`
- Stable: `2.0.0`, publish with `--tag latest`

Do not publish prerelease versions with the `latest` dist-tag.
