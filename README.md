# architect-engineer-agentic-harness

CLI-first Architect-Engineer coding harness for autonomous repo work.

Current v1 shape:

- single-model interactive `blueprint chat`
- explicit TypeScript runtime, not LangGraph
- OpenAI-compatible model APIs
- one chat-first Agent model plus remote Architect and local `llama.cpp` Engineer defaults
- host or Docker command execution
- repo-local run dossiers under `.agent-harness/runs/<run-id>/`
- built-in tools plus MCP stdio servers gated by a repo allowlist

The package is pre-v1, but the CLI is real today: `init`, `chat`, `run`, `status`, and `inspect` all work.

## Install

Requirements:

- Node.js 22 or newer
- npm 11 or newer
- Git available on `PATH` for full task runs
- an OpenAI-compatible Architect endpoint
- a reachable local or remote Engineer endpoint
- Docker available if `project.executionTarget = "docker"`

One-shot usage with `npx`:

```bash
npx architect-engineer-agentic-harness@latest --help
```

Project-local install:

```bash
npm install --save-dev architect-engineer-agentic-harness
npm exec blueprint -- --help
```

Global install:

```bash
npm install -g architect-engineer-agentic-harness
blueprint --help
```

Local tarball install before publish:

```bash
npm pack
npm install --save-dev ./architect-engineer-agentic-harness-0.1.0.tgz
npx blueprint --help
```

`architect-engineer-agentic-harness` and `blueprint` both point to the same CLI binary. Use the package name with `npx`; use either binary name after local or global installation.

## Before First Run

Set up these items before you try a real task run:

1. Choose an execution target.
   Host: commands run directly in your local checkout.
   Docker: commands run in an already-running project container.
2. Configure the Agent model endpoint for `blueprint chat`.
   The default examples assume an OpenAI-compatible `llama.cpp` server.
3. Configure the Architect and Engineer model endpoints for `blueprint run --task`.
   Example: OpenAI or another OpenAI-compatible API for Architect, plus a local or remote Engineer endpoint.
4. Confirm your repo commands work.
   At minimum, make sure your configured `test` command succeeds when run manually.
5. For full Architect-Engineer runs, start from a clean git worktree.
   The harness records run branches and commits and will stop when the repo starts dirty.
6. If you plan to use MCP servers, make sure any allowlisted stdio commands also work from the host machine where you start `blueprint`.

## Setup

### Host Path

Host mode is the simplest default for local repos.

1. Install the CLI.

```bash
npm install --save-dev architect-engineer-agentic-harness
```

2. Initialize the repo.

```bash
npx blueprint init
```

3. Start your Engineer endpoint.

```bash
llama-server --host 127.0.0.1 --port 8080 --model /absolute/path/to/engineer.gguf
```

4. Export your Architect API key.

```bash
export OPENAI_API_KEY=replace-me
```

5. Update `agent-harness.toml` for host execution.

```toml
[models.agent]
provider = "llama.cpp"
model = "replace-with-your-agent-model"
baseUrl = "http://127.0.0.1:8080/v1"

[models.architect]
provider = "openai-compatible"
model = "replace-with-your-architect-model"
baseUrl = "https://api.openai.com/v1"
apiKey = "${OPENAI_API_KEY}"

[models.engineer]
provider = "llama.cpp"
model = "replace-with-your-engineer-model"
baseUrl = "http://127.0.0.1:8080/v1"

[project]
executionTarget = "host"

[sandbox]
mode = "workspace-write"
```

6. Verify the configured command path.

```bash
npx blueprint run --command "npm test"
```

### Docker Path

Docker mode is useful when your app already runs inside a prepared project container.

1. Install the CLI and initialize the repo.

```bash
npm install --save-dev architect-engineer-agentic-harness
npx blueprint init
```

2. Start your Engineer endpoint on the host machine.

```bash
llama-server --host 127.0.0.1 --port 8080 --model /absolute/path/to/engineer.gguf
```

3. Export your Architect API key.

```bash
export OPENAI_API_KEY=replace-me
```

4. Make sure your project container is already running and can execute your repo commands.

5. Update `agent-harness.toml` for Docker execution.

```toml
[models.agent]
provider = "llama.cpp"
model = "replace-with-your-agent-model"
baseUrl = "http://127.0.0.1:8080/v1"

[models.architect]
provider = "openai-compatible"
model = "replace-with-your-architect-model"
baseUrl = "https://api.openai.com/v1"
apiKey = "${OPENAI_API_KEY}"

[models.engineer]
provider = "llama.cpp"
model = "replace-with-your-engineer-model"
baseUrl = "http://127.0.0.1:8080/v1"

[project]
executionTarget = "docker"
containerName = "app"

[sandbox]
mode = "container"
```

6. Verify the configured command path.

```bash
npx blueprint run --command "npm test"
```

## First Commands

Open the single-model interactive chat TUI:

```bash
blueprint chat
```

Target a repo outside your current shell directory:

```bash
blueprint chat --project-root ../target-repo
```

Run a single command through the configured execution target:

```bash
blueprint run --command "npm test"
```

Run the full Architect-Engineer loop from inline markdown:

```bash
blueprint run --task "Implement Milestone 12 and keep all tests green."
```

Run the full loop against a repo outside your current shell directory:

```bash
blueprint run --task "Implement Milestone 12 and keep all tests green." --project-root ../target-repo
```

Run the full loop from a file:

```bash
blueprint run --task-file task.md
```

Open the interactive dashboard explicitly for a TTY task run:

```bash
blueprint run --task "Implement Milestone 12 and keep all tests green." --ui tui
```

Open the standalone TUI demo feed without starting a real Architect-Engineer run:

```bash
blueprint tui-demo
```

Check the latest run:

```bash
blueprint status
blueprint inspect
```

Live sanity prompts for post-change validation:

- see [docs/live-sanity-suite.md](docs/live-sanity-suite.md)

## Run UI Modes

`--ui` applies to Architect-Engineer task runs (`--task` / `--task-file`). It does not change single-command mode, which still streams the command's own stdout and stderr.

- `live` is the default. On an interactive TTY it keeps a concise manager-level status block refreshed on `stderr`. On a non-TTY it emits compact snapshot lines only when the run state changes, which keeps CI logs readable.
- `plain` disables the live renderer and leaves only the normal command output plus the final completion summary.
- `tui` opens the interactive neo-blessed dashboard for TTY runs. If `stdin` or `stdout` is not a TTY, or the dashboard cannot initialize, the run continues without the TUI shell and still writes the normal dossier plus the final completion summary.

Keybindings, terminal fallbacks, and the current smoke matrix live in [docs/tui-hardening.md](docs/tui-hardening.md).

Interactive chat mode is documented separately in [docs/chat-mode.md](docs/chat-mode.md). `blueprint chat` is TTY-only and does not accept inline task text.

## Commands

`init`

- bootstraps `agent-harness.toml`
- creates artifact directories
- preserves an existing config file
- adds `/.agent-harness/` to `.gitignore` if needed
- detects a generic TypeScript or Laravel repo and seeds matching command defaults
- defaults generic local repos to `project.executionTarget = "host"`
- keeps Laravel-oriented initialization on `project.executionTarget = "docker"`

`chat`

- opens a full-screen single-model chat TUI backed by `models.agent`
- writes a fresh `agent-chat` dossier immediately
- accepts `--project-root <directory>`
- requires an interactive TTY on both `stdin` and `stdout`

`run`

- `run --command <command>` executes one command and writes a dossier entry
- `run --task <markdown>` runs the Architect-Engineer loop against the current repo by default
- `run --task-file <path>` reads the task brief from disk
- `--project-root <directory>` selects the repo root for task mode
- `--ui plain|live|tui` selects the task-run UI mode; default is `live`
- `--role architect|engineer` applies to single-command mode
- `--cwd` applies to single-command mode only
- `--env` and `--timeout-ms` are supported

`status [run-id]`

- summarizes the latest run by default
- shows run status, summary, current phase, and key artifact paths

`inspect [run-id]`

- lists the main artifact files for the latest run or a specific run
- points you to dossier files without dumping their contents

## Config Overview

The repo-local config file is `agent-harness.toml`.

Current config version behavior:

- current supported version: `2`
- missing `version` fails with an actionable error
- newer config versions fail with an upgrade message
- version `1` configs are migrated by copying `models.engineer` into `models.agent`
- legacy `commands.setup` is still accepted and normalized to `commands.install`

Top-level sections:

- `version`
- `models.agent`
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

The default local Agent and Engineer paths assume an OpenAI-compatible `llama.cpp` server.

A minimal local launch often looks like:

```bash
llama-server --host 127.0.0.1 --port 8080 --model /absolute/path/to/engineer.gguf
```

Match the config to that server:

```toml
[models.agent]
provider = "llama.cpp"
model = "replace-with-your-agent-model"
baseUrl = "http://127.0.0.1:8080/v1"

[models.engineer]
provider = "llama.cpp"
model = "replace-with-your-engineer-model"
baseUrl = "http://127.0.0.1:8080/v1"
```

Notes:

- the harness talks to the Agent and Engineer models from the host process, not from inside the Docker project container
- keep the `baseUrl` reachable from the machine running `blueprint`
- set `model` to whatever identifier your local server expects

## Host Execution

For many local repos, host execution is the simplest setup:

```toml
[project]
executionTarget = "host"
```

Host mode behavior:

- commands run directly from the local checkout on your machine
- the default command working directory is the repo root
- for `run --command`, `--cwd` may point to a repo-relative or absolute host path
- for `run --task` and `run --task-file`, use `--project-root` to target a different repo
- this is convenient, but it is not a security boundary

Recommended host pairing:

```toml
[sandbox]
mode = "workspace-write"
```

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
