# Chat Mode

`blueprint chat` is the single-model interactive surface.

Use it when you want:

- one persistent conversation for a single terminal session
- repo-aware tool use without supplying a CLI prompt up front
- a chat-first TUI with transcript, composer, and activity panes

Use `blueprint run --task` when you want:

- the architect/engineer split-brain workflow
- a scripted or non-interactive entrypoint
- task briefs passed on the CLI or from a file

## Requirements

- `stdin` and `stdout` must both be interactive TTYs
- `models.agent` must be configured in `agent-harness.toml`
- no clean git worktree is required

## Behavior

- each `blueprint chat` invocation creates a fresh `agent-chat` dossier
- visible transcript entries are written to `conversation.jsonl`
- control-plane events remain in `events.jsonl`
- per-turn cancellation stops the active turn but keeps the session alive
- clean exit while idle finalizes the run as `success`
- exiting after a cancelled turn finalizes the run as `stopped`

## Keys

- `Enter`: submit when idle
- `Alt+Enter`: insert newline
- `Ctrl-C`: cancel active turn, or exit if idle
- `Tab`: cycle focus
- `?`: open help

## Local Slash Commands

- `/help`
- `/exit`
- `/cancel`
