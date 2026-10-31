/**
 * The WebSocket protocol version, exchanged in `hello`. A UI and a service of
 * different versions do not talk: the UI offers to restart the service.
 * 2 (v1.2): the bucket places and methods, which a v1.1 service rejects.
 * 3 (v1.3): usage limits and scheduled sends (`usage.*`, `scheduled.*`),
 *   project icons (`projects.icon`), agent details on tasks and appearance
 *   settings.
 */
export const PROTOCOL_VERSION = 3;
