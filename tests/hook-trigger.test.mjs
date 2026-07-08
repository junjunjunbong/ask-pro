import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const command = join(root, "scripts/ask-pro.mjs");

function runHook(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [command, "hook", "user-prompt-submit"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function parseHookJson(stdout) {
  assert.notEqual(stdout.trim(), "");
  return JSON.parse(stdout);
}

test("emits context when prompt starts with ask pro command form", async () => {
  // Given: a current prompt that invokes ask-pro directly.
  const input = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    prompt: "ask pro fix this",
    cwd: "/tmp/demo",
    transcript_path: null,
  });

  // When: the UserPromptSubmit hook runs.
  const result = await runHook(input);

  // Then: it emits Codex hook JSON with ask-pro mode context.
  assert.equal(result.code, 0);
  const output = parseHookJson(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /<ask-pro-mode>/);
  assert.match(output.hookSpecificOutput.additionalContext, /fix this/);
});

test("emits context when current prompt contains ask pro command form", async () => {
  // Given: a current prompt that invokes ask-pro inside a sentence.
  const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "please ask pro about this" });

  // When: the hook runs.
  const result = await runHook(input);

  // Then: it emits Codex hook JSON with ask-pro mode context.
  assert.equal(result.code, 0);
  const output = parseHookJson(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /<ask-pro-mode>/);
  assert.match(output.hookSpecificOutput.additionalContext, /about this/);
  assert.match(output.hookSpecificOutput.additionalContext, /skills\/ask-pro\/SKILL\.md/);
});

test("emits check mode when prompt asks for a session check", async () => {
  // Given: a check command with a session id.
  const input = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    prompt: "ask pro check 20260708T105856Z",
  });

  // When: the hook runs.
  const result = await runHook(input);

  // Then: it records check mode and the session id as data.
  assert.equal(result.code, 0);
  const output = parseHookJson(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /mode="check"/);
  assert.match(output.hookSpecificOutput.additionalContext, /session-id="20260708T105856Z"/);
});

test("ignores transcript-only ask pro mentions", async () => {
  // Given: history contains ask pro but the current prompt does not.
  const input = JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    prompt: "continue",
    transcript: [{ role: "user", content: "ask pro fix the previous bug" }],
  });

  // When: the hook runs.
  const result = await runHook(input);

  // Then: it remains silent because activation is based only on current prompt.
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});

test("malformed JSON is rejected without hook output", async () => {
  // Given: malformed hook stdin.
  const input = "{";

  // When: the hook runs.
  const result = await runHook(input);

  // Then: the process fails clearly and does not emit misleading hook JSON.
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /malformed hook stdin/);
});

test("normal prompt emits no output", async () => {
  // Given: an unrelated current prompt.
  const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "summarize this file" });

  // When: the hook runs.
  const result = await runHook(input);

  // Then: it is a no-op.
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});
