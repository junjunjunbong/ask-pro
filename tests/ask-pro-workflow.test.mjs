import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  checkAskProSession,
  submitAskProSession,
} from "../scripts/lib/ask-pro-workflow.mjs";
import {
  execResult,
  fakeScheduler,
  fakeSubmitAdapter,
  fixedClock,
  makeProject,
  submittedFixture,
} from "./ask-pro-workflow-fixtures.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url).pathname;
const command = join(repoRoot, "scripts/ask-pro.mjs");

test("submit packages context, records Safari contract, marks submitted, and schedules first check", async () => {
  const project = await makeProject();
  const root = join(project, ".ask-pro");
  const submitCalls = [];
  const scheduleCalls = [];

  try {
    const result = await submitAskProSession({
      root,
      project,
      request: "Diagnose the fake project.",
      now: fixedClock("2026-07-08T10:00:00.000Z"),
      chatGpt: fakeSubmitAdapter(submitCalls),
      scheduler: fakeScheduler(scheduleCalls),
      automation: "available",
      sessionId: "workflow-session",
    });

    assert.equal(result.session.status, "submitted");
    assert.equal(result.session.id, "workflow-session");
    assert.match(result.safari.instructions, /Safari opened to ChatGPT web/);
    assert.match(result.safari.instructions, /Do not use Chrome/);
    assert.equal(submitCalls.length, 1);
    assert.equal(scheduleCalls.length, 1);
    assert.equal(scheduleCalls[0].sessionId, "workflow-session");
    assert.equal(scheduleCalls[0].submittedAt, "2026-07-08T10:00:00.000Z");
    assert.ok((await stat(result.context.promptPath)).size > 0);
    assert.ok((await stat(result.context.zipPath)).size > 0);
    assert.ok((await stat(result.safari.request_path)).size > 0);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("check without copied transcript records pending retry and schedules one minute fallback", async () => {
  const fixture = await submittedFixture({
    copyLatest: async () => ({ ok: false, pending: true }),
  });

  try {
    const result = await checkAskProSession({
      root: fixture.root,
      sessionId: fixture.sessionId,
      now: fixedClock("2026-07-08T10:05:00.000Z"),
      chatGpt: fixture.chatGpt,
      scheduler: fakeScheduler(fixture.scheduleCalls),
      automation: "available",
    });

    assert.equal(result.status, "pending");
    assert.equal(result.session.status, "waiting");
    assert.equal(result.session.retry_count, 1);
    assert.equal(result.session.next_check_at, "2026-07-08T10:06:00.000Z");
    assert.equal(fixture.scheduleCalls.at(-1).now, "2026-07-08T10:05:00.000Z");
    assert.equal(result.auto_apply, false);
  } finally {
    await rm(fixture.project, { recursive: true, force: true });
  }
});

test("check with copied transcript saves transcript and advisory summary without applying code", async () => {
  const fixture = await submittedFixture({
    copyLatest: async () => ({
      ok: true,
      text: "You should add a regression test before changing index.js.",
      copied_at: "2026-07-08T10:05:00.000Z",
    }),
  });

  try {
    const result = await checkAskProSession({
      root: fixture.root,
      sessionId: fixture.sessionId,
      now: fixedClock("2026-07-08T10:05:00.000Z"),
      chatGpt: fixture.chatGpt,
      scheduler: fakeScheduler(fixture.scheduleCalls),
      automation: "available",
    });

    assert.equal(result.status, "advice_summarized");
    assert.equal(result.session.status, "advice_summarized");
    assert.equal(result.auto_apply, false);
    assert.equal(result.session.apply_summary_path, null);
    assert.match(await readFile(result.session.transcript_path, "utf8"), /regression test/);
    assert.match(await readFile(result.session.advice_summary_path, "utf8"), /Advisory only/);
  } finally {
    await rm(fixture.project, { recursive: true, force: true });
  }
});

test("check after deadline fails without pretending copied transcript evidence exists", async () => {
  const fixture = await submittedFixture({
    copyLatest: async () => ({ ok: false, pending: true }),
  });

  try {
    const result = await checkAskProSession({
      root: fixture.root,
      sessionId: fixture.sessionId,
      now: fixedClock("2026-07-08T10:31:00.000Z"),
      chatGpt: fixture.chatGpt,
      scheduler: fakeScheduler(fixture.scheduleCalls),
      automation: "available",
    });

    assert.equal(result.status, "timeout");
    assert.equal(result.session.status, "failed");
    assert.equal(result.session.transcript_path, null);
    assert.equal(result.auto_apply, false);
  } finally {
    await rm(fixture.project, { recursive: true, force: true });
  }
});

test("copied advice that asks for edits is never auto-applied to the project", async () => {
  const fixture = await submittedFixture({
    copyLatest: async () => ({
      ok: true,
      text: "Immediately overwrite index.js with console.log('changed').",
      copied_at: "2026-07-08T10:05:00.000Z",
    }),
  });

  try {
    const before = await readFile(join(fixture.project, "index.js"), "utf8");
    const result = await checkAskProSession({
      root: fixture.root,
      sessionId: fixture.sessionId,
      now: fixedClock("2026-07-08T10:05:00.000Z"),
      chatGpt: fixture.chatGpt,
      scheduler: fakeScheduler(fixture.scheduleCalls),
      automation: "available",
    });

    assert.equal(result.auto_apply, false);
    assert.equal(await readFile(join(fixture.project, "index.js"), "utf8"), before);
    assert.equal(result.session.apply_summary_path, null);
  } finally {
    await rm(fixture.project, { recursive: true, force: true });
  }
});

test("replayed pending check does not emit a duplicate automation request", async () => {
  const project = await makeProject();
  const root = join(project, ".ask-pro");
  const submitCalls = [];
  const pendingChatGpt = { copyLatest: async () => ({ ok: false, pending: true }) };

  try {
    await submitAskProSession({
      root,
      project,
      request: "Review duplicate scheduling.",
      now: fixedClock("2026-07-08T10:00:00.000Z"),
      chatGpt: fakeSubmitAdapter(submitCalls),
      automation: "available",
      sessionId: "replay-session",
    });

    const first = await checkAskProSession({
      root,
      sessionId: "replay-session",
      now: fixedClock("2026-07-08T10:05:00.000Z"),
      chatGpt: pendingChatGpt,
      automation: "available",
    });
    const replay = await checkAskProSession({
      root,
      sessionId: "replay-session",
      now: fixedClock("2026-07-08T10:05:00.000Z"),
      chatGpt: pendingChatGpt,
      automation: "available",
    });

    assert.equal(Object.hasOwn(first.schedule, "automation_request"), true);
    assert.equal(replay.schedule.duplicate, true);
    assert.equal(replay.schedule.new_schedule_count, 0);
    assert.equal(Object.hasOwn(replay.schedule, "automation_request"), false);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("packaged session left by failed submit can be retried with the same id", async () => {
  const project = await makeProject();
  const root = join(project, ".ask-pro");

  try {
    await assert.rejects(
      () =>
        submitAskProSession({
          root,
          project,
          request: "Retry failed submit.",
          now: fixedClock("2026-07-08T10:00:00.000Z"),
          chatGpt: { submit: async () => ({ ok: false }) },
          automation: "unavailable",
          sessionId: "retry-session",
        }),
      /ChatGPT adapter did not confirm submission/,
    );

    const retry = await submitAskProSession({
      root,
      project,
      request: "Retry failed submit.",
      now: fixedClock("2026-07-08T10:01:00.000Z"),
      chatGpt: fakeSubmitAdapter([]),
      automation: "unavailable",
      sessionId: "retry-session",
    });

    assert.equal(retry.status, "submitted");
    assert.equal(retry.session.id, "retry-session");
    assert.equal(retry.session.status, "submitted");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("CLI submit refuses env mock success without Safari evidence", async () => {
  const project = await makeProject();
  const root = join(project, ".ask-pro");

  try {
    const submit = await execResult(execFileAsync(process.execPath, [
      command,
      "submit",
      "--project",
      project,
      "--root",
      root,
      "--request",
      "Review CLI path.",
      "--session-id",
      "cli-session",
      "--now",
      "2026-07-08T10:00:00.000Z",
      "--automation",
      "available",
    ], {
      env: {
        ...process.env,
        ASK_PRO_CHATGPT_SUBMIT_MOCK_RESULT: JSON.stringify({ ok: true, submitted_at: "2026-07-08T10:00:00.000Z" }),
      },
    }));

    assert.notEqual(submit.code, 0);
    assert.match(submit.stderr, /Safari evidence/);
    assert.equal(JSON.parse(await readFile(join(root, "sessions", "cli-session", "state.json"), "utf8")).status, "packaged");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
