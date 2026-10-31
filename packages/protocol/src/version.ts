/**
 * The WebSocket protocol version, exchanged in `hello`. A UI and a service of
 * different versions do not talk: the UI offers to restart the service.
 * 2 (v1.2): the bucket places and methods, which a v1.1 service rejects.
 */
export const PROTOCOL_VERSION = 2;
