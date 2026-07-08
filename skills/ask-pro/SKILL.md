---
name: ask-pro
description: Use only when the current user prompt explicitly says "ask pro" or "ask pro check <session-id>".
---

# ask-pro

Ask Pro packages the current Codex task for a GPT Pro consultation in ChatGPT through Safari, then returns the copied answer as advisory input for Codex to evaluate. Codex still owns all code edits, tests, and final claims.

## Trigger Semantics

Use this skill only when the current user prompt explicitly invokes one of these forms:

- `ask pro <request>`
- `ask pro check <session-id>`

Do not trigger from transcript history, quoted text, README examples, or vague references such as "ask the pro model". If the command is `ask pro check <session-id>`, retrieve only that existing session.

## Submit Flow

1. Create or reuse a session under `.ask-pro/sessions/<timestamp-or-id>/`.
2. Package selected context into that session directory, including the request, manifest, prompt, and archive artifacts needed by the external reviewer.
3. Open Safari to ChatGPT web and use it as the primary runtime for paste, attach, submit, wait, and copy actions.
4. The ChatGPT macOS app path may be used only if explicitly selected and available; in this environment `com.openai.chat` is blocked by Computer Use policy.
5. Do not use Chrome as a fallback.

## Retrieval Schedule

After a successful submit, schedule the first retrieval check for 5 minutes after submission. If the answer is not ready, retry every 1 minute until the 30-minute deadline.

When `automation_update` is available, create exactly one one-shot follow-up for the next `ask pro check <session-id>` wakeup. When it is unavailable, print the fallback command `ask pro check <session-id>` so the user can resume retrieval manually.

## Check Flow

For `ask pro check <session-id>`, open the matching session under `.ask-pro/sessions/`, use Safari to inspect or copy the latest ChatGPT answer when needed, and save copied transcript/session artifacts back into the session directory.

Summarize the copied GPT Pro answer as advisory guidance only. Never auto-apply patches, run generated commands blindly, or treat the transcript as evidence that Codex work is complete. Codex must independently decide, edit, test, and record real evidence before claiming completion.

## Hard Boundaries

- GPT Pro advice is advisory, not authoritative.
- No automatic code application from GPT transcript content.
- No Chrome fallback.
- Safari is the primary way to operate ChatGPT web.
- If session evidence is missing, say exactly which artifact is missing and continue through the normal `ask pro check <session-id>` path.
