import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { submitAskProSession } from "../scripts/lib/ask-pro-workflow.mjs";

export async function makeProject() {
  const project = await mkdtemp(join(tmpdir(), "ask-pro-project-"));
  await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
  await writeFile(join(project, "index.js"), "export const answer = 42;\n");
  return project;
}

export function fixedClock(iso) {
  return () => new Date(iso);
}

export function fakeSubmitAdapter(calls) {
  return {
    async submit(request) {
      calls.push(request);
      await writeFile(join(request.evidenceDir, "computer-use-screenshot.png"), "fake screenshot");
      await writeFile(join(request.evidenceDir, "computer-use-action-log.jsonl"), "{\"ok\":true}\n");
      return { ok: true, submitted_at: "2026-07-08T10:00:00.000Z" };
    },
  };
}

export function fakeScheduler(calls) {
  return (request) => {
    calls.push(request);
    return {
      schema_version: 1,
      session_id: request.sessionId,
      status: "scheduled",
      scheduler: request.automation,
      submitted_at: request.submittedAt,
      checked_at: request.now,
      next_wakeup_at: request.now,
      deadline_at: "2026-07-08T10:30:00.000Z",
      schedule_key: `ask-pro:${request.sessionId}:${request.now}`,
      duplicate: false,
      new_schedule_count: 1,
      fallback_instruction: `ask pro check ${request.sessionId}`,
    };
  };
}

export async function submittedFixture({ copyLatest, clock = fixedClock("2026-07-08T10:00:00.000Z") }) {
  const project = await makeProject();
  const root = join(project, ".ask-pro");
  const submitCalls = [];
  const scheduleCalls = [];
  const submit = await submitAskProSession({
    root,
    project,
    request: "Please review this fixture.",
    now: clock,
    chatGpt: fakeSubmitAdapter(submitCalls),
    scheduler: fakeScheduler(scheduleCalls),
    automation: "available",
    sessionId: "workflow-session",
  });

  return {
    project,
    root,
    sessionId: submit.session.id,
    chatGpt: { copyLatest },
    scheduleCalls,
  };
}
