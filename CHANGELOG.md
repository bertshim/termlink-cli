# Changelog

All three packages (`@termlink/cli`, `@termlink/protocol`, `@termlink/terminal`) share one
version number.

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
