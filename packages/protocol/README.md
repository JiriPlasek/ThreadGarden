# @pahub/protocol

Shared types and zod schemas for the WebSocket protocol between the Threadgarden service and the UI: chat items, summaries, settings, request/response/event envelopes, and the `methods` and `events` maps.

`PROTOCOL_VERSION` (currently `3`, since v1.3 added the usage and scheduled-send methods) is exchanged in the `hello` handshake. A UI and a service of different protocol versions do not talk; the UI offers to restart the service.

Tests: `pnpm --filter @pahub/protocol test`
