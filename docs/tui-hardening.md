# TUI Hardening Notes

## Default Task-Run UI Behavior

- `blueprint run --task ...` and `blueprint run --task-file ...` default to `--ui live`.
- `live` is the safe default for both TTY and non-TTY runs.
- `plain` is the no-live-output path for CI logs, scripts, or users who only want the completion summary.
- `tui` is opt-in. It requires both `stdin` and `stdout` to be interactive TTYs.
- `run --command ...` keeps its existing direct command stdout/stderr behavior. `--ui` is a task-run concern.

## Keybindings

- `Tab` / `Shift-Tab`: cycle focus
- `1-6`: jump to a pane directly
- `Left` / `Right`: cycle focus
- `Up` / `Down`: scroll the focused pane or move the queue selection
- `PgUp` / `PgDn`: faster scroll
- `x`: maximize or restore the focused pane
- `f`: toggle log follow mode
- `r`: reset maximize, help, and scroll state
- `?`: open or close help
- `q` / `Ctrl-C`: close the TUI without cancelling the run

## Fallback Modes

- `full color`: default when the terminal reports 256-color or better support
- `16-color`: safe ANSI palette for constrained terminals
- `mono`: disables color styling and relies on text labels like `[ACTIVE]`, `[BLOCKED]`, and explicit `theme:` status labels
- `ascii`: disables Unicode-specific behavior when the terminal environment looks Windows-ish or non-UTF-8
- `compact layout`: narrow or short terminals switch to a single focused-pane view instead of rendering six unreadable panes

## Fallback Behavior

- If `--ui tui` is requested without an interactive TTY, the CLI prints a one-line notice, skips the TUI shell, and still prints the normal completion summary at the end.
- If the TUI starts and later fails during render, keyboard handling, live-data hydration, or teardown, the shell is torn down, the terminal is restored, and dossier writes continue.
- `live` and `plain` remain the preferred modes for CI, log capture, and non-interactive terminals.

## Known Limits

- Log history, running command output, and diff panes use bounded UI-only buffers and show when older lines were hidden.
- The TUI is observational only. If rendering fails, the TUI tears down and the run continues so dossier writes are not affected.
- Plain and live console modes remain the fallback paths for non-interactive or incompatible terminals.

## Manual Smoke Checks

- 2026-04-15, macOS Terminal PTY in this repository environment: pass
  Scope: launched the neo-blessed renderer in an interactive terminal, verified help (`?`), maximize (`x`), follow toggle (`f`), reset (`r`), quit (`q`), and clean terminal restoration on exit.
- Linux terminal emulator: deferred
  Reason: no Linux terminal environment is available from this workspace.
- Windows Terminal / PowerShell / `cmd.exe`: deferred
  Reason: no Windows terminal environment is available from this workspace.

## Automated Coverage Backing The Rollout

- `test/cli/run-ui-mode.test.ts`: default `live`, explicit `plain`, and explicit `tui` CLI selection
- `test/ui/live-console.test.ts`: concise non-TTY `live` output for logs and CI
- `test/ui/tui-fallback-summary.test.ts`: `--ui tui` fallback when no interactive TTY is available
- `test/tui/accessibility.test.ts`: color, ASCII, and compact-layout terminal fallbacks
- `test/tui/terminal-restore.test.ts`: terminal recovery after startup, render, and teardown failures
- `test/tui/backpressure.test.ts` and `test/tui/reconcile.test.ts`: live event burst handling and dossier rehydration
