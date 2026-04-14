# architect-engineer-agentic-harness

CLI-first Architect-Engineer coding harness for autonomous repo work.

Current v1 shape:

- explicit TypeScript runtime, not LangGraph
- OpenAI-compatible model APIs
- remote Architect plus local `llama.cpp` Engineer by default
- Docker command execution against a predefined project container
- repo-local run dossiers under `.agent-harness/runs/<run-id>/`
- built-in tools plus MCP stdio servers gated by a repo allowlist

The package is pre-v1, but the CLI is real today: `init`, `run`, `status`, and `inspect` all work.

## Install

Requirements:

- Node.js 22 or newer
- npm 11 or newer
- Docker available if `project.executionTarget = "docker"`

One-shot usage with `npx`:

```bash
npx architect-engineer-agentic-harness@latest --help
```

Local project install:

```bash
npm install --save-dev architect-engineer-agentic-harness
npm exec blueprint -- --help
```

Local tarball install before publish:

```bash
npm pack
npm install --save-dev ./architect-engineer-agentic-harness-0.1.0.tgz
npx blueprint --help
```

Global install:

```bash
npm install -g architect-engineer-agentic-harness
blueprint --help
```

`architect-engineer-agentic-harness` and `blueprint` both point to the same CLI binary. Use the package name with `npx`; use either binary name after local or global installation.

## Quick Start

Initialize a repo:

```bash
npx architect-engineer-agentic-harness@latest init
```

That creates:

- `agent-harness.toml`
- `.agent-harness/`
- `.agent-harness/runs/`
- a `.gitignore` entry for `/.agent-harness/`

Then update `agent-harness.toml` with your real model endpoints, API-key env vars, project container name, and repo commands.

Run a single command through the configured execution target:

```bash
blueprint run --command "npm test"
```

Run the full Architect-Engineer loop from inline markdown:

```bash
blueprint run --task "Implement Milestone 12 and keep all tests green."
```

Run the full loop from a file:

```bash
blueprint run --task-file task.md
```

Check the latest run:

```bash
blueprint status
blueprint inspect
```

## Commands

`init`

- bootstraps `agent-harness.toml`
- creates artifact directories
- preserves an existing config file
- adds `/.agent-harness/` to `.gitignore` if needed
- detects a generic TypeScript or Laravel repo and seeds matching command defaults

`run`

- `run --command <command>` executes one command and writes a dossier entry
- `run --task <markdown>` runs the Architect-Engineer loop
- `run --task-file <path>` reads the task brief from disk
- `--role architect|engineer` applies to single-command mode
- `--cwd`, `--env`, and `--timeout-ms` are supported

`status [run-id]`

- summarizes the latest run by default
- shows run status, summary, current phase, and key artifact paths

`inspect [run-id]`

- lists the main artifact files for the latest run or a specific run
- points you to dossier files without dumping their contents

## Config Overview

The repo-local config file is `agent-harness.toml`.

Current config version behavior:

- current supported version: `1`
- missing `version` fails with an actionable error
- newer config versions fail with an upgrade message
- legacy `commands.setup` is still accepted and normalized to `commands.install`

Top-level sections:

- `version`
- `models.architect`
- `models.engineer`
- `project`
- `commands`
- `mcp`
- `network`
- `sandbox`
- `artifacts`
- `stopConditions`

Secrets should stay in environment variables:

```toml
[models.architect]
apiKey = "${OPENAI_API_KEY}"
```

Two shipped reference configs are available:

- [examples/typescript/agent-harness.toml](./examples/typescript/agent-harness.toml)
- [examples/laravel/agent-harness.toml](./examples/laravel/agent-harness.toml)

## Remote Architect Setup

The Architect model is just an OpenAI-compatible endpoint. Configure:

```toml
[models.architect]
provider = "openai-compatible"
model = "replace-with-your-architect-model"
baseUrl = "https://api.openai.com/v1"
apiKey = "${OPENAI_API_KEY}"
```

Guidelines:

- `baseUrl` must be the provider's OpenAI-compatible API root
- `apiKey` should reference an env var, not a literal secret
- `headers`, `timeoutMs`, and `maxRetries` are optional
- the harness does not hardcode any single provider beyond requiring an OpenAI-compatible chat interface

## Local `llama.cpp` Setup

The default local Engineer path assumes an OpenAI-compatible `llama.cpp` server.

A minimal local launch often looks like:

```bash
llama-server --host 127.0.0.1 --port 8080 --model /absolute/path/to/engineer.gguf
```

Match the config to that server:

```toml
[models.engineer]
provider = "llama.cpp"
model = "replace-with-your-engineer-model"
baseUrl = "http://127.0.0.1:8080/v1"
```

Notes:

- the harness talks to the Engineer model from the host process, not from inside the Docker project container
- keep the `baseUrl` reachable from the machine running `blueprint`
- set `model` to whatever identifier your local server expects

## Predefined Project Container Requirements

When `project.executionTarget = "docker"`, the harness does not create or start containers for you. It expects an existing running container.

Current Docker behavior is explicit:

- the CLI calls `docker inspect <container-name>`
- command execution uses `docker exec --workdir <dir> <container-name> sh -lc "<command>"`

Your predefined project container should already provide:

- a running container with the repo mounted and visible to the same working tree the harness edits on the host
- `/bin/sh` or equivalent `sh`
- the project toolchain for the commands you configure
- any app dependencies and backing services already wired up

If the repo inside the container does not see the same filesystem state as the host checkout, the harness can edit files successfully on the host while tests inside the container still run against stale code. That setup is unsupported.

## Laravel Container Expectations

The shipped Laravel example assumes:

- `project.executionTarget = "docker"`
- the Laravel app container is already running
- the container has `php`, `composer`, `artisan`, and any Node package manager commands referenced in `commands`
- app services such as MySQL, Redis, queues, or mailhog are already reachable from that container

Typical Laravel commands:

```toml
[commands]
install = "composer install && npm install"
lint = "./vendor/bin/pint --test"
test = "php artisan test"
typecheck = "npm run typecheck"
```

Important current limitation:

- project commands run inside the configured Docker container
- MCP stdio servers run on the host machine where the harness CLI starts

That matters for the Laravel Boost preset. The preset resolves to:

```bash
php artisan boost:mcp
```

from the repo root on the host. If your host environment cannot run that command, do one of these:

- omit Laravel Boost from the allowlist
- replace the preset with an explicit host-side command that works in your setup

The harness does not currently proxy MCP server startup through Docker.

## MCP Allowlist Configuration

Only allowlisted MCP servers may be used.

Example with an explicit stdio server:

```toml
[mcp]
allowlist = ["repo"]

[mcp.servers.repo]
transport = "stdio"
command = "node"
args = ["scripts/repo-mcp.js"]
workingDirectory = "."
```

Example with the Laravel Boost preset:

```toml
[mcp]
allowlist = ["laravel-boost"]

[mcp.servers.laravel-boost]
transport = "stdio"
preset = "laravel-boost"
```

Behavior:

- every server in `mcp.allowlist` must also exist in `mcp.servers`
- duplicate allowlist entries are rejected
- preset-backed servers must not also declare `command` or `args`
- non-allowlisted MCP calls fail with a clear config error

## Package Contents

The published npm package intentionally ships only runtime assets and examples:

- `dist/`
- `prompts/`
- `schemas/`
- `examples/`
- npm metadata files such as `package.json`, `README.md`, and `LICENSE`

It does not ship `src/`, `test/`, or repo-only planning docs.

## Development

Useful commands:

```bash
npm install
npm run build
npm run cli -- --help
npm run cli:dev -- --help
npm run test
npm run verify
```

Local package validation:

```bash
npm run build
node dist/cli.js --help
npm pack --dry-run
```

Project notes:

- [v1 Decisions](./docs/v1-decisions.md)
- [v1 Backlog](./docs/v1-backlog.md)
- [Bootstrap Architecture Notes](./docs/bootstrap-architecture.md)
- [Prompt and Schema Versioning](./docs/prompt-schema-versioning.md)

## License

Apache License 2.0. See [LICENSE](./LICENSE).
