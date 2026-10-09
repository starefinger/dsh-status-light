/**
 * dsh-session-status — node half.
 *
 * Pure client-plugin bundle: the host side has no behavior of its own. The
 * empty `apply` exists so this package appears as a live Loader entry in the
 * profile's composed tree; the browser half (exports["./client"]) is then
 * discovered by the client-modules scanner because package.json declares
 * `dsh.client.platform: "web"`.
 *
 * @module dsh-session-status
 */
export function apply() {}
