# @threadgarden/protocol

Shared types and zod schemas for the WebSocket protocol between the Threadgarden service and the UI: chat items, summaries, settings, request/response/event envelopes, and the `methods` and `events` maps.

`chat.status` and `chat.open` optionally include `promptSuggestion: {id, text} | null`. This transient prediction is separate from transcript items; null clears it, and `chat.since` replays it with the other status fields. The fields are optional so older services and clients can keep communicating without a protocol-version change.

`PROTOCOL_VERSION` (currently `3`, since v1.3 added usage limits, scheduled sends, project icons, agent details on tasks and appearance settings) is exchanged in the `hello` handshake. A UI and a service of different protocol versions do not talk; the UI offers to restart the service.

Tests: `pnpm --filter @threadgarden/protocol test`
