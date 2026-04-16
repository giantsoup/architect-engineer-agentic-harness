# TUI Hardening Notes

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
- `q`: close the TUI without cancelling the run

## Fallback Modes

- `full color`: default when the terminal reports 256-color or better support
- `16-color`: safe ANSI palette for constrained terminals
- `mono`: disables color styling and relies on text labels like `[ACTIVE]`, `[BLOCKED]`, and explicit `theme:` status labels
- `ascii`: disables Unicode-specific behavior when the terminal environment looks Windows-ish or non-UTF-8
- `compact layout`: narrow or short terminals switch to a single focused-pane view instead of rendering six unreadable panes

## Known Limits

- Log history, running command output, and diff panes use bounded UI-only buffers and show when older lines were hidden.
- The TUI is observational only. If rendering fails, the TUI tears down and the run continues so dossier writes are not affected.
- Plain and live console modes remain the fallback paths for non-interactive or incompatible terminals.

## Manual Smoke Checks

- macOS Terminal / iTerm2: pending in this repository environment
- Linux terminal emulator: pending in this repository environment
- Windows Terminal / PowerShell / cmd.exe: pending in this repository environment
