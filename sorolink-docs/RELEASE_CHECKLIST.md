# SoroLink Release Checklist

This document provides a checklist for releasing the three application packages in the SoroLink monorepo: **sorolink-backend**, **sorolink-frontend**, and **sorolink-cli**.

## Pre-release verification

Before releasing any package, verify that all automated checks pass locally:

```bash
npm run check
```

This runs deterministic checks for all three packages (typecheck, test, and build).

---

## Backend package (`sorolink-backend`)

**Package name**: `@sorolink/backend`  
**Published to**: npm registry  
**Directory**: `sorolink-backend/`

### Release steps

- [ ] Verify version in `sorolink-backend/package.json`
- [ ] Update `CHANGELOG.md` with backend changes since last release
- [ ] Run backend checks: `cd sorolink-backend && npm run check`
- [ ] Verify database migrations are current and reversible
- [ ] Test scenario schema validation: `cd sorolink-backend && npm test -- scenarios`
- [ ] Confirm API response schema is backward compatible (no breaking changes)
- [ ] Review exported types and public APIs for breaking changes
- [ ] Tag release with `backend-vX.Y.Z` format (e.g., `backend-v0.2.0`)
- [ ] Publish to npm: `cd sorolink-backend && npm publish`
- [ ] Verify published package on npm registry

### Rollback steps

If a backend release breaks production:

- [ ] Check npm registry for retract or deprecate options
- [ ] Notify downstream consumers (CLI, frontend) of the issue
- [ ] Prepare a patch release with the fix
- [ ] Publish the patch release

---

## Frontend package (`sorolink-frontend`)

**Package name**: `@sorolink/frontend` (or not published; check configuration)  
**Deployed to**: Vercel  
**Directory**: `sorolink-frontend/`

### Release steps

- [ ] Verify version in `sorolink-frontend/package.json`
- [ ] Update `CHANGELOG.md` with frontend changes since last release
- [ ] Run frontend checks: `cd sorolink-frontend && npm run check`
- [ ] Run end-to-end tests: `cd sorolink-frontend && npm run test:e2e:prod`
- [ ] Verify all scenarios load and run successfully in the dashboard
- [ ] Test copy-to-clipboard features work in target browsers
- [ ] Verify responsive design on mobile/tablet in major browsers
- [ ] Review accessibility: keyboard navigation, screen reader support
- [ ] Check that the backend URL is correctly configured for the deployment target
- [ ] Tag release with `frontend-vX.Y.Z` format (e.g., `frontend-v0.2.0`)
- [ ] If published to npm, publish the package: `cd sorolink-frontend && npm publish`
- [ ] Deploy to Vercel (can be automated via GitHub integration)
- [ ] Verify deployment succeeded and frontend is accessible at the public URL
- [ ] Smoke test the deployed dashboard against the live backend

### Rollback steps

If a frontend release breaks the live dashboard:

- [ ] Redeploy the previous known-good commit from Vercel dashboard
- [ ] Verify dashboard is restored and responsive
- [ ] Prepare a patch release with the fix
- [ ] Redeploy the patched version

---

## CLI package (`sorolink-cli`)

**Package name**: `@sorolink/cli`  
**Published to**: npm registry (currently `npm run dev` from source; not yet on npm)  
**Directory**: `sorolink-cli/`

### Release steps

- [ ] Verify version in `sorolink-cli/package.json`
- [ ] Update `CHANGELOG.md` with CLI changes since last release
- [ ] Run CLI checks: `cd sorolink-cli && npm run check`
- [ ] Run CLI tests: `cd sorolink-cli && npm run test`
- [ ] Test CLI commands manually:
  - [ ] `node dist/cli.js list` displays all scenarios
  - [ ] `node dist/cli.js list --output json` produces valid JSON
  - [ ] `node dist/cli.js validate ./sorolink-backend/scenarios/xlm-payment.yaml` succeeds
  - [ ] `node dist/cli.js run xlm-payment --output json` (uses live Testnet; confirm network access)
  - [ ] Exit codes are correct (0 for success, 1 for failure)
- [ ] Verify help text is clear: `node dist/cli.js --help`
- [ ] Test on Windows (Git Bash or PowerShell) if possible
- [ ] Check that CLI correctly rejects Mainnet configuration
- [ ] Tag release with `cli-vX.Y.Z` format (e.g., `cli-v0.2.0`)
- [ ] Publish to npm: `cd sorolink-cli && npm publish`
- [ ] Verify published package on npm registry
- [ ] Test installation from npm: `npm install -g @sorolink/cli`

### Rollback steps

If a CLI release has issues:

- [ ] Deprecate the broken version on npm
- [ ] Prepare a patch release with the fix
- [ ] Publish the patch release
- [ ] Notify users to upgrade

---

## Coordinated releases

When multiple packages are released together:

1. Release backend first (it has fewer dependencies)
2. Update frontend and CLI to depend on the new backend version
3. Release frontend and CLI in parallel (they have no interdependencies)
4. Update root `CHANGELOG.md` with all coordinated changes
5. Create a monorepo release tag: `release-vX.Y.Z` (for major updates)

---

## Post-release

- [ ] Close related GitHub issues or milestones
- [ ] Announce the release in project documentation or release notes
- [ ] Update version badges in README if using them
- [ ] Verify that dependency updates propagate correctly across packages
- [ ] Archive old Vercel deployments if using preview URLs

---

## Notes

- All checks must pass before release. Deterministic checks run with `npm run check` at the repository root.
- Backend migrations must always be reversible and tested.
- Frontend must be tested end-to-end on Testnet before deployment.
- CLI must work offline (no network calls) for help, list (from bundled scenarios), and validate commands.
- Versions follow semantic versioning (MAJOR.MINOR.PATCH).
- Tags use package-prefixed format for clarity: `backend-vX.Y.Z`, `frontend-vX.Y.Z`, `cli-vX.Y.Z`.
