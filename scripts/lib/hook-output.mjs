const USER_PROMPT_SUBMIT = "UserPromptSubmit";

class MalformedHookInputError extends Error {
  constructor(cause) {
    super("malformed hook stdin");
    this.name = "MalformedHookInputError";
    this.cause = cause;
  }
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function hasObviousNegation(prompt, triggerIndex) {
  const prefix = prompt.slice(Math.max(0, triggerIndex - 40), triggerIndex).toLowerCase();
  return /\b(?:do\s+not|don't|dont|never)\s+$/u.test(prefix);
}

function parsePromptCommand(prompt) {
  const trimmed = prompt.trim();
  const match = trimmed.match(/(?:^|\b)ask\s+pro(?:\s+(.*))?$/iu);
  if (match === null) {
    return null;
  }
  if (hasObviousNegation(trimmed, match.index ?? 0)) {
    return null;
  }

  const body = match[1]?.trim() ?? "";
  const checkMatch = body.match(/^check\s+([A-Za-z0-9._:-]+)$/u);
  if (checkMatch !== null) {
    return {
      mode: "check",
      request: body,
      sessionId: checkMatch[1],
    };
  }

  return {
    mode: "ask",
    request: body,
    sessionId: null,
  };
}

function buildAdditionalContext(command, event) {
  const attributes = [`mode="${command.mode}"`];
  if (command.sessionId !== null) {
    attributes.push(`session-id="${xmlEscape(command.sessionId)}"`);
  }

  const cwdLine = typeof event.cwd === "string" && event.cwd.length > 0
    ? `\n<cwd>${xmlEscape(event.cwd)}</cwd>`
    : "";

  return `<ask-pro-mode>\n<instruction>Load and use skills/ask-pro/SKILL.md before acting.</instruction>\n<request ${attributes.join(" ")}>${xmlEscape(command.request)}</request>${cwdLine}\n</ask-pro-mode>`;
}

export function parseHookInput(stdin) {
  try {
    return JSON.parse(stdin);
  } catch (error) {
    throw new MalformedHookInputError(error);
  }
}

export function renderUserPromptSubmitHook(event) {
  if (event?.hook_event_name !== USER_PROMPT_SUBMIT) {
    return "";
  }
  if (typeof event.prompt !== "string") {
    return "";
  }

  const command = parsePromptCommand(event.prompt);
  if (command === null) {
    return "";
  }

  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: USER_PROMPT_SUBMIT,
      additionalContext: buildAdditionalContext(command, event),
    },
  })}\n`;
}

export { MalformedHookInputError };
