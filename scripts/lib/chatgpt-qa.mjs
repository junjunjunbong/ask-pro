import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ChatGptMacError, runChatGptPreflight } from "./chatgpt-mac.mjs";
import { safariEvidenceNames } from "./chatgpt-safari.mjs";

const MARKER_PATTERN = /\bASK_PRO_QA_OK\b/u;

function qaTarget(value = process.env.ASK_PRO_CHATGPT_TARGET ?? "safari") {
  if (value === "safari" || value === "chatgpt-app") return value;
  throw new ChatGptMacError("unsupported ChatGPT QA target", {
    code: "qa_target_invalid",
    action: "Use ASK_PRO_CHATGPT_TARGET=safari or ASK_PRO_CHATGPT_TARGET=chatgpt-app.",
  });
}

function targetCopyAction(target) {
  return target === "safari"
    ? "Use Safari to submit the prompt at chatgpt.com, copy the response, and save copied-transcript.txt."
    : "Use Computer Use to submit the prompt in ChatGPT.app, copy the response, and save copied-transcript.txt.";
}

function targetEvidence(sessionDir, target) {
  if (target === "safari") {
    const names = safariEvidenceNames();
    return {
      actionLogPath: join(sessionDir, names.actionLog),
      screenshotPath: join(sessionDir, names.screenshot),
      missingCode: "qa_safari_evidence_missing",
      action: "Run the ChatGPT QA through Safari and save a non-empty Safari action log plus safari-screenshot.png.",
    };
  }
  return {
    actionLogPath: join(sessionDir, "computer-use-action-log.jsonl"),
    screenshotPath: join(sessionDir, "computer-use-screenshot.png"),
    missingCode: "qa_computer_use_evidence_missing",
    action: "Run the ChatGPT.app QA through Computer Use and save a non-empty action log plus computer-use-screenshot.png.",
  };
}

async function readTranscript(path, target) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ChatGptMacError("ChatGPT QA copied transcript is missing.", {
        code: "qa_transcript_missing",
        action: targetCopyAction(target),
      });
    }
    throw error;
  }
}

async function writeState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function artifactExists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function missingComputerUseEvidence(paths) {
  const missing = [];
  for (const path of paths) {
    if (!(await artifactExists(path))) missing.push(path);
  }
  return missing;
}

export async function runChatGptQa({
  sessionDir,
  prompt,
  preflight = runChatGptPreflight,
  target = qaTarget(),
  now = () => new Date(),
} = {}) {
  const checkedTarget = qaTarget(target);
  if (typeof sessionDir !== "string" || sessionDir.length === 0) {
    throw new ChatGptMacError("missing --session", { code: "qa_session_missing" });
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new ChatGptMacError("missing --prompt", { code: "qa_prompt_missing" });
  }

  await mkdir(sessionDir, { recursive: true });
  const startedAt = now().toISOString();
  const statePath = join(sessionDir, "qa-chatgpt-state.json");
  const promptPath = join(sessionDir, "qa-prompt.txt");
  const transcriptPath = join(sessionDir, "copied-transcript.txt");
  const evidence = targetEvidence(sessionDir, checkedTarget);
  await writeFile(promptPath, prompt, "utf8");

  const preflightReport = checkedTarget === "chatgpt-app"
    ? await preflight({ evidenceDir: sessionDir })
    : { ok: true, app_name: "Safari", checks: [{ name: "safari_target", ok: true, message: "Safari target selected" }] };
  if (!preflightReport.ok) {
    const blocked = {
      status: "blocked",
      reason: "preflight_failed",
      prompt,
      target: checkedTarget,
      started_at: startedAt,
      finished_at: now().toISOString(),
      preflight: preflightReport,
    };
    await writeState(statePath, blocked);
    throw new ChatGptMacError("ChatGPT QA preflight failed.", {
      code: "qa_preflight_failed",
      action: "Fix the selected ChatGPT target before running real-surface QA.",
    });
  }

  let transcript;
  try {
    transcript = await readTranscript(transcriptPath, checkedTarget);
  } catch (error) {
    if (error instanceof ChatGptMacError) {
      await writeState(statePath, {
        status: "blocked",
        reason: error.code,
        prompt,
        target: checkedTarget,
        started_at: startedAt,
        finished_at: now().toISOString(),
        action: error.action,
        transcript_path: transcriptPath,
      });
    }
    throw error;
  }

  if (!MARKER_PATTERN.test(transcript)) {
    const action = "Copy the latest ChatGPT response and ensure it contains ASK_PRO_QA_OK.";
    await writeState(statePath, {
      status: "blocked",
      reason: "qa_marker_missing",
      prompt,
      target: checkedTarget,
      started_at: startedAt,
      finished_at: now().toISOString(),
      action,
      transcript_path: transcriptPath,
    });
    throw new ChatGptMacError("ChatGPT QA transcript does not contain ASK_PRO_QA_OK.", {
      code: "qa_marker_missing",
      action,
    });
  }

  const missingEvidence = await missingComputerUseEvidence([evidence.actionLogPath, evidence.screenshotPath]);
  if (missingEvidence.length > 0) {
    await writeState(statePath, {
      status: "blocked",
      reason: evidence.missingCode,
      prompt,
      target: checkedTarget,
      started_at: startedAt,
      finished_at: now().toISOString(),
      action: evidence.action,
      transcript_path: transcriptPath,
      action_log_path: evidence.actionLogPath,
      screenshot_path: evidence.screenshotPath,
      missing_evidence: missingEvidence,
    });
    throw new ChatGptMacError("ChatGPT QA requires selected-target evidence artifacts.", {
      code: evidence.missingCode,
      action: evidence.action,
    });
  }

  const result = {
    status: "confirmed",
    marker: "ASK_PRO_QA_OK",
    target: checkedTarget,
    prompt_path: promptPath,
    transcript_path: transcriptPath,
    action_log_path: evidence.actionLogPath,
    screenshot_path: evidence.screenshotPath,
    state_path: statePath,
    started_at: startedAt,
    finished_at: now().toISOString(),
  };
  await writeState(statePath, result);
  return result;
}
