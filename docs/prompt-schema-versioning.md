# Prompt and Schema Versioning

Date: 2026-04-13

Milestone 0 commits the first versioned prompt and schema assets so later milestones can load them without inventing layout on the fly.

## Conventions

- Prompt assets live under `prompts/<version>/...`
- Schema assets live under `schemas/<version>/...`
- Version directories are immutable once referenced by runtime code
- New prompt or schema revisions should be added as new version directories instead of editing previously released assets in place

## Initial Baseline

- Prompt version: `v1`
- Schema version: `v1`

Prompt files are grouped by role and purpose. Schema files are grouped by version and named for the artifact they validate.
