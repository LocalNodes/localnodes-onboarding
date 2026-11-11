// The shape of a pilot continue token (fresh3 23, pilot end): base64url of the
// sealed subscription id and end (server/utils/pilot-end.ts). Plain module,
// shared by the server, which opens the token, and the /pilot/continue page,
// which only checks the shape so a mangled link gets its message with no request.
export const PILOT_CONTINUE_TOKEN_RE = /^[A-Za-z0-9_-]{40,1024}$/

/** What the continue route answers. */
export type PilotContinueState = 'ends' | 'continued' | 'ended' | 'invalid' | 'unavailable'
