# Architect-Engineer Harness v1 Backlog

Date: 2026-04-13
Related decisions: [architect-engineer-harness-v1-decisions.md](/Users/Taylor/architect-engineer-harness-v1-decisions.md)

## Goal

Turn the v1 decisions into a concrete, researchable, implementation-ready backlog for a CLI-first open-source coding harness with:

- TypeScript / Node
- explicit orchestration first, with optional LangGraph adoption later if justified
- OpenAI-compatible model APIs only
- Remote Architect by default
- Local GGUF Engineer via `llama.cpp` by default
- Docker-based execution against a predefined project container
- Dedicated git branches with automatic local commits
- Repo-local verbose artifacts
- TOML config
- Built-in tools plus MCP allowlist support

## Build Strategy

Build the system in thin vertical slices. Do not start with the full multi-role loop. First make the runtime shape, config loading, artifact persistence, and one-model command flow real. Then layer in the Architect-Engineer split, git automation, adapters, and polish.

The safest order is:

1. Create the CLI shell and project setup flow
2. Create config loading, schema validation, and artifact persistence
3. Create model client abstraction for OpenAI-compatible providers
4. Create the project-container command runner
5. Create the single Engineer tool loop
6. Add the Architect orchestration loop explicitly in the runtime
7. Add git branch and commit automation
8. Add TypeScript and Laravel minimal adapters
9. Add MCP allowlist integration
10. Add observability polish, packaging, and hardening

## Proposed Repo Shape

This is a practical starting layout for the npm package:

```text
src/
  cli/
    index.ts
    commands/
      init.ts
      run.ts
      status.ts
      inspect.ts
  config/
    load-config.ts
    resolve-env.ts
    defaults.ts
    schema.ts
    migrate-config.ts
  prompts/
    architect/
      system.md
      planning.md
      review.md
    engineer/
      system.md
      execute.md
    schemas/
      architect-plan.schema.json
      architect-review.schema.json
      run-result.schema.json
  models/
    types.ts
    openai-compatible-client.ts
    provider-factory.ts
    local/
      llamacpp.ts
    remote/
      generic-openai.ts
  runtime/
    architect-engineer-state.ts
    architect-engineer-nodes.ts
    architect-engineer-guards.ts
    architect-engineer-run.ts
    run-context.ts
    run-store.ts
    dossier-writer.ts
    failure-notes.ts
    event-bus.ts
  sandbox/
    container-session.ts
    command-runner.ts
    file-access.ts
    permissions.ts
  tools/
    builtins/
      read-file.ts
      write-file.ts
      list-files.ts
      run-command.ts
      git-status.ts
      git-diff.ts
    mcp/
      registry.ts
      allowlist.ts
      client.ts
      tool-router.ts
  git/
    branch.ts
    commit.ts
    status.ts
    diff.ts
  adapters/
    types.ts
    detect-project.ts
    typescript-generic.ts
    laravel-generic.ts
  checks/
    discover.ts
    execute.ts
    summarize.ts
  artifacts/
    paths.ts
    markdown.ts
    json.ts
    logs.ts
    templates/
      run-plan.md
      engineer-task.md
      final-report.md
  ui/
    live-console.ts
    summary-renderer.ts
  types/
    config.ts
    run.ts
    messages.ts
```

## Milestones

## Milestone 0: Project Foundation

Objective: establish the package, toolchain, and development rules before writing harness logic.

Backlog:

- Initialize the npm package with TypeScript support
- Set up build, typecheck, lint, format, and test scripts
- Decide on runtime target for Node
- Add a CLI entrypoint
- Add a test framework and fixture strategy
- Add a docs folder for architecture notes and prompt/schema versioning conventions
- Add prompt and schema directories as versioned repo files

Acceptance criteria:

- `npm run build` works
- `npm run typecheck` works
- `npm run test` works
- CLI executable runs and prints help

Research focus:

- Best Node target and module format for CLI distribution
- Best validation library for TOML-backed config plus JSON-schema-aligned outputs

## Milestone 1: Init Command and Config System

Objective: make project bootstrap real so a target repo can be prepared for the harness.

Backlog:

- Implement `init` CLI command
- Generate repo-local TOML config file
- Generate artifact directory structure
- Add artifact directory to `.gitignore` by default
- Add config comments or accompanying docs so users understand required fields
- Support environment-variable references in config
- Validate config on load with clear errors
- Include fields for:
  - Architect model provider and model name
  - Engineer model provider and model name
  - Local `llama.cpp` endpoint
  - Project container name or execution target
  - Command overrides
  - MCP allowlist
  - Network and sandbox options
  - Artifact directory paths
  - Stop conditions

Acceptance criteria:

- `init` creates a working config and artifact directory
- Re-running `init` is safe and non-destructive
- Invalid config yields useful CLI errors
- Env var references resolve correctly

Research focus:

- TOML ergonomics for open-source CLI tools
- Safe `.gitignore` modification patterns

## Milestone 2: Artifact Store and Run Dossier

Objective: create the persistent run structure before complex orchestration begins.

Backlog:

- Define run ID format
- Define on-disk dossier layout
- Write helpers for creating a new run directory
- Persist:
  - prompts used
  - structured messages
  - markdown plans
  - command logs
  - diffs
  - test results
  - failure notes
  - final JSON result
  - final markdown report
- Add version metadata for prompts and schemas
- Add helper methods to append events and logs safely

Suggested dossier shape:

```text
.agent-harness/
  runs/
    <run-id>/
      run.json
      events.jsonl
      architect-plan.md
      engineer-task.md
      architect-review.md
      command-log.jsonl
      checks.json
      diff.patch
      failure-notes.md
      result.json
      final-report.md
```

Acceptance criteria:

- A dummy run can create a dossier with all expected files
- Files are written consistently and referenced from one manifest
- Result JSON validates against its schema

Research focus:

- JSONL event logging conventions
- Safe artifact writing during long-running CLI processes

## Milestone 3: OpenAI-Compatible Model Client Layer

Objective: normalize model access before building the graph.

Backlog:

- Create shared model request and response types
- Implement OpenAI-compatible chat client
- Support custom base URLs and headers
- Support remote Architect and local Engineer endpoints independently
- Add retry, timeout, and basic error classification
- Add request logging hooks that feed the dossier
- Add structured output handling for Architect control messages

Acceptance criteria:

- Can call a remote OpenAI-compatible endpoint for Architect
- Can call a local `llama.cpp` OpenAI-compatible endpoint for Engineer
- Base URL, model, and auth are config-driven
- Structured Architect output is validated

Research focus:

- `llama.cpp` server quirks versus remote OpenAI-compatible APIs
- How much schema strictness is practical for Architect outputs

## Milestone 4: Project Container Command Runner

Objective: make command execution inside the predefined project container reliable.

Backlog:

- Implement a container session abstraction
- Support running commands inside a configured existing container
- Capture stdout, stderr, exit code, duration, and working directory
- Support read-only inspection commands for Architect
- Support write-capable commands for Engineer
- Add timeouts and cancellation
- Add environment injection rules
- Add command logging into the dossier

Acceptance criteria:

- The CLI can execute a simple command in the configured project container
- Logs are captured cleanly
- Timeouts work
- Failure output is preserved

Research focus:

- Best way to exec into an already-running Docker container from Node
- How to preserve shell compatibility for PHP and npm toolchains

## Milestone 5: Built-in Tool Layer

Objective: expose a minimal, explicit tool surface before adding MCP.

Backlog:

- Implement built-in tools for:
  - file read
  - file write
  - file listing
  - command execution
  - git status
  - git diff
- Add role-based permissions:
  - Architect can write artifacts only
  - Engineer can modify source files
- Add path guards so writes stay inside the intended project/artifact boundaries
- Add structured tool result records for logs

Acceptance criteria:

- Engineer can edit a test file through the tool layer
- Architect can write markdown run artifacts but cannot edit source
- Tool calls are logged in structured form

Research focus:

- Best file-editing approach for deterministic patch application in Node
- Path-boundary enforcement patterns

## Milestone 6: Single-Engineer Execution Slice

Objective: prove the core execution loop with one model before adding the Architect.

Backlog:

- Implement a direct Engineer task mode
- Feed it a markdown task brief plus available tools
- Allow it to edit files and run checks
- Produce a run dossier and final report
- Stop on passing tests, timeout, or failed test threshold

Acceptance criteria:

- A simple scoped task can be completed end-to-end by the Engineer alone
- Run artifacts are useful enough to debug failures
- Stop conditions are enforced

Research focus:

- How much autonomy the Engineer can handle before Architect review becomes necessary

## Milestone 7: Architect-Engineer Orchestration Loop

Objective: add the real multi-role orchestration layer with explicit runtime state, nodes, and guards.

Backlog:

- Define graph state
- Create nodes for:
  - run preparation
  - Architect planning
  - Engineer execution
  - Architect review
  - finalization
- Implement strict JSON schemas for:
  - Architect plan output
  - Architect review decision
  - final machine-readable result
- Generate human-readable markdown files from Architect decisions
- Carry failure notes between retries
- Enforce stop conditions:
  - 1 hour max duration
  - 5 consecutive failed test cycles
  - no hard iteration cap, but graph must still stop on global limits

Acceptance criteria:

- Architect creates a valid plan
- Engineer executes against that plan
- Architect reviews results and either stops or issues the next iteration
- Final report and result JSON are generated

Research focus:

- Best explicit state shape for durable verbose runs
- How to represent review feedback without letting the orchestration sprawl
- When a later LangGraph wrapper would actually buy enough value to justify the dependency

## Milestone 8: Git Branch and Commit Automation

Objective: make runs produce isolated local git output.

Backlog:

- Create dedicated branch per run or task
- Detect dirty working tree and define safe behavior
- Record starting branch and commit
- Auto-commit meaningful milestones or final state
- Capture git diffs in artifacts
- Surface branch name and commit hashes in final outputs

Acceptance criteria:

- A run creates and works on a dedicated branch
- Local commits are generated automatically
- Final summary includes branch and commit references

Research focus:

- Safe branch naming strategy
- How to behave if the repo starts dirty but the user still wants the run to continue

## Milestone 9: Project Adapters

Objective: make v1 usable on the two intended project classes.

Backlog:

- Implement project detection
- Add minimal TypeScript adapter
- Add minimal Laravel adapter
- Make repo config authoritative for commands
- Add fallback detection for:
  - install command
  - lint command
  - typecheck command
  - test command
- Allow Architect acceptance criteria to add non-test goals while preserving tests as minimum completion gate

Acceptance criteria:

- TypeScript project can be initialized and run with minimal manual config
- Laravel project can be initialized and run with minimal manual config
- Config overrides detection cleanly

Research focus:

- Common package scripts and project markers for generic TypeScript repos
- Reliable Laravel command assumptions without overfitting

## Milestone 10: MCP Integration

Objective: integrate MCP without making it the only tool path.

Backlog:

- Implement MCP registry/config loader
- Enforce project-level allowlist
- Allow tool routing between built-in tools and MCP tools
- Log MCP tool calls and outputs into the dossier
- Add clear CLI diagnostics when an MCP server is configured but unavailable
- Add first-class support path for Laravel Boost MCP through project config

Acceptance criteria:

- A configured allowed MCP server can be called during a run
- A non-allowlisted MCP server cannot be called
- MCP tool activity appears in artifacts and summaries

Research focus:

- Node MCP client patterns that fit CLI lifecycles
- How much MCP metadata should be exposed to the Architect versus the Engineer

## Milestone 11: Manager-Level CLI UX

Objective: make the tool usable without overwhelming the terminal.

Backlog:

- Build a concise live console renderer
- Show:
  - current phase
  - active role
  - current objective
  - command/check status
  - elapsed time
  - latest high-level decision
- Hide detailed logs from default terminal output
- Add a way to open or print paths to the run dossier
- Add `status` and `inspect` commands for post-run review

Acceptance criteria:

- Default terminal output is understandable at a glance
- Detailed logs are available in artifacts without cluttering the console
- Failed runs point the user directly to the most useful artifacts

Research focus:

- Best terminal rendering approach for a clean manager-level live view

## Milestone 12: Packaging, Hardening, and Documentation

Objective: make the tool usable by outside developers.

Backlog:

- Package the CLI as an npm package
- Ensure `npx` execution works
- Write setup docs for:
  - remote Architect configuration
  - local `llama.cpp` setup
  - predefined project container requirements
  - Laravel container setup expectations
  - MCP allowlist configuration
- Write example configs for TypeScript and Laravel
- Add upgrade/migration handling for future config versions
- Add smoke tests around `init` and `run`

Acceptance criteria:

- Another developer can install and initialize the tool from docs
- Example projects work
- Packaging does not require repo-local hacks

Research focus:

- Best npm distribution flow for a TypeScript CLI with templates and prompt files

## Priority Order Inside the Codebase

If work starts immediately, implement in this exact order:

1. `src/cli`
2. `src/config`
3. `src/artifacts` and `src/runtime`
4. `src/models`
5. `src/sandbox`
6. `src/tools/builtins`
7. `src/graph`
8. `src/git`
9. `src/adapters`
10. `src/tools/mcp`
11. `src/ui`

## Suggested First Three GitHub Milestones

## Milestone A: Bootstrap and Run Dossier

Ship:

- npm package skeleton
- CLI entrypoint
- `init` command
- TOML config
- artifact directory creation
- dossier writer
- prompt/schema version file loading

Definition of done:

- A repo can be initialized and a dummy run dossier can be created successfully

## Milestone B: Container Execution and Single-Engineer Mode

Ship:

- project container command runner
- built-in tools
- local/remote model client
- direct Engineer execution mode
- stop conditions

Definition of done:

- A simple real task can be executed end-to-end by the Engineer against a configured repo

## Milestone C: Full Architect-Engineer Loop

Ship:

- explicit orchestration state machine, with LangGraph remaining an optional later wrapper
- Architect structured planning and review
- Engineer task handoff
- git branch/commit automation
- final JSON result and markdown report

Definition of done:

- The full two-role flow completes a real task and leaves a reviewable local branch and dossier

## Open Research Questions Worth Investigating Early

- What is the cleanest strict-schema strategy for Architect outputs when using mixed OpenAI-compatible providers?
- What is the most reliable way to exec into a predefined running Docker container from Node while preserving interactive tool behavior?
- How should file writes be implemented so Engineer edits are deterministic and auditable?
- How should dirty working trees be handled when runs create dedicated branches but operate on a single live repo instance?
- How should `llama.cpp` request settings be tuned for reliable local Engineer behavior?
- How much context from verbose dossier history should be fed back into later Architect review steps?
- What is the cleanest MCP abstraction so built-in tools and MCP tools look similar without obscuring security boundaries?

## Recommended Next Action

Start with Milestone A only. Do not begin with LangGraph adoption, MCP, or Laravel-specific behavior until the following are already real:

- npm CLI shell
- `init` command
- TOML config loading and validation
- repo-local artifact dossier creation
- versioned prompt/schema file loading

That is the smallest slice that creates irreversible structure in the right places and keeps later implementation decisions disciplined.
