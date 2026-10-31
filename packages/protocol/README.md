# @pahub/protocol

Shared types and zod schemas for the WebSocket protocol between the pahub service and the UI: chat items, summaries, settings, request/response/event envelopes, and the `methods` and `events` maps.

`PROTOCOL_VERSION` (currently `2`, since v1.2 added the bucket places and methods) is exchanged in the `hello` handshake. A UI and a service of different protocol versions do not talk; the UI offers to restart the service.

Tests: `pnpm --filter @pahub/protocol test`
