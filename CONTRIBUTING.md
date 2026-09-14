# Contributing

This repository is the public source of each TermLink CLI release: `@termlink/cli`,
`@termlink/protocol` and `@termlink/terminal`. Development happens in a private repository, and
each release is published here as one commit with a tag, so the code here matches what is on
npm.

## Issues

Bug reports and feature requests are welcome. Please include:

- the versions: `termlink --version`, `node --version`, and your operating system;
- what you did, what you expected, and what happened;
- for agent sessions, which agent (Claude Code or Codex) and its version.

Security problems go through private reporting instead; see [SECURITY.md](SECURITY.md).

## Pull requests

Please open an issue before a pull request, so we can agree on the change first. Because the
code here is generated from the private repository, an accepted change is applied there and
appears here in the next release, credited in the [changelog](CHANGELOG.md). The pull request
itself is then closed rather than merged.

Contributions are made under the [MIT License](LICENSE).

## Building from source

Requires Node.js 22 or later.

```sh
npm install
npm run typecheck
npm test
npm run build
```
