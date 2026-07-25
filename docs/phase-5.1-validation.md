# Phase 5.1 Development Standardization

## Added

- `package.json` with a single `npm run validate` entry point.
- Manifest validation script.
- Relative import validation script.
- Syntax validation for all script files.
- Contract test runner for lifecycle, database/backup, financial safety, and cache checks.
- ESLint flat config with safety rules for scripts, tests, and tools.
- GitHub Actions workflow at `.github/workflows/validate.yml`.

## Validation result

`npm run validate` passed:

- Manifest validation passed.
- Import validation passed for 109 JavaScript files.
- JavaScript syntax validation passed.
- Runtime lifecycle checks passed.
- Database/migration/backup checks passed.
- Financial safety checks passed.
- Bounded cache checks passed.

## Scope note

The workflow installs development dependencies and runs the deterministic validation suite. Bedrock-only integration and load tests remain part of phase 5.2.
