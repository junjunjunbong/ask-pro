# ask-pro

ask-pro is a Codex plugin bundle for explicit GPT Pro consultation through the ChatGPT macOS app. It packages selected local context, submits it only when the user says `ask pro`, stores session artifacts, and lets Codex treat the copied answer as advisory-only input.

## Install

1. Install the plugin directory as a local Codex plugin bundle, preserving this layout:
   - `.codex-plugin/plugin.json`
   - `hooks/user-prompt-submit-ask-pro.json`
   - `skills/ask-pro/SKILL.md`
   - `scripts/`
   - `tests/`
   - `README.md`
   - `package.json`
2. From the plugin root, validate before packaging:

```sh
node --test
node scripts/ask-pro.mjs validate-plugin --root .
node scripts/ask-pro.mjs pack-plugin --out .omo/evidence/package/ask-pro.zip
unzip -l .omo/evidence/package/ask-pro.zip
```

## Usage

Use ask-pro only from the current user prompt:

```text
ask pro <request>
ask pro check <session-id>
```

The hook ignores transcript-only mentions and injects the `skills/ask-pro/SKILL.md` workflow. The workflow creates `.ask-pro/sessions/<session-id>/` in the target project for `state.json`, `manifest.json`, `prompt.md`, `context.zip`, copied transcripts, advice summaries, and apply summaries.

## Runtime Behavior

The primary interaction path is the ChatGPT macOS app operated through the OpenAI bundled Computer Use plugin. AppleScript helpers are limited to deterministic preflight, activation, clipboard, or failure diagnostics. No Chrome/browser fallback is allowed.

After submit, retrieval is scheduled for 5 minutes later, then every 1 minute until the 30 minutes deadline. If `automation_update` is unavailable, the CLI prints the fallback command `ask pro check <session-id>`.

GPT Pro output is advisory-only. Codex must decide what to apply, make local edits itself, and verify with local evidence before claiming completion.

## Current QA Caveat

In this environment, live ChatGPT.app automation is currently blocked by Computer Use policy for bundle id `com.openai.chat`. The product-side validation handles that safely: ChatGPT.app QA/preflight commands fail clearly and do not silently switch to Chrome or browser automation.

## Distribution

`pack-plugin` creates a distributable zip from an allowlist of plugin files: manifest, hook JSON, skill file, scripts, tests, README, and package metadata. It excludes `.git/`, `.ask-pro/`, `.omo/evidence/`, raw GUI screenshots/evidence, `node_modules/`, hidden local state, and sensitive artifact paths.
