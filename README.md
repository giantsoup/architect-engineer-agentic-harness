# architect-engineer-agentic-harness

Early-stage CLI-first open-source Architect-Engineer coding harness for autonomous repo work with:

- TypeScript / Node
- LangGraph JS orchestration
- OpenAI-compatible model APIs
- Remote Architect and local Engineer defaults
- Docker-based execution against predefined project containers
- Repo-local verbose run artifacts
- Built-in tools plus MCP integration

## Install

Requirements:

- Node.js 22 or newer
- npm 11 or newer

Install as a dependency:

```bash
npm install architect-engineer-agentic-harness
```

Run without installing globally:

```bash
npx architect-engineer-agentic-harness --help
```

Global install:

```bash
npm install -g architect-engineer-agentic-harness
architect-engineer-agentic-harness --help
```

Friendly CLI alias after install:

```bash
blueprint --help
```

## Current Status

This package is not feature-complete yet. The current published surface is the Milestone 1 bootstrap slice:

- `init` creates a repo-local config file
- `init` creates the default artifact directory structure
- `init` updates `.gitignore` to ignore verbose run artifacts safely

Commands such as `run`, `status`, and `inspect` are still placeholders for later milestones.

## Quick Start

Bootstrap a target repository:

```bash
npx architect-engineer-agentic-harness init
```

or:

```bash
blueprint init
```

Then edit `agent-harness.toml` for the target project before running real tasks.

Secrets should stay in environment variables. Use TOML values like `"${OPENAI_API_KEY}"` instead of storing raw secrets in the config file.

Initial project planning documents:

- [v1 Decisions](./docs/v1-decisions.md)
- [v1 Backlog](./docs/v1-backlog.md)
- [Bootstrap Architecture Notes](./docs/bootstrap-architecture.md)
- [Prompt and Schema Versioning](./docs/prompt-schema-versioning.md)

## Initial Focus

The current implementation target is Milestone 1: Init Command and Config System:

- repo-local `init` bootstrap flow
- TOML config loading and validation
- artifact directory creation
- safe `.gitignore` updates

## Notes

- GitHub issues are intended to track the milestone backlog from the planning documents.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE).

## Development

Commands:

- `npm install`
- `npm run build`
- `npm run build:watch`
- `npm run cli -- --help`
- `npm run cli:dev -- --help`
- `npm run link:dev`
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm run test`
- `npm run verify`

CLI smoke check:

- `node dist/cli.js --help`

Local linked CLI workflow:

```bash
npm run link:dev
blueprint --help
```

During active CLI development, keep the build current in another terminal:

```bash
npm run build:watch
```
