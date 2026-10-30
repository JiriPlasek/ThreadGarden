# @pahub/protocol

Shared types and zod schemas for the WebSocket protocol between the pahub service and the UI: chat items, summaries, settings, request/response/event envelopes, and the `methods` and `events` maps.

`PROTOCOL_VERSION` (currently `1`) is exchanged in the `hello` handshake.

Tests: `pnpm --filter @pahub/protocol test`
