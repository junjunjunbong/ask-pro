import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireSessionLock,
  createSession,
  readSession,
  recordWaitingCheck,
  releaseSessionLock,
  submitSession,
  transitionSession,
} from "../scripts/lib/session-store.mjs";

test("session submit and check sequence uses deterministic schedule", async () => {
  // Given: a fresh store and injected clock values.
  const root = await mkdtemp(join(tmpdir(), "ask-pro-session-"));
  const now = new Date("2026-07-08T10:00:00.000Z");

  try {
    const created = await createSession({ root, now, token: "abc123" });
    await transitionSession({ root, sessionId: created.id, status: "packaged", now });

    // When: the session is submitted, then checked once while waiting.
    const submitted = await submitSession({ root, sessionId: created.id, now });
    const checked = await recordWaitingCheck({
      root,
      sessionId: created.id,
      now: new Date("2026-07-08T10:05:00.000Z"),
    });

    // Then: first due is +5m, retry due is +1m, deadline is +30m.
    assert.equal(created.id, "20260708T100000Z-abc123");
    assert.equal(created.status, "created");
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.submitted_at, "2026-07-08T10:00:00.000Z");
    assert.equal(submitted.next_check_at, "2026-07-08T10:05:00.000Z");
    assert.equal(submitted.deadline_at, "2026-07-08T10:30:00.000Z");
    assert.equal(submitted.retry_count, 0);
    assert.equal(checked.last_checked_at, "2026-07-08T10:05:00.000Z");
    assert.equal(checked.next_check_at, "2026-07-08T10:06:00.000Z");
    assert.equal(checked.retry_count, 1);
    assert.deepEqual((await readSession({ root, sessionId: created.id })).retry_count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creating an existing session id returns the persisted state unchanged", async () => {
  // Given: a session id whose state has already advanced after creation.
  const root = await mkdtemp(join(tmpdir(), "ask-pro-create-idempotent-"));
  const sessionId = "ask-pro-existing-session";
  const createdAt = new Date("2026-07-08T10:00:00.000Z");

  try {
    const created = await createSession({ root, now: createdAt, sessionId });
    await transitionSession({ root, sessionId: created.id, status: "packaged", now: createdAt });
    const beforeDuplicateCreate = await readSession({ root, sessionId });

    // When: the same session id is created again with a later clock value.
    const duplicateCreate = await createSession({
      root,
      now: new Date("2026-07-08T11:00:00.000Z"),
      sessionId,
    });
    const afterDuplicateCreate = await readSession({ root, sessionId });

    // Then: the duplicate create is a no-op and does not overwrite state.
    assert.deepEqual(duplicateCreate, beforeDuplicateCreate);
    assert.deepEqual(afterDuplicateCreate, beforeDuplicateCreate);
    assert.equal(afterDuplicateCreate.created_at, "2026-07-08T10:00:00.000Z");
    assert.equal(afterDuplicateCreate.status, "packaged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted malformed session shape is rejected at the storage boundary", async () => {
  // Given: valid JSON exists for the session, but the persisted shape is corrupt.
  const root = await mkdtemp(join(tmpdir(), "ask-pro-malformed-state-"));
  const sessionId = "shape-bad";
  const sessionPath = join(root, "sessions", sessionId);

  try {
    await mkdir(sessionPath, { recursive: true });
    await writeFile(
      join(sessionPath, "state.json"),
      `${JSON.stringify({ status: "bogus", retry_count: "not-a-number" })}\n`,
    );

    // When/Then: neither direct reads nor duplicate-create idempotency accept the corrupt state.
    await assert.rejects(
      () => readSession({ root, sessionId }),
      (error) => error?.code === "ASK_PRO_INVALID_SESSION_STATE",
    );
    await assert.rejects(
      () => createSession({ root, now: new Date("2026-07-08T10:00:00.000Z"), sessionId }),
      (error) => error?.code === "ASK_PRO_INVALID_SESSION_STATE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recording the same waiting check timestamp twice is idempotent", async () => {
  // Given: a submitted session due for its first check.
  const root = await mkdtemp(join(tmpdir(), "ask-pro-check-idempotent-"));
  const now = new Date("2026-07-08T10:00:00.000Z");
  const checkTime = new Date("2026-07-08T10:05:00.000Z");

  try {
    const created = await createSession({ root, now, token: "idem00" });
    await transitionSession({ root, sessionId: created.id, status: "packaged", now });
    await submitSession({ root, sessionId: created.id, now });
    const firstCheck = await recordWaitingCheck({ root, sessionId: created.id, now: checkTime });

    // When: the same check is replayed after a cancel/resume or retry.
    const duplicateCheck = await recordWaitingCheck({ root, sessionId: created.id, now: checkTime });
    const persisted = await readSession({ root, sessionId: created.id });

    // Then: retry count, last check time, and next schedule do not drift.
    assert.deepEqual(duplicateCheck, firstCheck);
    assert.deepEqual(persisted, firstCheck);
    assert.equal(persisted.retry_count, 1);
    assert.equal(persisted.last_checked_at, "2026-07-08T10:05:00.000Z");
    assert.equal(persisted.next_check_at, "2026-07-08T10:06:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recording an older waiting check after resume is an idempotent no-op", async () => {
  // Given: a submitted session that has already recorded a newer waiting check.
  const root = await mkdtemp(join(tmpdir(), "ask-pro-check-stale-"));
  const now = new Date("2026-07-08T10:00:00.000Z");

  try {
    const created = await createSession({ root, now, token: "stale0" });
    await transitionSession({ root, sessionId: created.id, status: "packaged", now });
    await submitSession({ root, sessionId: created.id, now });
    const newerCheck = await recordWaitingCheck({
      root,
      sessionId: created.id,
      now: new Date("2026-07-08T10:05:00.000Z"),
    });

    // When: an older check is replayed after cancel/resume or out-of-order execution.
    const staleCheck = await recordWaitingCheck({
      root,
      sessionId: created.id,
      now: new Date("2026-07-08T10:04:00.000Z"),
    });
    const persisted = await readSession({ root, sessionId: created.id });

    // Then: retry count, last check time, and next schedule remain unchanged.
    assert.deepEqual(staleCheck, newerCheck);
    assert.deepEqual(persisted, newerCheck);
    assert.equal(persisted.retry_count, 1);
    assert.equal(persisted.last_checked_at, "2026-07-08T10:05:00.000Z");
    assert.equal(persisted.next_check_at, "2026-07-08T10:06:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session state machine allows full success path", async () => {
  // Given: a submitted session.
  const root = await mkdtemp(join(tmpdir(), "ask-pro-success-"));
  const now = new Date("2026-07-08T10:00:00.000Z");

  try {
    const created = await createSession({ root, now, token: "path00" });

    // When: the state advances along the complete successful path.
    const packaged = await transitionSession({ root, sessionId: created.id, status: "packaged", now });
    const submitted = await submitSession({ root, sessionId: created.id, now });
    const waiting = await recordWaitingCheck({
      root,
      sessionId: created.id,
      now: new Date("2026-07-08T10:05:00.000Z"),
    });
    const copied = await transitionSession({ root, sessionId: created.id, status: "copied", now });
    const summarized = await transitionSession({ root, sessionId: created.id, status: "advice_summarized", now });
    const applied = await transitionSession({ root, sessionId: created.id, status: "applied", now });

    // Then: every required status is represented in order.
    assert.deepEqual(
      [created, packaged, submitted, waiting, copied, summarized, applied].map((state) => state.status),
      ["created", "packaged", "submitted", "waiting", "copied", "advice_summarized", "applied"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session state machine allows failed path", async () => {
  // Given: a packaged session.
  const root = await mkdtemp(join(tmpdir(), "ask-pro-failed-"));
  const now = new Date("2026-07-08T10:00:00.000Z");

  try {
    const created = await createSession({ root, now, token: "fail00" });
    await transitionSession({ root, sessionId: created.id, status: "packaged", now });

    // When: a recoverable in-flight status moves to failed.
    const failed = await transitionSession({ root, sessionId: created.id, status: "failed", now });

    // Then: the failed terminal status is persisted.
    assert.equal(failed.status, "failed");
    assert.equal((await readSession({ root, sessionId: created.id })).status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session check at deadline fails without scheduling another retry", async () => {
  // Given: a submitted session with a 30 minute deadline.
  const root = await mkdtemp(join(tmpdir(), "ask-pro-deadline-"));
  const now = new Date("2026-07-08T10:00:00.000Z");

  try {
    const created = await createSession({ root, now, token: "late00" });
    await transitionSession({ root, sessionId: created.id, status: "packaged", now });
    await submitSession({ root, sessionId: created.id, now });

    // When: the next check is stale beyond the deadline.
    const checked = await recordWaitingCheck({
      root,
      sessionId: created.id,
      now: new Date("2026-07-08T10:31:00.000Z"),
    });

    // Then: it fails and does not schedule another future check.
    assert.equal(checked.status, "failed");
    assert.equal(checked.last_checked_at, "2026-07-08T10:31:00.000Z");
    assert.equal(checked.next_check_at, null);
    assert.equal((await readSession({ root, sessionId: created.id })).status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session state machine rejects arbitrary jumps", async () => {
  // Given: a newly created session.
  const root = await mkdtemp(join(tmpdir(), "ask-pro-illegal-"));
  const now = new Date("2026-07-08T10:00:00.000Z");

  try {
    const created = await createSession({ root, now, token: "jump00" });

    // When/Then: created cannot jump straight to applied.
    await assert.rejects(
      () => transitionSession({ root, sessionId: created.id, status: "applied", now }),
      /illegal session transition: created -> applied/,
    );
    assert.equal((await readSession({ root, sessionId: created.id })).status, "created");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session lock rejects concurrent acquisition and releases cleanly", async () => {
  // Given: a fresh store and session id.
  const root = await mkdtemp(join(tmpdir(), "ask-pro-lock-"));
  const now = new Date("2026-07-08T10:00:00.000Z");

  try {
    const session = await createSession({ root, now, token: "lock00" });

    // When: one process has acquired the session lock.
    const lock = await acquireSessionLock({ root, sessionId: session.id, now, pid: 111 });

    // Then: a concurrent acquisition fails with a typed locked error.
    await assert.rejects(
      () => acquireSessionLock({ root, sessionId: session.id, now, pid: 222 }),
      (error) => error?.code === "ASK_PRO_LOCKED" && /locked/.test(error.message),
    );

    await releaseSessionLock(lock);
    const reacquired = await acquireSessionLock({ root, sessionId: session.id, now, pid: 333 });
    await releaseSessionLock(reacquired);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
