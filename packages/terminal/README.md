# @termlink/terminal

A shell in a PTY with a headless screen for reconnects. `createTerminal()` starts the
user's shell (PowerShell on Windows, `$SHELL` elsewhere), streams its bytes, keeps a copy
of the screen and scrollback with `@xterm/headless`, and can hand a late client the
current screen as bytes to write after a reset.

The PTY comes from `@lydell/node-pty`, a prebuilt binary per platform installed as an
optional dependency: nothing is compiled on the user's machine. On a platform without one,
`ptyStatus()` says so and `createTerminal()` throws `PtyUnavailableError`.

Used by `@termlink/cli`. Knows nothing about hosts, relays or clients.
