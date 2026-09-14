# @termlink/protocol

The wire protocol between a TermLink host (`@termlink/cli`) and its clients: command,
response and event schemas (zod), the chunk codec for messages over the relay's frame
limit, and the binary frame codec for terminal bytes. The TermLink web app uses the
same package, so both sides parse and frame the same way.

The protocol itself is described in [PROTOCOL.md](https://github.com/bertshim/termlink-cli/blob/main/PROTOCOL.md).
