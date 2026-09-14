# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub:
open the **Security** tab of this repository and choose **Report a vulnerability**. Include the
version (`termlink --version`), your OS and Node.js version, and the steps to reproduce.

We will acknowledge the report, keep you updated while we work on it, and credit you in the
changelog if you wish.

## Supported versions

Fixes go into the latest published version of `@termlink/cli`, `@termlink/protocol` and
`@termlink/terminal`. Please update before reporting.

## Security model

This section describes what the host does and what it relies on, so you can decide whether it
fits your machine.

### The host acts as you

`termlink start` runs on your machine as your operating-system user. A session on it can do
what you can do there: a terminal session is your shell, and an agent session runs Claude Code
or Codex, which run tools and commands. Give access to the host the same care as access to an
SSH login.

### Who can reach it

- **Through the TermLink relay:** clients signed in to the TermLink account the host is signed
  in with (`termlink login`).
- **Through the local server:** anyone on the machine who has the token printed at start. It
  listens on `127.0.0.1` without TLS; the host warns if you bind it to another address.

### What the relay can see

The connections from the host to the relay and from your browser to the relay both use TLS.
The relay forwards frames without interpreting them, but it is not end-to-end encrypted: inside
the relay, session content is in plain text. That includes prompts, agent replies, commands and
their output, file diffs, terminal bytes and uploaded files. Someone who operates or
compromises a relay could read it. End-to-end encryption is not implemented.

### Folders

Sessions open only inside the allowed folders: the folder the host was started in, or those
given with `--allow-root`. Paths are compared after resolving symbolic links. This limits where a
session starts; it does not confine a shell or an agent, which can reach anything your user can.

### Approvals

Agent tool calls ask for approval according to the agent's own settings. `--auto-approve` and a
session's `autoApprove` mode let the host answer some approvals by itself. That is a convenience,
not a security boundary; the boundaries are your OS account and the agent's own sandbox and
permission rules. Questions and plan approvals always wait for a person.

### Credentials

- `termlink login` signs in with Google in your browser (PKCE with a loopback redirect). The
  Google tokens are not stored. The TermLink service then issues a device credential, saved to
  `~/.termlink/device.json` with mode 0600. It is a bearer token: anything that can read the
  file can act as this machine. `termlink logout` revokes it on the server and deletes the file;
  `termlink devices revoke` signs out other machines.
- The published package contains a Google OAuth client ID and secret of the "desktop app" type.
  Google does not treat such a secret as confidential; the sign-in flow is protected by PKCE,
  and the values grant nothing by themselves. They are filled in only when the package is
  built, and are empty in this repository.
- The host never reads, stores or forwards Claude or Codex credentials. Those tools use their
  own sign-in on your machine; the host only checks that it exists.

### Uploads

Files sent to a session are written to `<session folder>/.termlink/uploads/`. The `.termlink`
folder is created with mode 0700 and holds a `.gitignore` of `*`. File names are reduced to
their last path segment, and existing files are never overwritten. The limit is 25 MiB per file.
