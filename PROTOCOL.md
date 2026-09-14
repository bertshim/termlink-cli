# TermLink host protocol, version 1

This is the protocol between a TermLink host (`@termlink/cli`, the `termlink` command) and
its clients, such as the TermLink web app. The zod schemas in
[`packages/protocol/src`](packages/protocol/src) are the normative definition; this document
explains how the pieces fit together. A client written against `@termlink/protocol` parses and
frames messages the same way the host does.

Every JSON message carries `"v": 1`. A receiver ignores message `type`s it does not know, so a
host can add events without breaking older clients.

## Transports

A client reaches a host in one of two ways. Both carry the same messages.

- **The TermLink relay.** The host keeps one WebSocket open to the relay, and the relay merges
  every client of that host into it. The relay forwards frames without interpreting them, and
  it broadcasts whatever the host sends to all of that host's clients. So every message that
  concerns a session names the session (`sessionId`), and a client drops what is not for it.
  A relay frame is at most 64 KiB; larger messages travel as chunks (see "Chunks").
- **The local server**, `ws://127.0.0.1:7420/ws?token=<token>`, for development and for
  clients on the same machine. It checks the token and has no TLS, so it listens on loopback.

Text frames carry JSON messages. Binary frames carry terminal bytes (see "Terminal sessions").

## Message kinds

| kind | direction | meaning |
| --- | --- | --- |
| `cmd` | client to host | A request, with a `reqId` the client chooses |
| `res` | host to client | The answer to one request, with the same `reqId` |
| `evt` | host to client | An event |
| `chunk` | both | A piece of a message too large for one frame |

```jsonc
{ "v": 1, "kind": "cmd", "reqId": "c-1", "type": "session.send",
  "payload": { "sessionId": "ag_x", "input": { "text": "Run the tests" } } }

{ "v": 1, "kind": "res", "reqId": "c-1", "ok": true, "result": {} }
{ "v": 1, "kind": "res", "reqId": "c-2", "ok": false,
  "error": { "code": "not_found", "message": "no session ag_y" } }
```

Error codes: `bad_request`, `forbidden`, `not_found`, `conflict`, `unsupported`, `internal`.

## Events

```jsonc
{ "v": 1, "kind": "evt", "type": "item.completed", "ts": 1789071300123,
  "sessionId": "ag_x", "seq": 12, "payload": { } }
```

- `sessionId` is present on every event about a session.
- `seq` is present on durable events only. It starts at 1 for each session and grows by one,
  with no gaps. A client remembers the last `seq` it saw per session, to catch up later.

| type | about | seq | meaning |
| --- | --- | --- | --- |
| `host.ready` | host | - | Sent when a client connects: host info, provider status, allowed folders (`roots`). Over the relay it is sent again whenever a new client joins |
| `session.created` / `session.updated` / `session.closed` | host | - | Sent to every client. The payload is a session snapshot |
| `turn.started` | session | yes | `userItemId`: the user message that opened this turn |
| `turn.completed` | session | yes | `status`: `completed`, `interrupted` or `failed`; `usage`; `error` when failed |
| `item.started` | session | yes | An item in progress |
| `item.delta` | session | - | Text to append to an item's `text` or `output` field |
| `item.updated` | session | - | A full snapshot of an item in progress, used to catch up after attaching |
| `item.completed` | session | yes | An item's final state. May come without `item.started` (user messages) |
| `input.required` | session | yes | The turn waits for a person to answer |
| `input.resolved` | session | yes | `by`: `user`, `policy` or `host` |
| `error` | session | yes | Something went wrong outside a turn's own result |
| `provider.event` | session | - | Provider-specific information with no common shape yet. Safe to ignore |
| `terminal.size` / `terminal.reset` | session | - | Terminal sessions (see "Terminal sessions") |

A user message goes out first as `item.completed` with `turnId: null`; the `turn.started` right
after it names it in `userItemId`.

`provider.event` names in use: `claude.compacted` (Claude Code compacted the conversation),
`claude.restarted` (a Stop replaced an unresponsive Claude Code process on the same
conversation), `claude.retry` (the host is sending a turn's message again because Claude Code
could not refresh the machine's shared login; `data`: `reason`, `attempt`, `delayMs`).

## Items

| kind | main fields | what it is |
| --- | --- | --- |
| `message` | `role`, `text` | A user message or an assistant reply |
| `reasoning` | `text` | The agent thinking. `text` may stay empty when the provider omits it |
| `command` | `command`, `display`, `cwd`, `output`, `exitCode` | A shell command the agent runs |
| `file_change` | `changes[]` with `path`, `action`, `diff` | Files the agent edits |
| `tool` | `name`, `input`, `output` | Any other tool call |
| `todo` | `entries[]` | The agent's task list |

`status`: `in_progress`, `completed`, `failed`, `declined`, `interrupted`. Host and clients apply
deltas with the same function, `applyDelta()`.

`command.display` is a short form for a timeline: the host strips wrappers such as
`powershell -Command '...'` or `sh -lc '...'`. An approval request always carries the full
command, because what a person approves must be the string that will run.

## Commands

| type | payload | result |
| --- | --- | --- |
| `host.info` | `{}` | HostInfo |
| `session.list` | `{}` | `{sessions}` |
| `session.create` | `{provider, cwd, title?, autoApprove?, cols?, rows?, clientId?}` | `{session}`. The creating connection is attached. A relative `cwd` resolves against `roots[0]`. `cols`, `rows` and `clientId` are for terminals |
| `session.attach` | `{sessionId, afterSeq?, clientId?}` | `{session, gap, oldestSeq, replayed}` |
| `session.detach` | `{sessionId}` | `{}` |
| `session.send` | `{sessionId, input: {text, id?}}` | `{}` once the host has taken the message. The turn itself is reported through events |
| `session.interrupt` | `{sessionId}` | `{}` after `turn.completed` has gone out |
| `session.close` | `{sessionId}` | `{}` |
| `session.configure` | `{sessionId, autoApprove?}` | `{session}` |
| `input.respond` | `{sessionId, requestId, decisionId, answers?}` | `{}` |
| `terminal.resize` | `{sessionId, cols, rows}` | `{session}` |
| `terminal.ack` | `{sessionId, clientId, bytes}` | `{}` |
| `terminal.kill` | `{sessionId}` | `{}` |
| `upload.begin` | `{sessionId, name, size}` | `{uploadId, name}` |
| `upload.chunk` | `{uploadId, offset, data}` | `{received}` |
| `upload.end` | `{uploadId}` | `{path, name, size}` |
| `upload.abort` | `{uploadId}` | `{}` |
| `fs.list` | `{path?}` | `{path, parent, entries}` |

`HostInfo` is `{hostId, name, version, protocol, os, providers[], roots?}`. Each provider is
`{id, kind, label, available, version, detail, steer?}`; `kind` is `terminal` or `agent`.

## Allowed folders

Remote clients choose the folder a session opens in, so the host limits it (`HostInfo.roots`).
By default that is the folder the host was started in; `--allow-root <dir>` changes or adds
folders. Paths are compared after resolving symbolic links; a folder outside them is
`forbidden`. This limits where a session starts, not what a shell or an agent can reach
afterwards.

## Browsing folders

`fs.list` shows the subfolders of one folder, so a client can pick a `session.create` `cwd`
instead of typing it. It makes the same allowed-folder check as `session.create`.

- Without `path` it starts at `roots[0]`, or at the home folder on a host without roots.
- `entries` are sorted by name. Hidden folders (starting with `.`), files and symbolic links are
  left out.
- `parent` is the folder one level up, or `null` at an allowed root or the filesystem root.
- A file, a missing path or a path outside the allowed folders gets the same errors as
  `session.create`.

## Chunks

A message larger than one relay frame is split, in both directions.

```jsonc
{ "v": 1, "kind": "chunk", "id": "ck_x", "index": 0, "total": 3, "data": "..." }
```

Joining `data` in `index` order gives the original message's JSON text. `encodeFrames()` splits
it into frames of at most 60 KiB of UTF-8; `FrameAssembler` puts them back together in any
order and drops a message whose pieces do not all arrive within 60 seconds. The local server
accepts chunks too, so one client works with both transports.

## Attaching and reconnecting

1. A client remembers, per session, the last `seq` it received.
2. After reconnecting it sends `session.attach {sessionId, afterSeq}`.
3. The host sends the response first, then the durable events it missed in order, then an
   `item.updated` for each item still in progress, then live events. Nothing else comes in
   between.
4. `gap: true` means part of the requested range has left the host's buffer. The client clears
   that session and redraws it from what it receives. Any `input.required` still waiting is
   sent again even if it had left the buffer.
5. `seq` only continues while the host keeps running. After a host restart sessions come back
   with the same `id`, but `seq` starts again at 1. A client that sees a new
   `host.ready.payload.hostId` forgets its `seq` values and attaches with `afterSeq: 0`. If
   `afterSeq` is past the session's last `seq`, the host answers `gap: true` and sends
   everything.

The buffer keeps 2000 durable events per session. Deltas are not kept. After a host restart the
earlier conversation is read back from the provider's own transcript.

## Approvals

- The host sends the choices as `decisions[]`; a client answers with a `decisionId` only.
- Each decision has an `effect` (`allow`, `allow_session`, `deny`, `cancel`), which a client can
  use to style its buttons.
- When a turn is stopped or a session closes, the host sends
  `input.resolved {effect: "cancel", by: "host"}`.

### Auto-approve

Each agent session has a mode for answering approvals by itself (`SessionInfo.autoApprove`).

| mode | answers by itself |
| --- | --- |
| `off` | nothing (default) |
| `edits` | `file_approval` |
| `all` | `command_approval`, `file_approval`, `tool_approval` |

- `question` and `plan_approval` always wait for a person, in every mode.
- The policy picks the one decision whose `effect` is `allow`. It never picks `allow_session`.
- The request is still recorded: `input.required` is followed at once by
  `input.resolved {by: "policy"}`.
- The mode is set with `session.create {autoApprove}` or changed with `session.configure`; a
  change also applies to requests already waiting. The host's default comes from
  `--auto-approve`.
- It is a convenience, not a security boundary.

## Session status

`starting`, then `idle`, `running`, `waiting_input` and `interrupting`, and at any time `closed`.
The host computes it: `idle` with no turn, `interrupting` from a Stop until the turn ends,
`waiting_input` while an approval waits, `running` otherwise.

- `session.send` is handled in order per session. The next message looks at "is a turn
  running?" only after the previous one has opened its turn, so messages sent in quick
  succession open one turn and join it.
- A `session.send` during `interrupting` is held until the turn has ended and then opens the
  next turn; its response comes then.
- `session.send.input.id`, if given, becomes the user message item's `id`. A client that draws
  the message before sending uses it to match the host's copy with its own. It must be unique
  within the client.
- `session.send` and `session.interrupt` on a closed session are `conflict`.

## Messages during a turn

A client may send `session.send` while a turn runs. The message joins the running turn instead
of starting a new one, and the agent reads it at its next step. Only providers with
`steer: true` in `host.ready` accept this; the others answer `conflict`.

- The host emits the user message as `item.completed` with the running turn's `turnId` once the
  provider has taken it. No `turn.started` follows.
- That item carries `steer: "queued"`. When the agent has read it, the same item is sent again
  with `steer: "read"`; if a Stop discards it first, with `steer: "dropped"`.
  `SessionInfo.queued` counts the messages not read yet, and every change sends
  `session.updated`.
- A message that arrives too late to join the turn runs as a turn of its own afterwards. That
  `turn.started` has no `userItemId`.
- While the turn is being opened (before `turn.started`) the answer is `conflict`.

## Stop

`session.interrupt` ends the running turn and answers within a bounded time.

1. Approvals still waiting are cancelled (`input.resolved {by: "host"}`).
2. The agent is asked to stop. Messages sent during the turn and not read yet are dropped with
   it.
3. The turn ends as `turn.completed {status: "interrupted"}`. Items it left open end as
   `interrupted`.
4. If the agent does not end the turn in time, the host replaces its process with a new one on
   the same conversation (`provider.event` `claude.restarted` for Claude) and ends the turn
   itself. What was said before the Stop is kept.

## File uploads

A client can send a file into a session's folder, where the agent or the shell can open it. The
host saves it as `<session folder>/.termlink/uploads/<name>` and answers with the absolute
path. For an agent session a client puts that path into the next message; for a terminal
session it types the path at the prompt without running anything.

1. `upload.begin {sessionId, name, size}` returns `{uploadId, name}`. A file over 25 MiB
   (`UPLOAD_MAX_BYTES`) is `bad_request`.
2. `upload.chunk {uploadId, offset, data}`, with `data` the base64 of the bytes at `offset`.
   Several may be in flight at once and arrive in any order; each gets its own response, and
   limiting the responses a client waits for is the flow control. 32 KiB of bytes is about
   44 KB of base64, one relay frame. The host takes chunks of up to 512 KiB
   (`UPLOAD_MAX_CHUNK_BYTES`).
3. After every chunk has been answered, `upload.end` returns `{path, name, size}`. If the byte
   count differs from `size`, the file is deleted and the answer is `bad_request`.
4. On failure or cancel, `upload.abort`. The partial file is deleted. Aborting an unknown or
   finished upload is not an error.

- The session decides the folder; the client only names the file. The host keeps the last path
  segment of the name, replaces control characters and characters Windows refuses with `_`, and
  never overwrites: a taken name becomes `name (1).ext`.
- `.termlink/` is created with mode 0700 and holds a `.gitignore` of `*`. The user's own
  `.gitignore` is never touched.
- An upload with no chunk for 60 seconds is dropped with its partial file.

## Terminal sessions

A terminal is like an ssh login: the user's shell runs in a PTY and its bytes flow both ways.
The host does not interpret them.

- `session.create` with `provider: "terminal"` and optionally `cols` and `rows` (80x24 by
  default) and `clientId`. The session has `kind: "terminal"`, `cols`, `rows` and `pid`. The
  creating connection is attached.
- Status is `starting`, `running`, then `closed`. When the shell exits, `session.closed` carries
  `exitCode` and the host forgets the session.
- There is no `seq` and no replay log; reconnecting is described below. Terminals do not survive
  a host restart.
- There is no approval step: a person types every command.

### Bytes: binary frames

Terminal bytes travel in WebSocket binary frames, not as base64 in JSON.

```
byte 0     kind: 1 = output (host to client), 2 = input (client to host)
byte 1     length n of the session id
byte 2..   the session id (n ASCII bytes)
the rest   PTY bytes, unchanged
```

Every frame names its session because the relay merges all clients into one host socket.
Payloads are cut to at most 60 KiB per frame (`encodeTerminalFrames`). It is a byte stream,
so there is nothing to reassemble; within one connection, text and binary frames stay in order.
Ctrl+C is not a command but the byte 0x03. Input for a session the connection is not attached to
is dropped.

### Control

| command | meaning |
| --- | --- |
| `terminal.resize` | `cols`, `rows`. The last client to send one wins. Everyone gets `terminal.size` |
| `terminal.ack` | `clientId`, `bytes`: the total bytes this client has written into its terminal since it attached. Used for flow control |
| `terminal.kill` | Ends the shell process |

Events: `terminal.size` (the size changed) and `terminal.reset` (clear the screen; the full
screen follows as output). Neither has a `seq`.

### Attaching

The host also feeds the PTY output to a headless terminal and keeps the screen and scrollback
(5000 lines by default) in memory. After the `session.attach` response the host pauses the PTY,
sends `terminal.reset`, sends the current screen as output frames, and resumes the PTY, so the
snapshot and the stream after it never overlap. The relay cannot tell clients apart, so every
attached client gets the reset and redraws the same screen. A client answers `terminal.reset`
with a reset of its terminal and writes the bytes that follow.

### Flow control

The relay disconnects a client that cannot keep up, so the host pauses the PTY when a client
falls behind.

- A client reports with `terminal.ack` how much it has actually written into its terminal (for
  example every 32 KiB or every 100 ms).
- The host counts, per `clientId`, the bytes sent since attaching minus the bytes acknowledged.
  When the slowest client is more than 512 KiB behind the PTY pauses; below 128 KiB it resumes.
- A client that acknowledges nothing for 5 seconds is left out of the count, so a dead tab
  cannot stop a shell forever.
- A client attached without `clientId` takes no part in flow control.
