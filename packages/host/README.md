# @termlink/cli

The TermLink host: terminals, Claude Code and Codex sessions on your machine, reachable
from the TermLink web app on any device. One host per machine; sessions open when you ask.

- **Terminal**: your shell in a PTY, like an ssh login. vi, top, npm install, passwords,
  Ctrl+C all work. Reconnect from a phone and the screen is still there.
- **Claude** and **Codex**: coding agents driven through their SDKs, with turns, tool calls
  and approval requests as JSON events. They come back after the host restarts.

Source, protocol and security policy: [github.com/bertshim/termlink-cli](https://github.com/bertshim/termlink-cli).

## Install and run

Requires Node.js 22 or later. Nothing is compiled on your machine: the PTY binary comes
prebuilt for Windows, macOS and Linux (x64 and arm64). npm only warns (`EBADENGINE`) when an
older Node.js installs the package; `termlink` itself checks at start and says which Node.js it
found and how to update.

```sh
npm install -g @termlink/cli
termlink login          # Google sign-in in the browser, once per machine
cd ~/my-project
termlink start          # or just: termlink
```

The host joins the TermLink relay and the web app lists it under this machine's name.
Sessions open only inside the folder the host was started in, unless you pass `--allow-root`.

```
termlink start [options]      run the host (default)
termlink login                sign this machine in
termlink logout               sign this machine out
termlink whoami               show the account
termlink devices              list the machines on this account; `devices revoke <id>` signs one out
termlink --help               every option
```

Useful options for `start`:

- `--allow-root <dir>` — another folder sessions may open in (repeatable)
- `--providers terminal,claude,codex` — which session kinds to offer (this is the default)
- `--shell <path>` — shell for terminal sessions (default: your shell; PowerShell on Windows)
- `--auto-approve edits|all` — let new agent sessions answer file or command approvals themselves
- `--verbose` — print the relay connection details as they happen

While it runs, the host lists sessions as they open and close and keeps a status line at
the bottom: the relay connection, how many sessions are open and how to stop. Its dots move
once a second, so you can tell it is alive. It does not print addresses or tokens. Keep the
window open while you use TermLink, and stop the host with Ctrl+C: agent sessions are saved
and come back on the next start; terminal sessions end with the host.

The host does not handle Claude or Codex credentials. Log in with those tools directly
(`claude`, `codex login`); the host only checks that you did.

## Layout

- `packages/protocol` — command, response and event schemas (zod) and the terminal frame codec, shared with clients
- `packages/terminal` — a shell in a PTY with a headless screen for reconnects; knows nothing about hosts or clients
- `packages/host` — the `termlink` package: sessions, providers, local server, relay link, login, CLI

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

Run the host from source, then drive it with the demo client:

```sh
npm run dev
# prints ws://127.0.0.1:7420/ws?token=...

npm run demo -- "ws://127.0.0.1:7420/ws?token=..." --provider claude
```

One machine runs one host per relay session name (`<hostname>-agent` unless `--relay-session`
says otherwise); a second one refuses to start. Tests and scripts that start a host of their
own should pass their own `--relay-session` and a temporary `--state`, so they neither take the
place of the host you use nor share `~/.termlink/agent-sessions.json` with it.

`npm run bundle -w @termlink/cli` builds `dist/bundle/termlink.mjs`, one file to run from a checkout.
The PTY binary and the headless terminal stay in `node_modules` next to it.

### Sign-in configuration

`termlink login` uses a Google OAuth desktop client. The published package carries its own
(`packages/host/src/auth/oauth-defaults.ts`). For development, point
`TERMLINK_GOOGLE_CLIENT_SECRET_FILE` at a `client_secret_*.json` download, or set
`TERMLINK_GOOGLE_CLIENT_ID` and `TERMLINK_GOOGLE_CLIENT_SECRET`. `TERMLINK_SERVER` picks the master relay.
