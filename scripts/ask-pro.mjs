#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { ChatGptMacError } from "./lib/chatgpt-mac.mjs";
import {
  chatGptPreflight,
  MalformedHookInputError,
  prepareContext,
  runHook,
  schedulerFixture,
  sessionFixture,
  sessionLockFixture,
  validateSkill,
  validatePlugin,
} from "./commands/core.mjs";
import { checkCommand, submitCommand } from "./commands/workflow.mjs";
import { AskProSchedulerInputError } from "./lib/scheduler.mjs";
import { AskProSessionLockedError } from "./lib/session-store.mjs";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "validate-plugin":
      await validatePlugin(args);
      break;
    case "validate-skill":
      await validateSkill(args);
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
    case "submit":
      await submitCommand(args);
      break;
    case "check":
      await checkCommand(args);
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
