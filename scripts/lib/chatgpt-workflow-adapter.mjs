import { execFile } from "node:child_process";
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
      if (typeof process.env.ASK_PRO_CHATGPT_SUBMIT_MOCK_RESULT === "string") {
        const result = parseJson(process.env.ASK_PRO_CHATGPT_SUBMIT_MOCK_RESULT, "invalid_submit_mock");
        if (result?.ok === true) {
          return result;
        }
      }
      throw new ChatGptMacError("ChatGPT.app submission requires Computer Use evidence.", {
        code: "computer_use_required",
        action: `Use Computer Use with ${request.requestPath}, then rerun with a test adapter or recorded submit evidence before marking submitted.`,
      });
    },

    async copyLatest() {
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
