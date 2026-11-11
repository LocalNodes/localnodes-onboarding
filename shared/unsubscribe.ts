// The shape of an unsubscribe token (fresh3 23-19): base64url of the sealed
// address and list (server/utils/unsubscribe.ts). Plain module, shared by the
// server, which opens the token, and the /unsubscribe page, which only checks
// the shape so a mangled link gets its message with no request.
export const UNSUBSCRIBE_TOKEN_RE = /^[A-Za-z0-9_-]{40,1024}$/
