# architect-engineer-agentic-harness

CLI-first open-source Architect-Engineer coding harness for autonomous repo work with:

- TypeScript / Node
- LangGraph JS orchestration
- OpenAI-compatible model APIs
- Remote Architect and local Engineer defaults
- Docker-based execution against predefined project containers
- Repo-local verbose run artifacts
- Built-in tools plus MCP integration

## Current Status

This repository is in Milestone 0 bootstrap phase.

Initial project planning documents:

- [v1 Decisions](./docs/v1-decisions.md)
- [v1 Backlog](./docs/v1-backlog.md)
- [Bootstrap Architecture Notes](./docs/bootstrap-architecture.md)
- [Prompt and Schema Versioning](./docs/prompt-schema-versioning.md)

## Initial Focus

The current implementation target is Milestone 0: Project Foundation:

- npm package and CLI shell
- TypeScript build and typecheck
- lint, format, and test tooling
- initial `src/` architecture layout
- versioned prompt and schema asset layout

## Notes

- GitHub issues are intended to track the milestone backlog from the planning documents.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE).

## Development

Requirements:

- Node.js 22 or newer
- npm 11 or newer

Commands:

- `npm install`
- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm run test`
- `npm run verify`

CLI smoke check:

- `node dist/cli.js --help`
