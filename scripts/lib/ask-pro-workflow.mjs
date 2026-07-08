import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { renderSafariInstructions, safariEvidenceNames } from "./chatgpt-safari.mjs";
import { prepareContextPackage } from "./context-package.mjs";
import { planDelayedRetrievalSchedule } from "./scheduler.mjs";
import {
  createSession,
  readSession,
  recordWaitingCheck,
  submitSession,
  transitionSession,
} from "./session-store.mjs";
import { sessionRoot, statePath } from "./session-paths.mjs";

function currentDate(now) {
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date ? value : new Date(value ?? Date.now());
}

function iso(date) {
  return date.toISOString();
}

async function patchSession({ root, sessionId, patch, now }) {
  const current = await readSession({ root, sessionId });
  const next = { ...current, ...patch, updated_at: iso(now) };
  await writeFile(statePath(root, sessionId), `${JSON.stringify(next, null, 2)}\n`);
  return readSession({ root, sessionId });
}

function defaultScheduler(input) {
  return planDelayedRetrievalSchedule(input);
}

async function writeSchedule({ root, sessionId, name, schedule }) {
  const path = join(sessionRoot(root, sessionId), name);
  await writeFile(path, `${JSON.stringify(schedule, null, 2)}\n`);
  return path;
}

async function readScheduleKeys({ root, sessionId }) {
  const dir = sessionRoot(root, sessionId);
  const names = await readdir(dir).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const keys = new Set();
  await Promise.all(names.filter((name) => /^schedule-.*\.json$/u.test(name)).map(async (name) => {
    const schedule = JSON.parse(await readFile(join(dir, name), "utf8"));
    if (typeof schedule.schedule_key === "string") {
      keys.add(schedule.schedule_key);
    }
  }));
  return [...keys].sort();
}

async function writeSafariContract({ root, sessionId, context }) {
  const evidenceDir = join(sessionRoot(root, sessionId), "safari");
  await mkdir(evidenceDir, { recursive: true });
  const evidenceNames = safariEvidenceNames();
  const screenshotPath = join(evidenceDir, evidenceNames.screenshot);
  const actionLogPath = join(evidenceDir, evidenceNames.actionLog);
  const instructions = renderSafariInstructions({
    evidenceDir,
    screenshotPath,
    actionLogPath,
  });
  const requestPath = join(evidenceDir, "safari-request.json");
  const instructionsPath = join(evidenceDir, "safari-instructions.md");
  const request = {
    schema_version: 1,
    runtime_target: "safari",
    session_id: sessionId,
    prompt_path: context.promptPath,
    zip_path: context.zipPath,
    evidence_dir: evidenceDir,
    screenshot_path: screenshotPath,
    action_log_path: actionLogPath,
    instructions_path: instructionsPath,
    instructions,
  };
  await writeFile(instructionsPath, instructions);
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  return { ...request, request_path: requestPath, evidenceDir, requestPath };
}

function submittedAtFrom(result, fallback) {
  if (typeof result?.submitted_at !== "string") {
    return fallback;
  }
  const parsed = new Date(result.submitted_at);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export async function submitAskProSession({
  root,
  project,
  request,
  now = () => new Date(),
  chatGpt,
  scheduler = defaultScheduler,
  automation = "unavailable",
  sessionId,
}) {
  const at = currentDate(now);
  const storeRoot = resolve(root);
  const projectRoot = resolve(project);
  const created = await createSession({ root: storeRoot, now: at, sessionId });
  const out = join(sessionRoot(storeRoot, created.id), "context");
  const context = await prepareContextPackage({ project: projectRoot, request, out, now: at });
  if (created.status !== "packaged") {
    await transitionSession({ root: storeRoot, sessionId: created.id, status: "packaged", now: at });
  }
  await patchSession({
    root: storeRoot,
    sessionId: created.id,
    now: at,
    patch: { zip_path: context.zipPath, manifest_path: context.manifestPath },
  });
  const safari = await writeSafariContract({ root: storeRoot, sessionId: created.id, context });
  const submission = await chatGpt.submit({
    sessionId: created.id,
    request,
    promptPath: context.promptPath,
    zipPath: context.zipPath,
    evidenceDir: safari.evidenceDir,
    requestPath: safari.requestPath,
    safari,
  });
  if (submission?.ok !== true) {
    throw new Error("ChatGPT adapter did not confirm submission");
  }
  const submittedAt = submittedAtFrom(submission, at);
  const submitted = await submitSession({ root: storeRoot, sessionId: created.id, now: submittedAt });
  const existingScheduleKeys = await readScheduleKeys({ root: storeRoot, sessionId: created.id });
  const schedule = scheduler({
    sessionId: created.id,
    submittedAt: submitted.submitted_at,
    now: iso(submittedAt),
    automation,
    existingScheduleKeys,
  });
  const schedulePath = await writeSchedule({ root: storeRoot, sessionId: created.id, name: "schedule-submit.json", schedule });
  return { status: "submitted", session: submitted, context, safari, schedule, schedule_path: schedulePath };
}

function transcriptAvailable(copy) {
  return copy?.ok === true && typeof copy.text === "string" && copy.text.trim().length > 0;
}

function renderAdviceSummary({ sessionId, transcript }) {
  const excerpt = transcript.trim().split(/\r?\n/u).slice(0, 20).join("\n");
  return [
    `# Ask Pro Advisory Summary: ${sessionId}`,
    "",
    "Advisory only. No code was applied automatically.",
    "",
    "## Copied Advice",
    "",
    excerpt,
    "",
  ].join("\n");
}

export async function checkAskProSession({
  root,
  sessionId,
  now = () => new Date(),
  chatGpt,
  scheduler = defaultScheduler,
  automation = "unavailable",
}) {
  const at = currentDate(now);
  const storeRoot = resolve(root);
  const before = await readSession({ root: storeRoot, sessionId });
  if (before.status === "advice_summarized") {
    return { status: "advice_summarized", session: before, auto_apply: false };
  }
  if (before.deadline_at !== null && at.getTime() >= new Date(before.deadline_at).getTime()) {
    const timedOut = await recordWaitingCheck({ root: storeRoot, sessionId, now: at });
    return { status: "timeout", session: timedOut, auto_apply: false };
  }

  const copy = await chatGpt.copyLatest({ sessionId, sessionDir: sessionRoot(storeRoot, sessionId) });
  if (!transcriptAvailable(copy)) {
    const waiting = await recordWaitingCheck({ root: storeRoot, sessionId, now: at });
    const existingScheduleKeys = await readScheduleKeys({ root: storeRoot, sessionId });
    const schedule = scheduler({
      sessionId,
      submittedAt: waiting.submitted_at,
      now: iso(at),
      automation,
      existingScheduleKeys,
    });
    const schedulePath = await writeSchedule({ root: storeRoot, sessionId, name: `schedule-check-${waiting.retry_count}.json`, schedule });
    return { status: "pending", session: waiting, schedule, schedule_path: schedulePath, auto_apply: false };
  }

  await recordWaitingCheck({ root: storeRoot, sessionId, now: at });
  const transcriptPath = join(sessionRoot(storeRoot, sessionId), "transcript.md");
  await writeFile(transcriptPath, copy.text);
  await transitionSession({ root: storeRoot, sessionId, status: "copied", now: at });
  await patchSession({ root: storeRoot, sessionId, now: at, patch: { transcript_path: transcriptPath } });
  const summaryPath = join(sessionRoot(storeRoot, sessionId), "advice-summary.md");
  await writeFile(summaryPath, renderAdviceSummary({ sessionId, transcript: copy.text }));
  await transitionSession({ root: storeRoot, sessionId, status: "advice_summarized", now: at });
  const summarized = await patchSession({ root: storeRoot, sessionId, now: at, patch: { advice_summary_path: summaryPath } });
  return { status: "advice_summarized", session: summarized, transcript_path: transcriptPath, auto_apply: false };
}
