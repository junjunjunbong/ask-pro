import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { lockPath, sessionRoot, statePath, validateSessionId } from "./session-paths.mjs";

export const SESSION_STATUSES = Object.freeze([
  "created",
  "packaged",
  "submitted",
  "waiting",
  "copied",
  "advice_summarized",
  "applied",
  "failed",
]);

const FIRST_CHECK_DELAY_MS = 5 * 60 * 1000;
const RETRY_CHECK_DELAY_MS = 60 * 1000;
const DEADLINE_DELAY_MS = 30 * 60 * 1000;
const LEGAL_TRANSITIONS = Object.freeze({
  created: ["packaged", "failed"],
  packaged: ["submitted", "failed"],
  submitted: ["waiting", "failed"],
  waiting: ["copied", "failed"],
  copied: ["advice_summarized", "failed"],
  advice_summarized: ["applied", "failed"],
  applied: [],
  failed: [],
});

export class AskProSessionLockedError extends Error {
  constructor(sessionId) {
    super(`session ${sessionId} locked`);
    this.name = "AskProSessionLockedError";
    this.code = "ASK_PRO_LOCKED";
  }
}

export class AskProInvalidSessionStateError extends Error {
  constructor(sessionId, reason) {
    super(`invalid session state for ${sessionId}: ${reason}`);
    this.name = "AskProInvalidSessionStateError";
    this.code = "ASK_PRO_INVALID_SESSION_STATE";
  }
}

function iso(value) {
  return value.toISOString();
}

function addMilliseconds(value, milliseconds) {
  return new Date(value.getTime() + milliseconds);
}

function timestampId(value) {
  return iso(value)
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/u, "Z");
}

async function writeSession(root, state) {
  await mkdir(sessionRoot(root, state.id), { recursive: true });
  await writeFile(statePath(root, state.id), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function assertKnownStatus(status) {
  if (!SESSION_STATUSES.includes(status)) {
    throw new Error(`invalid session status: ${status}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoDateString(value) {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function validateRequiredString(state, key, sessionId) {
  if (typeof state[key] !== "string" || state[key].length === 0) {
    throw new AskProInvalidSessionStateError(sessionId, `${key} must be a non-empty string`);
  }
}

function validateNullableString(state, key, sessionId) {
  if (state[key] !== null && typeof state[key] !== "string") {
    throw new AskProInvalidSessionStateError(sessionId, `${key} must be null or string`);
  }
}

function validateNullableIsoString(state, key, sessionId) {
  if (state[key] !== null && !isIsoDateString(state[key])) {
    throw new AskProInvalidSessionStateError(sessionId, `${key} must be null or ISO timestamp`);
  }
}

function validateSessionState(state, sessionId) {
  if (!isPlainObject(state)) {
    throw new AskProInvalidSessionStateError(sessionId, "state must be an object");
  }
  if (state.schema_version !== 1) {
    throw new AskProInvalidSessionStateError(sessionId, "schema_version must be 1");
  }
  if (state.id !== sessionId) {
    throw new AskProInvalidSessionStateError(sessionId, "id must match session id");
  }
  if (!SESSION_STATUSES.includes(state.status)) {
    throw new AskProInvalidSessionStateError(sessionId, `status is unknown: ${state.status}`);
  }
  if (!Number.isInteger(state.retry_count) || state.retry_count < 0) {
    throw new AskProInvalidSessionStateError(sessionId, "retry_count must be a non-negative integer");
  }

  validateRequiredString(state, "created_at", sessionId);
  if (!isIsoDateString(state.created_at)) {
    throw new AskProInvalidSessionStateError(sessionId, "created_at must be an ISO timestamp");
  }

  for (const key of ["submitted_at", "next_check_at", "deadline_at", "last_checked_at", "lock_started_at"]) {
    validateNullableIsoString(state, key, sessionId);
  }
  if (Object.hasOwn(state, "updated_at") && !isIsoDateString(state.updated_at)) {
    throw new AskProInvalidSessionStateError(sessionId, "updated_at must be an ISO timestamp");
  }
  if (state.lock_pid !== null && !Number.isInteger(state.lock_pid)) {
    throw new AskProInvalidSessionStateError(sessionId, "lock_pid must be null or integer");
  }
  for (const key of [
    "zip_path",
    "manifest_path",
    "transcript_path",
    "advice_summary_path",
    "apply_summary_path",
  ]) {
    validateNullableString(state, key, sessionId);
  }

  return state;
}

function assertLegalTransition(from, to) {
  assertKnownStatus(to);
  if (!LEGAL_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`illegal session transition: ${from} -> ${to}`);
  }
}

export function generateSessionId({ now, token = randomBytes(3).toString("hex") }) {
  return `${timestampId(now)}-${token}`;
}

export async function createSession({ root, now, token, sessionId }) {
  const id = validateSessionId(sessionId ?? generateSessionId({ now, token }));
  try {
    return await readSession({ root, sessionId: id });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return writeSession(root, {
    schema_version: 1,
    id,
    status: "created",
    created_at: iso(now),
    submitted_at: null,
    next_check_at: null,
    deadline_at: null,
    retry_count: 0,
    last_checked_at: null,
    lock_pid: null,
    lock_started_at: null,
    zip_path: null,
    manifest_path: null,
    transcript_path: null,
    advice_summary_path: null,
    apply_summary_path: null,
  });
}

export async function readSession({ root, sessionId }) {
  const state = JSON.parse(await readFile(statePath(root, sessionId), "utf8"));
  return validateSessionState(state, sessionId);
}

export async function submitSession({ root, sessionId, now }) {
  const current = await readSession({ root, sessionId });
  assertLegalTransition(current.status, "submitted");
  return writeSession(root, {
    ...current,
    status: "submitted",
    submitted_at: iso(now),
    next_check_at: iso(addMilliseconds(now, FIRST_CHECK_DELAY_MS)),
    deadline_at: iso(addMilliseconds(now, DEADLINE_DELAY_MS)),
    retry_count: 0,
  });
}

export async function recordWaitingCheck({ root, sessionId, now }) {
  const current = await readSession({ root, sessionId });
  const checkedAt = iso(now);
  if (current.last_checked_at !== null && now.getTime() <= new Date(current.last_checked_at).getTime()) {
    return current;
  }

  if (current.status !== "submitted" && current.status !== "waiting") {
    throw new Error(`illegal session check while ${current.status}`);
  }

  if (current.deadline_at !== null && now.getTime() >= new Date(current.deadline_at).getTime()) {
    return writeSession(root, {
      ...current,
      status: "failed",
      last_checked_at: checkedAt,
      next_check_at: null,
      retry_count: current.retry_count + 1,
    });
  }

  return writeSession(root, {
    ...current,
    status: "waiting",
    last_checked_at: checkedAt,
    next_check_at: iso(addMilliseconds(now, RETRY_CHECK_DELAY_MS)),
    retry_count: current.retry_count + 1,
  });
}

export async function transitionSession({ root, sessionId, status, now }) {
  const current = await readSession({ root, sessionId });
  assertLegalTransition(current.status, status);
  return writeSession(root, {
    ...current,
    status,
    last_checked_at: current.last_checked_at,
    updated_at: iso(now),
  });
}

export async function acquireSessionLock({ root, sessionId, now, pid = process.pid }) {
  try {
    await mkdir(lockPath(root, sessionId));
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new AskProSessionLockedError(sessionId);
    }
    throw error;
  }

  const current = await readSession({ root, sessionId });
  await writeSession(root, {
    ...current,
    lock_pid: pid,
    lock_started_at: iso(now),
  });

  return { root, sessionId, path: lockPath(root, sessionId) };
}

export async function releaseSessionLock(lock) {
  await rm(lock.path, { recursive: true, force: true });
  const current = await readSession({ root: lock.root, sessionId: lock.sessionId });
  await writeSession(lock.root, {
    ...current,
    lock_pid: null,
    lock_started_at: null,
  });
}
