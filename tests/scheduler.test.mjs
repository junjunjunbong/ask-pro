import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  AskProSchedulerInputError,
  planDelayedRetrievalSchedule,
} from "../scripts/lib/scheduler.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const command = join(root, "scripts/ask-pro.mjs");

function fixtureArgs(options) {
  return [
    command,
    "scheduler-fixture",
    "--session-id",
    options.sessionId,
    "--submitted-at",
    options.submittedAt,
    "--now",
    options.now,
    "--automation",
    options.automation,
  ];
}

test("first scheduler pass creates one-shot wakeup five minutes after submission", () => {
  const result = planDelayedRetrievalSchedule({
    sessionId: "s1",
    submittedAt: "2026-07-08T10:00:00.000Z",
    now: "2026-07-08T10:00:00.000Z",
    automation: "available",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(result.session_id, "s1");
  assert.equal(result.next_wakeup_at, "2026-07-08T10:05:00.000Z");
  assert.equal(result.deadline_at, "2026-07-08T10:30:00.000Z");
  assert.equal(result.scheduler, "available");
  assert.equal(result.automation_request.type, "one-shot");
  assert.equal(result.automation_request.at, "2026-07-08T10:05:00.000Z");
  assert.match(result.automation_request.instructions, /automation_update/);
  assert.match(result.automation_request.instructions, /one-shot follow-up/);
  assert.match(result.automation_request.instructions, /ask pro check s1/);
});

test("retry scheduler pass creates one-shot wakeup one minute after current check", () => {
  const result = planDelayedRetrievalSchedule({
    sessionId: "s1",
    submittedAt: "2026-07-08T10:00:00.000Z",
    now: "2026-07-08T10:05:00.000Z",
    automation: "available",
  });

  assert.equal(result.status, "scheduled");
  assert.equal(result.next_wakeup_at, "2026-07-08T10:06:00.000Z");
  assert.equal(result.automation_request.at, "2026-07-08T10:06:00.000Z");
});

test("scheduler fails after thirty minute deadline without scheduling", () => {
  const result = planDelayedRetrievalSchedule({
    sessionId: "s1",
    submittedAt: "2026-07-08T10:00:00.000Z",
    now: "2026-07-08T10:31:00.000Z",
    automation: "available",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "deadline_exceeded");
  assert.equal(result.deadline_at, "2026-07-08T10:30:00.000Z");
  assert.equal(Object.hasOwn(result, "automation_request"), false);
});

test("unavailable automation returns explicit fallback check instruction", () => {
  const result = planDelayedRetrievalSchedule({
    sessionId: "s1",
    submittedAt: "2026-07-08T10:00:00.000Z",
    now: "2026-07-08T10:00:00.000Z",
    automation: "unavailable",
  });

  assert.equal(result.status, "fallback");
  assert.equal(result.scheduler, "unavailable");
  assert.equal(result.fallback_instruction, "ask pro check s1");
  assert.equal(result.next_wakeup_at, "2026-07-08T10:05:00.000Z");
  assert.equal(Object.hasOwn(result, "automation_request"), false);
});

test("duplicate scheduling is idempotent and does not append another request", () => {
  const first = planDelayedRetrievalSchedule({
    sessionId: "s1",
    submittedAt: "2026-07-08T10:00:00.000Z",
    now: "2026-07-08T10:00:00.000Z",
    automation: "available",
  });
  const duplicate = planDelayedRetrievalSchedule({
    sessionId: "s1",
    submittedAt: "2026-07-08T10:00:00.000Z",
    now: "2026-07-08T10:00:00.000Z",
    automation: "available",
    existingScheduleKeys: [first.schedule_key],
  });

  assert.equal(duplicate.status, "scheduled");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.schedule_key, first.schedule_key);
  assert.equal(duplicate.new_schedule_count, 0);
  assert.equal(Object.hasOwn(duplicate, "automation_request"), false);
});

test("scheduler rejects malformed input before rendering instructions", () => {
  assert.throws(
    () =>
      planDelayedRetrievalSchedule({
        sessionId: "bad\nid",
        submittedAt: "2026-07-08T10:00:00.000Z",
        now: "2026-07-08T10:00:00.000Z",
        automation: "available",
      }),
    AskProSchedulerInputError,
  );
  assert.throws(
    () =>
      planDelayedRetrievalSchedule({
        sessionId: "s1",
        submittedAt: "not-a-date",
        now: "2026-07-08T10:00:00.000Z",
        automation: "available",
      }),
    AskProSchedulerInputError,
  );
});

test("scheduler fixture prints parseable schedule JSON", async () => {
  const { stdout } = await execFileAsync(process.execPath, fixtureArgs({
    sessionId: "s1",
    submittedAt: "2026-07-08T10:00:00.000Z",
    now: "2026-07-08T10:00:00.000Z",
    automation: "available",
  }));
  const output = JSON.parse(stdout);

  assert.equal(output.status, "scheduled");
  assert.equal(output.automation_request.at, "2026-07-08T10:05:00.000Z");
});
