/**
 * The WebSocket protocol version, exchanged in `hello`. A UI and a service of
 * different versions do not talk: the UI offers to restart the service.
 * 2 (v1.2): the bucket places and methods, which a v1.1 service rejects.
 * 3 (v1.3): usage limits and scheduled sends (`usage.*`, `scheduled.*`),
 *   project icons (`projects.icon`), agent details on tasks and appearance
 *   settings.
 * 4 (v1.3, the rename): the `threadgarden.<token>` subprotocol and the
 *   `threadgarden` data dir. A pahub service (3) is restarted, and the new
 *   one copies pahub's data over as it starts.
 */
export const PROTOCOL_VERSION = 4;
