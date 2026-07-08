import assert from "node:assert/strict";
import test from "node:test";

import { renderSafariInstructions, safariEvidenceNames } from "../scripts/lib/chatgpt-safari.mjs";

test("Safari instructions name ChatGPT web target and required evidence", () => {
  const instructions = renderSafariInstructions({
    evidenceDir: "/tmp/ask-pro/safari",
    screenshotPath: "/tmp/ask-pro/safari/safari-screenshot.png",
    actionLogPath: "/tmp/ask-pro/safari/safari-action-log.jsonl",
  });

  assert.match(instructions, /Safari opened to ChatGPT web/);
  assert.match(instructions, /https:\/\/chatgpt\.com\//);
  assert.match(instructions, /safari-screenshot\.png/);
  assert.match(instructions, /safari-action-log\.jsonl/);
  assert.match(instructions, /Do not use Chrome/);
  assert.match(instructions, /Do not use Chrome or ChatGPT\.app/);
});

test("Safari evidence artifact names are stable", () => {
  assert.deepEqual(safariEvidenceNames(), {
    actionLog: "safari-action-log.jsonl",
    screenshot: "safari-screenshot.png",
  });
});
