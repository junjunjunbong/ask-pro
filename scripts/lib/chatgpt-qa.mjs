import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ChatGptMacError, runChatGptPreflight } from "./chatgpt-mac.mjs";

const MARKER_PATTERN = /\bASK_PRO_QA_OK\b/u;

async function readTranscript(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ChatGptMacError("ChatGPT.app QA copied transcript is missing.", {
        code: "qa_transcript_missing",
        action: "Use Computer Use to submit the prompt in ChatGPT.app, copy the response, and save copied-transcript.txt.",
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
  now = () => new Date(),
} = {}) {
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
  const actionLogPath = join(sessionDir, "computer-use-action-log.jsonl");
  const screenshotPath = join(sessionDir, "computer-use-screenshot.png");
  await writeFile(promptPath, prompt, "utf8");

  const preflightReport = await preflight({ evidenceDir: sessionDir });
  if (!preflightReport.ok) {
    const blocked = {
      status: "blocked",
      reason: "preflight_failed",
      prompt,
      started_at: startedAt,
      finished_at: now().toISOString(),
      preflight: preflightReport,
    };
    await writeState(statePath, blocked);
    throw new ChatGptMacError("ChatGPT.app QA preflight failed.", {
      code: "qa_preflight_failed",
      action: "Fix ChatGPT.app availability or macOS permissions before running real-surface QA.",
    });
  }

  let transcript;
  try {
    transcript = await readTranscript(transcriptPath);
  } catch (error) {
    if (error instanceof ChatGptMacError) {
      await writeState(statePath, {
        status: "blocked",
        reason: error.code,
        prompt,
        started_at: startedAt,
        finished_at: now().toISOString(),
        action: error.action,
        transcript_path: transcriptPath,
      });
    }
    throw error;
  }

  if (!MARKER_PATTERN.test(transcript)) {
    const action = "Copy the latest ChatGPT.app response and ensure it contains ASK_PRO_QA_OK.";
    await writeState(statePath, {
      status: "blocked",
      reason: "qa_marker_missing",
      prompt,
      started_at: startedAt,
      finished_at: now().toISOString(),
      action,
      transcript_path: transcriptPath,
    });
    throw new ChatGptMacError("ChatGPT.app QA transcript does not contain ASK_PRO_QA_OK.", {
      code: "qa_marker_missing",
      action,
    });
  }

  const missingEvidence = await missingComputerUseEvidence([actionLogPath, screenshotPath]);
  if (missingEvidence.length > 0) {
    const action = "Run the ChatGPT.app QA through Computer Use and save a non-empty action log plus computer-use-screenshot.png.";
    await writeState(statePath, {
      status: "blocked",
      reason: "qa_computer_use_evidence_missing",
      prompt,
      started_at: startedAt,
      finished_at: now().toISOString(),
      action,
      transcript_path: transcriptPath,
      action_log_path: actionLogPath,
      screenshot_path: screenshotPath,
      missing_evidence: missingEvidence,
    });
    throw new ChatGptMacError("ChatGPT.app QA requires Computer Use evidence artifacts.", {
      code: "qa_computer_use_evidence_missing",
      action,
    });
  }

  const result = {
    status: "confirmed",
    marker: "ASK_PRO_QA_OK",
    prompt_path: promptPath,
    transcript_path: transcriptPath,
    action_log_path: actionLogPath,
    screenshot_path: screenshotPath,
    state_path: statePath,
    started_at: startedAt,
    finished_at: now().toISOString(),
  };
  await writeState(statePath, result);
  return result;
}
