import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ChatGptMacError, parseCopyLatestResult } from "./chatgpt-mac.mjs";

const execFileAsync = promisify(execFile);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultCopyScript = join(moduleDir, "../apple/chatgpt-copy-latest.applescript");
const DEFAULT_APP_NAME = "ChatGPT";

function parseJson(value, code) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ChatGptMacError(`invalid ${code} mock JSON`, { code, cause: error });
  }
}

export function createCliChatGptAdapter({
  appName = process.env.ASK_PRO_CHATGPT_APP_NAME ?? DEFAULT_APP_NAME,
  copyScriptPath = process.env.ASK_PRO_CHATGPT_COPY_SCRIPT ?? defaultCopyScript,
  runner = execFileAsync,
} = {}) {
  return {
    async submit(request) {
      throw new ChatGptMacError("Safari ChatGPT submission requires recorded Safari evidence.", {
        code: "safari_submit_required",
        action: `Open ${request.requestPath}, submit through Safari, and save the required Safari screenshot/action-log evidence before marking submitted.`,
      });
    },

    async copyLatest({ sessionDir } = {}) {
      if (typeof sessionDir === "string") {
        try {
          const text = await readFile(join(sessionDir, "copied-transcript.txt"), "utf8");
          return text.trim().length > 0 ? { ok: true, text } : { ok: false, pending: true };
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      if (typeof process.env.ASK_PRO_CHATGPT_COPY_MOCK_RESULT === "string") {
        const result = parseJson(process.env.ASK_PRO_CHATGPT_COPY_MOCK_RESULT, "invalid_copy_mock");
        return result?.ok === true ? result : { ok: false, pending: true };
      }
      try {
        const { stdout } = await runner("osascript", [copyScriptPath, appName], {
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        });
        return parseCopyLatestResult(stdout);
      } catch (error) {
        if (error instanceof ChatGptMacError && error.code === "copy_empty") {
          return { ok: false, pending: true, reason: error.message };
        }
        throw error;
      }
    },
  };
}
