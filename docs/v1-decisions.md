# Architect-Engineer Harness v1 Implementation Decisions

Date: 2026-04-13

## Purpose

This document captures the final implementation decisions for v1 of the local-first Architect-Engineer coding harness so research and implementation can proceed against a concrete plan.

## Product Goal

Build a CLI-first, open-source Architect-Engineer agent harness where:

- The user gives a high-level task to the Architect.
- The Architect plans the work, writes human-readable run artifacts, and manages the Engineer.
- The Engineer modifies project code, runs project commands, and iterates until the task is complete or the run stops.
- The user reviews the final summary, machine-readable result, markdown report, and resulting git branch/commits.

## Target Environment

- Primary development machine: macOS on Apple Silicon
- Initial target hardware: M5 Max with 128 GB RAM
- Model strategy: hybrid local models plus remote API-key-backed models

## Core Stack

- Harness language: TypeScript / Node
- Orchestration framework: LangGraph JS
- Standard model API surface: OpenAI-compatible APIs only
- Distribution target: npm package
- Primary interface: CLI first

## Model Topology

- Default Architect model location: remote
- Default Engineer model location: local
- Role assignment must remain fully configurable via config files
- Local-first model format: GGUF via `llama.cpp` server
- Local model interface should remain generic enough to support other OpenAI-compatible local servers later
- Default local backend for initial MVP: `llama.cpp` server
- Planned near-term follow-up local backends after MVP: Ollama and LM Studio
- Remote backend policy for v1: any OpenAI-compatible remote provider

## Project Scope for v1

- Primary supported project class: TypeScript web apps
- Secondary supported project class included in v1: PHP / Laravel
- Framework support style: minimal adapters only
- TypeScript support should begin with a generic TypeScript path rather than many framework-specific presets
- Laravel support should begin with a generic Laravel path rather than a large opinionated adapter surface

## Execution Model

- Default autonomy mode: fully automatic inside a sandbox
- Sandbox technology: Docker containers
- Default network policy inside the sandbox: full network access
- Lockdown options must be easy to configure during project setup
- v1 execution target for stateful apps: a predefined project container that already has the repo, services, and tooling wired up
- This project container must support project-native commands such as `php`, `composer`, `artisan`, `npm`, and test commands

## Workspace Model

- v1 should operate against the single existing project instance
- v1 should not use git worktrees
- v1 should not use temp clones as the default execution model
- This decision is driven by the need to support stateful application setups such as Laravel apps tied to dedicated MySQL environments

## Git and Change Management

- Each task run should use a dedicated git branch
- Automatic commits are allowed and expected
- v1 should stop at local branch creation and local commits only
- v1 should not push to remotes automatically
- v1 should not open pull requests automatically

## Quality Gate and Stop Conditions

- The harness should auto-detect available checks
- Repo config is authoritative for command selection
- Auto-detection is fallback behavior only
- Passing tests are the minimum completion requirement for every task
- The Architect may define additional acceptance criteria beyond tests
- There is no hard Architect-Engineer iteration cap
- Runs must hard-stop after 1 hour of wall-clock time
- Runs must stop after 5 consecutive failed test cycles

## Role Permissions

- Both Architect and Engineer need terminal access inside the predefined project container
- The Architect may run inspection and verification commands
- The Architect may run tests
- The Architect may write run artifacts such as markdown plans, summaries, and structured state files
- The Architect may not modify project source code
- The Engineer is the only role allowed to modify project source code

## Control Plane and Artifacts

- Orchestration handoffs should use strict JSON for control-plane operations
- The Architect should also emit human-readable markdown instructions and plans for each run
- v1 should be verbose by default
- Every run should generate a formal on-disk task dossier
- The dossier should include prompts, structured messages, markdown task files, command logs, diffs, test output, failure notes, and final summaries
- Lightweight failure notes should be carried between retries

## Persistence

- Persist everything in v1 so early testing can determine what is excessive or unnecessary
- Run history and artifacts should live inside the target repo
- The run-artifact directory should be added to `.gitignore` by default
- Users can later remove the ignore rule if they want to keep artifacts in version control

## Configuration

- Primary project configuration file format: TOML
- Secrets must stay in environment variables
- TOML config may reference environment variables, but must not store raw secrets
- The project should include an initial setup command
- The setup command should bootstrap config, artifact directories, and `.gitignore` entries

## Tooling and MCP

- v1 should ship with minimal built-in local tools for essential operations such as read, write, and command execution
- MCP must be integrated in v1
- MCP usage must be controlled by a project-level allowlist
- Only MCP servers explicitly enabled in repo config may be used by the harness
- This is important for project-specific integrations such as Laravel Boost MCP

## Observability

- The CLI should present an abstract manager-level live view
- The terminal should not dump full low-level execution detail by default
- Detailed logs, command traces, and other debugging artifacts should be written to disk for later inspection

## Final Run Contract

Every completed run must produce:

- A human-readable summary
- A machine-readable JSON result
- A human-readable markdown report

The completion artifacts should also make it easy to find:

- The task branch name
- The resulting commit hashes
- Test results
- Paths to the generated run artifacts

## Failure and Recovery

- Rollback behavior must be configurable
- Default failure behavior should leave the branch as-is
- The harness must provide a clear failure summary when a run stops unsuccessfully

## v1 Non-Goals

- Multi-engineer parallel execution
- Automatic push to remote
- Automatic PR creation
- Worktree-based execution as the default path
- A large library of framework-specific adapters on day one

## Recommended Research Order

Research should proceed in this order so implementation decisions stay aligned:

1. LangGraph JS state-machine design for a single Architect and single Engineer loop
2. OpenAI-compatible client abstraction in TypeScript for remote and `llama.cpp` backends
3. Docker execution model for predefined project containers
4. TOML config schema and versioned prompt/schema file layout
5. Git branch and auto-commit flow against a single live repo instance
6. Minimal built-in tools plus MCP allowlist integration
7. TypeScript generic adapter and Laravel generic adapter
8. Run dossier layout, JSON schemas, markdown artifact templates, and failure-note format
9. CLI UX for manager-level live progress with detailed logs on disk
10. Setup command and npm package distribution path

## Final v1 Summary

v1 is a CLI-first, TypeScript/Node, LangGraph-based Architect-Engineer harness packaged as an npm tool. It uses strict JSON for orchestration, human-readable markdown run artifacts, a remote-by-default Architect, a local GGUF Engineer through `llama.cpp`, Docker-based execution inside a predefined project container, dedicated task branches with automatic local commits, repo-local verbose artifacts, TOML configuration, environment-variable-backed secrets, MCP integration through a project allowlist, and a completion gate that always requires passing tests.
