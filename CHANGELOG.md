# Changelog

All three packages (`@termlink/cli`, `@termlink/protocol`, `@termlink/terminal`) share one
version number.

## 0.1.6 - 2026-10-03

Three things Codex was already reporting, and one it already knew how to do, that
never reached a client.

- `SessionInfo.model` carries the model an agent session runs on, where its provider
  says so. Codex reports it in the reply that opens its thread, and that reply was
  being destructured without it. Cursor reports it the same way — `models.currentModelId`
  on its `session/new` reply — and was losing it for the same reason; where a model is
  configured, that one is reported instead, since `session/set_model` has just moved the
  session onto it.
- `SessionInfo.limits` carries how much of the account's plan is spent — a short
  window and a long one, each with a used-percent and a reset. Codex has
  `account/rateLimits/read` and pushes `account/rateLimits/updated` as they move.
  Nothing was reaching them because account notifications name no thread, and the
  router dropped anything it could not match to one; they now go to every thread on
  the connection. The limits are also read once at thread start, since the pushes
  only arrive when something changes.
- `session.compact` asks the agent to summarise and carry on, through the provider's
  own call (Codex: `thread/compact/start`). `ProviderStatus.compact` says who has one.
  Clients used to send the literal text "/compact", which is a command to Claude Code
  and an ordinary message to Codex — answered, convincingly, in prose.

All three are session state or a real command rather than text typed at an agent, so
a client reads them without asking and a second client sees the same thing.

## 0.1.5 - 2026-10-01

- The relay heartbeat pings every 15s instead of 25s, well inside the 60s pong timeout, so a
  single dropped packet no longer costs the whole connection — a real host saw its connection
  die at almost exactly the 60s mark, repeatedly, the signature of a NAT or proxy evicting an
  idle-looking connection around then.
- `termlink` checks npm once a day for a newer `@termlink/cli` and prints a one-line notice at
  startup if one is out. Never blocks or delays startup, and never throws on its own — offline,
  a slow registry or a malformed response just mean no notice that run.

## 0.1.4 - 2026-09-20

- A Claude session can start with `chrome: true` (`session.create`), spawning Claude Code
  with `--chrome` for browser control over an already-paired Chrome extension. Claude only;
  ignored by any other provider.
- Cursor is a provider (`cursor`, through `cursor-agent acp`): turns, items and edit approvals
  the same way Codex's app-server works, with its session resumable from a host restart.
  `--cursor-model` and `--cursor-mode` (`agent`, `plan` or `ask`) set defaults for new sessions.
  A file it edits shows with a path relative to the session's folder, the same as Claude's
  edits already do, instead of the host's own absolute path. A turn interrupt() gave up
  waiting on (10s) no longer risks folding a stray, late notification from it into whatever
  turn runs next.
- GitHub Copilot CLI is a provider (`copilot`, through `copilot --acp`), alongside Cursor and
  Codex. The same relative-path and stray-notification fixes as Cursor's apply here too.
- A session waiting out a usage-limit auto-retry (`rate_limited`) shows in `termlink`'s own
  status line. That wait does not survive a host restart (there is no stored turn text left
  to resend); a restart with one still armed says how many in its own startup line and the
  session just comes back without it. The wait is also cancelled the moment any turn starts,
  not just an explicit send — a message steered in too late to fold into its own turn, or any
  other turn a provider opens on its own, no longer leaves a stale rate-limit notice behind.
- `session.create` takes `resume`, a past session's own provider session id, so a client can
  reopen a session it closed on purpose and pick the same transcript back up instead of
  starting empty — not just after a host restart. `ProviderStatus.resumable` says which
  providers support it (Claude, Codex, Cursor and Copilot, today); a provider that doesn't
  refuses with `unsupported`.
- The Claude probe no longer calls a machine "not logged in" when it is actually running on
  an API key or a cloud provider's own credentials (Bedrock, Vertex, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`) instead of the OAuth `/login` that
  `claude auth status` reports on.

## 0.1.3 - 2026-09-17

- `fs.read` returns a file under the allowed folders, up to 10 MiB (`FS_READ_MAX_BYTES`), so a
  client can preview or save a file an agent mentioned, such as a screenshot it saved.
- `termlink` checks the Node.js version before it loads anything else. On a Node.js older
  than 22 it says which one it was started with and how to update, instead of installing
  with only npm's `EBADENGINE` warning and failing later.
- `termlink start` says what the host is doing instead of where it can be reached: it no
  longer prints the local server's URL and token or the relay's address. `--show-local-url`
  prints the local URL for development, and `--verbose` the relay connection details.
- On a terminal, a status line at the bottom shows the relay connection, the sessions and
  how to stop. Its dots move once a second, so a running host is easy to tell from a hung
  one. Sessions opening and closing are listed as they happen. Without a terminal (a
  service or a log file) the same events are written as plain lines with the time.
- Ctrl+C says that it is saving sessions and that a second Ctrl+C quits at once, and
  "Stopped." marks the end.
- Claude sessions: a message sent while Claude works no longer stays "queued" forever.
  A slash command sent then (such as `/model`) now reaches Claude Code as typed; before,
  the note added to steered messages became the command's arguments, and the command,
  which Claude Code runs after the turn with no reply, was never marked read. A
  command's result now marks it read, and a queued message is settled as soon as a
  later one has been taken, even if nothing named it.

## 0.1.2 - 2026-09-13

- Claude sessions: a turn that fails because Claude Code could not refresh the machine's shared
  sign-in (another Claude Code process held the lock) is sent again after 3 and 8 seconds
  instead of failing. The error shows only if every try fails. The host reports each retry as
  `provider.event` `claude.retry`.
- The package metadata now points to this repository.

## 0.1.1 - 2026-09-13

- File uploads into a session's folder (`upload.begin`, `upload.chunk`, `upload.end`,
  `upload.abort`).
- Messages sent while an agent works join the running turn, and report whether the agent has
  read them.
- Stop is reliable: a Claude Code process that does not end the turn in time is replaced on the
  same conversation.
- `fs.list` browses the host's folders when creating a session.
- Faster first response: streamed text is sent at once instead of after a batching window,
  thinking shows as soon as it starts, and a restored session starts its agent when a client
  opens it. `TERMLINK_TRACE=1` prints turn timings.

## 0.1.0 - 2026-09-12

- First release: terminal sessions in a PTY, Claude Code and Codex sessions, the TermLink relay
  link, `termlink login`, sessions restored after a host restart, and per-session auto-approve.
