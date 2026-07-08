#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { prepareContextPackage } from "./lib/context-package.mjs";
import { ChatGptMacError, runChatGptPreflight } from "./lib/chatgpt-mac.mjs";
import { MalformedHookInputError, parseHookInput, renderUserPromptSubmitHook } from "./lib/hook-output.mjs";
import { AskProSchedulerInputError, planDelayedRetrievalSchedule } from "./lib/scheduler.mjs";
import {
  AskProSessionLockedError,
  acquireSessionLock,
  createSession,
  readSession,
  recordWaitingCheck,
  submitSession,
  transitionSession,
} from "./lib/session-store.mjs";

const REQUIRED_HOOK_COMMAND = 'node "${PLUGIN_ROOT}/scripts/ask-pro.mjs" hook user-prompt-submit';

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) {
      throw new Error(`unexpected argument: ${key}`);
    }
    const name = key.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[name] = true;
    } else {
      options[name] = next;
      index += 1;
    }
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing --${name}`);
  }
  return value;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function normalizePluginPath(value) {
  return value.replace(/^\.\//u, "");
}

function findHookCommand(hookConfig) {
  return hookConfig?.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
}

async function validatePlugin(args) {
  const options = parseOptions(args);
  const root = resolve(typeof options.root === "string" ? options.root : ".");
  const manifestPath = process.env.ASK_PRO_PLUGIN_JSON ?? join(root, ".codex-plugin/plugin.json");
  const errors = [];
  const warnings = [];
  const checked = [];

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    checked.push(".codex-plugin/plugin.json");
  } catch (error) {
    errors.push(`invalid manifest JSON: ${manifestPath}: ${error.message}`);
  }

  if (manifest !== undefined) {
    if (manifest.name !== "ask-pro") {
      errors.push('manifest name must be exactly "ask-pro"');
    }
    if (manifest.skills !== "./skills/") {
      errors.push('manifest skills must be exactly "./skills/"');
    }
    if (JSON.stringify(manifest.hooks) !== JSON.stringify(["./hooks/user-prompt-submit-ask-pro.json"])) {
      errors.push('manifest hooks must be exactly ["./hooks/user-prompt-submit-ask-pro.json"]');
    }
    if (Object.hasOwn(manifest, "mcpServers")) {
      errors.push("manifest must not include mcpServers without real MCP files");
    }
    if (manifest.interface === undefined || typeof manifest.interface !== "object") {
      errors.push("manifest interface metadata is required");
    }

    const skillsPath = join(root, normalizePluginPath(manifest.skills ?? ""));
    if (await pathExists(skillsPath)) {
      checked.push("skills/");
    } else {
      errors.push(`missing skills path: ${normalizePluginPath(manifest.skills ?? "")}`);
    }

    const futureSkillPath = "skills/ask-pro/SKILL.md";
    if (await pathExists(join(root, futureSkillPath))) {
      checked.push(futureSkillPath);
    } else {
      warnings.push(`missing-later: ${futureSkillPath}`);
    }

    for (const hookPath of manifest.hooks ?? []) {
      const normalizedHookPath = normalizePluginPath(hookPath);
      const absoluteHookPath = join(root, normalizedHookPath);
      if (!(await pathExists(absoluteHookPath))) {
        errors.push(`missing hook path: ${normalizedHookPath}`);
        continue;
      }

      checked.push(normalizedHookPath);
      const hookConfig = JSON.parse(await readFile(absoluteHookPath, "utf8"));
      if (findHookCommand(hookConfig) !== REQUIRED_HOOK_COMMAND) {
        errors.push(`hook command must be exactly: ${REQUIRED_HOOK_COMMAND}`);
      }
    }
  }

  for (const item of checked) {
    console.log(`ok: ${item}`);
  }
  for (const warning of warnings) {
    console.log(`warning: ${warning}`);
  }
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`error: ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("PASS validate-plugin");
}

async function readStdin() {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    stdin += chunk;
  }
  return stdin;
}

async function runHook(args) {
  const [eventName] = args;
  if (eventName !== "user-prompt-submit") {
    throw new Error(`unsupported hook: ${eventName ?? ""}`);
  }

  const event = parseHookInput(await readStdin());
  const output = renderUserPromptSubmitHook(event);
  if (output.length > 0) {
    process.stdout.write(output);
  }
}

async function ensureFixtureSession({ root, now, sessionId }) {
  try {
    return await readSession({ root, sessionId });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return createSession({ root, now, sessionId });
  }
}

async function sessionFixture(args) {
  const options = parseOptions(args);
  const root = requireOption(options, "root");
  const now = new Date(requireOption(options, "now"));
  const created = await createSession({ root, now, token: "fixture" });
  const snapshots = { created };

  if (options.submit === true) {
    snapshots.packaged = await transitionSession({ root, sessionId: created.id, status: "packaged", now });
    snapshots.submitted = await submitSession({ root, sessionId: created.id, now });
  }
  if (options["check-sequence"] === true) {
    const checkTime = new Date(snapshots.submitted.next_check_at);
    snapshots.checked = await recordWaitingCheck({ root, sessionId: created.id, now: checkTime });
  }

  process.stdout.write(`${JSON.stringify(snapshots, null, 2)}\n`);
}

async function sessionLockFixture(args) {
  const options = parseOptions(args);
  const root = requireOption(options, "root");
  const now = new Date(typeof options.now === "string" ? options.now : new Date().toISOString());
  const sessionId = typeof options["session-id"] === "string" ? options["session-id"] : "fixture-lock";

  await ensureFixtureSession({ root, now, sessionId });
  const lock = await acquireSessionLock({ root, sessionId, now });
  process.stdout.write(`${JSON.stringify({ locked: true, session_id: sessionId, lock_path: lock.path }, null, 2)}\n`);
}

async function schedulerFixture(args) {
  const options = parseOptions(args);
  const existingScheduleKeys = typeof options["existing-schedule-key"] === "string"
    ? [options["existing-schedule-key"]]
    : [];
  const output = planDelayedRetrievalSchedule({
    sessionId: requireOption(options, "session-id"),
    submittedAt: requireOption(options, "submitted-at"),
    now: requireOption(options, "now"),
    automation: requireOption(options, "automation"),
    existingScheduleKeys,
  });

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (output.status === "failed") {
    process.exitCode = 1;
  }
}

async function prepareContext(args) {
  const options = parseOptions(args);
  const result = await prepareContextPackage({
    project: requireOption(options, "project"),
    request: requireOption(options, "request"),
    out: requireOption(options, "out"),
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        status: result.status,
        manifest: result.manifestPath,
        prompt: result.promptPath,
        zip: result.zipPath,
      },
      null,
      2,
    )}\n`,
  );
}

async function chatGptPreflight(args) {
  const options = parseOptions(args);
  const report = await runChatGptPreflight({
    evidenceDir: requireOption(options, "evidence"),
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "validate-plugin":
      await validatePlugin(args);
      break;
    case "hook":
      await runHook(args);
      break;
    case "session-fixture":
      await sessionFixture(args);
      break;
    case "session-lock-fixture":
      await sessionLockFixture(args);
      break;
    case "scheduler-fixture":
      await schedulerFixture(args);
      break;
    case "prepare-context":
      await prepareContext(args);
      break;
    case "chatgpt-preflight":
      await chatGptPreflight(args);
      break;
    default:
      throw new Error(`unknown command: ${command ?? ""}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof MalformedHookInputError) {
      console.error(error.message);
      process.exit(1);
    }
    if (error instanceof AskProSessionLockedError) {
      console.error(error.message);
      process.exit(1);
    }
    if (error instanceof AskProSchedulerInputError) {
      console.error(error.message);
      process.exit(1);
    }
    if (error instanceof ChatGptMacError) {
      console.error(error.message);
      if (typeof error.action === "string") {
        console.error(`action: ${error.action}`);
      }
      process.exit(1);
    }
    console.error(error.message);
    process.exit(1);
  });
}
