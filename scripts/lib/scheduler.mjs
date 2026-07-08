const FIRST_WAKEUP_DELAY_MS = 5 * 60 * 1000;
const RETRY_WAKEUP_DELAY_MS = 60 * 1000;
const DEADLINE_DELAY_MS = 30 * 60 * 1000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const AUTOMATION_VALUES = Object.freeze(["available", "unavailable"]);

export class AskProSchedulerInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "AskProSchedulerInputError";
    this.code = "ASK_PRO_SCHEDULER_INPUT";
  }
}

function parseIsoDate(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new AskProSchedulerInputError(`${name} must be a non-empty ISO timestamp`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new AskProSchedulerInputError(`${name} must be an ISO timestamp with millisecond precision`);
  }
  return parsed;
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new AskProSchedulerInputError("sessionId must contain only letters, numbers, dot, underscore, colon, or dash");
  }
  return sessionId;
}

function validateAutomation(automation) {
  if (!AUTOMATION_VALUES.includes(automation)) {
    throw new AskProSchedulerInputError('automation must be "available" or "unavailable"');
  }
  return automation;
}

function iso(value) {
  return value.toISOString();
}

function addMilliseconds(value, milliseconds) {
  return new Date(value.getTime() + milliseconds);
}

function selectWakeupAt({ submittedAt, now, deadlineAt }) {
  const firstWakeupAt = addMilliseconds(submittedAt, FIRST_WAKEUP_DELAY_MS);
  if (now.getTime() < firstWakeupAt.getTime()) {
    return firstWakeupAt;
  }

  const retryWakeupAt = addMilliseconds(now, RETRY_WAKEUP_DELAY_MS);
  if (retryWakeupAt.getTime() > deadlineAt.getTime()) {
    return deadlineAt;
  }
  return retryWakeupAt;
}

function buildScheduleKey(sessionId, wakeupAt) {
  return `ask-pro:${sessionId}:${iso(wakeupAt)}`;
}

function buildWakeupInstructions({ sessionId, wakeupAt, deadlineAt }) {
  return [
    `At ${iso(wakeupAt)}, wake Codex once for ask-pro delayed retrieval and submit exactly: ask pro check ${sessionId}`,
    "Before relying on plugin hooks, search available tools for automation_update.",
    "When automation_update is available, create exactly one one-shot follow-up for this wakeup time.",
    "Do not rely on plugin hooks alone to self-wake.",
    `Stop retrying after the deadline ${iso(deadlineAt)}.`,
  ].join("\n");
}

export function planDelayedRetrievalSchedule({
  sessionId,
  submittedAt,
  now,
  automation,
  existingScheduleKeys = [],
}) {
  const safeSessionId = validateSessionId(sessionId);
  const submittedAtDate = parseIsoDate(submittedAt, "submittedAt");
  const nowDate = parseIsoDate(now, "now");
  const automationState = validateAutomation(automation);

  if (!Array.isArray(existingScheduleKeys) || !existingScheduleKeys.every((key) => typeof key === "string")) {
    throw new AskProSchedulerInputError("existingScheduleKeys must be an array of strings");
  }
  if (nowDate.getTime() < submittedAtDate.getTime()) {
    throw new AskProSchedulerInputError("now must be at or after submittedAt");
  }

  const deadlineAt = addMilliseconds(submittedAtDate, DEADLINE_DELAY_MS);
  if (nowDate.getTime() >= deadlineAt.getTime()) {
    return {
      schema_version: 1,
      session_id: safeSessionId,
      scheduler: automationState,
      status: "failed",
      reason: "deadline_exceeded",
      submitted_at: iso(submittedAtDate),
      checked_at: iso(nowDate),
      deadline_at: iso(deadlineAt),
      fallback_instruction: `ask pro check ${safeSessionId}`,
    };
  }

  const wakeupAt = selectWakeupAt({ submittedAt: submittedAtDate, now: nowDate, deadlineAt });
  const scheduleKey = buildScheduleKey(safeSessionId, wakeupAt);
  const duplicate = existingScheduleKeys.includes(scheduleKey);
  const base = {
    schema_version: 1,
    session_id: safeSessionId,
    scheduler: automationState,
    status: automationState === "available" ? "scheduled" : "fallback",
    submitted_at: iso(submittedAtDate),
    checked_at: iso(nowDate),
    next_wakeup_at: iso(wakeupAt),
    deadline_at: iso(deadlineAt),
    schedule_key: scheduleKey,
    duplicate,
    new_schedule_count: duplicate ? 0 : 1,
    fallback_instruction: `ask pro check ${safeSessionId}`,
  };

  if (automationState === "unavailable") {
    return {
      ...base,
      new_schedule_count: 0,
    };
  }

  if (duplicate) {
    return base;
  }

  return {
    ...base,
    automation_request: {
      type: "one-shot",
      at: iso(wakeupAt),
      command: `ask pro check ${safeSessionId}`,
      instructions: buildWakeupInstructions({ sessionId: safeSessionId, wakeupAt, deadlineAt }),
    },
  };
}
