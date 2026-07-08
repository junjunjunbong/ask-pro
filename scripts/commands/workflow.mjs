import { join, resolve } from "node:path";

import { checkAskProSession, submitAskProSession } from "../lib/ask-pro-workflow.mjs";
import { createCliChatGptAdapter } from "../lib/chatgpt-workflow-adapter.mjs";
import { optionalString, parseOptions, requireOption } from "../lib/cli-options.mjs";

function storeRoot(options, project = process.cwd()) {
  return resolve(optionalString(options, "root") ?? join(project, ".ask-pro"));
}

function clock(options) {
  const value = optionalString(options, "now");
  return value === undefined ? () => new Date() : () => new Date(value);
}

function automation(options) {
  return optionalString(options, "automation") ?? "unavailable";
}

export async function submitCommand(args) {
  const options = parseOptions(args);
  const project = resolve(requireOption(options, "project"));
  const result = await submitAskProSession({
    root: storeRoot(options, project),
    project,
    request: requireOption(options, "request"),
    now: clock(options),
    chatGpt: createCliChatGptAdapter(),
    automation: automation(options),
    sessionId: optionalString(options, "session-id"),
  });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    session_id: result.session.id,
    state: result.session,
    context: result.context,
    computer_use: result.computer_use,
    schedule: result.schedule,
  }, null, 2)}\n`);
}

export async function checkCommand(args) {
  const [sessionId, ...optionArgs] = args;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.startsWith("--")) {
    throw new Error("missing session id");
  }
  const options = parseOptions(optionArgs);
  const project = resolve(optionalString(options, "project") ?? process.cwd());
  const result = await checkAskProSession({
    root: storeRoot(options, project),
    sessionId,
    now: clock(options),
    chatGpt: createCliChatGptAdapter(),
    automation: automation(options),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
