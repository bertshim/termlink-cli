# Changelog

All three packages (`@termlink/cli`, `@termlink/protocol`, `@termlink/terminal`) share one
version number.

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
