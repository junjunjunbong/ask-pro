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
  fakeScheduler,
  fakeSubmitAdapter,
  fixedClock,
  makeProject,
  submittedFixture,
} from "./ask-pro-workflow-fixtures.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url).pathname;
const command = join(repoRoot, "scripts/ask-pro.mjs");

test("submit packages context, records Computer Use contract, marks submitted, and schedules first check", async () => {
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
    assert.match(result.computer_use.instructions, /Computer Use is the primary runtime path/);
    assert.doesNotMatch(result.computer_use.instructions, /chrome|browser/i);
    assert.equal(submitCalls.length, 1);
    assert.equal(scheduleCalls.length, 1);
    assert.equal(scheduleCalls[0].sessionId, "workflow-session");
    assert.equal(scheduleCalls[0].submittedAt, "2026-07-08T10:00:00.000Z");
    assert.ok((await stat(result.context.promptPath)).size > 0);
    assert.ok((await stat(result.context.zipPath)).size > 0);
    assert.ok((await stat(result.computer_use.request_path)).size > 0);
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

test("CLI submit and check commands route the workflow with explicit mock ChatGPT evidence", async () => {
  const project = await makeProject();
  const root = join(project, ".ask-pro");

  try {
    const submit = await execFileAsync(process.execPath, [
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
    });
    const submitOutput = JSON.parse(submit.stdout);
    assert.equal(submitOutput.status, "submitted");
    assert.equal(submitOutput.session_id, "cli-session");

    const check = await execFileAsync(process.execPath, [
      command,
      "check",
      "cli-session",
      "--root",
      root,
      "--now",
      "2026-07-08T10:05:00.000Z",
      "--automation",
      "available",
    ], {
      env: {
        ...process.env,
        ASK_PRO_CHATGPT_COPY_MOCK_RESULT: JSON.stringify({ ok: true, text: "CLI advice only." }),
      },
    });
    const checkOutput = JSON.parse(check.stdout);
    assert.equal(checkOutput.status, "advice_summarized");
    assert.equal(checkOutput.auto_apply, false);
    assert.match(await readFile(checkOutput.session.transcript_path, "utf8"), /CLI advice only/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
