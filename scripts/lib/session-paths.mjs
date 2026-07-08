import { resolve, sep } from "node:path";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;

export class AskProInvalidSessionIdError extends Error {
  constructor(sessionId, reason) {
    super(`invalid session id ${JSON.stringify(sessionId)}: ${reason}`);
    this.name = "AskProInvalidSessionIdError";
    this.code = "ASK_PRO_INVALID_SESSION_ID";
  }
}

function isInside(parent, child) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

export function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new AskProInvalidSessionIdError(sessionId, "must be a non-empty string");
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AskProInvalidSessionIdError(sessionId, "must contain only letters, numbers, dot, underscore, colon, or dash");
  }
  if (sessionId === "." || sessionId === "..") {
    throw new AskProInvalidSessionIdError(sessionId, "must not be a relative path segment");
  }
  return sessionId;
}

export function sessionsRoot(root) {
  return resolve(root, "sessions");
}

export function sessionRoot(root, sessionId) {
  const base = sessionsRoot(root);
  const target = resolve(base, validateSessionId(sessionId));
  if (!isInside(base, target) || target === base) {
    throw new AskProInvalidSessionIdError(sessionId, "must stay inside the sessions directory");
  }
  return target;
}

export function sessionFile(root, sessionId, name) {
  const sessionDir = sessionRoot(root, sessionId);
  const target = resolve(sessionDir, name);
  if (!isInside(sessionDir, target)) {
    throw new AskProInvalidSessionIdError(sessionId, "session file must stay inside the session directory");
  }
  return target;
}

export function statePath(root, sessionId) {
  return sessionFile(root, sessionId, "state.json");
}

export function lockPath(root, sessionId) {
  return sessionFile(root, sessionId, ".lock");
}
