import { access } from "node:fs/promises";

export function parseOptions(args) {
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

export function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing --${name}`);
  }
  return value;
}

export function optionalString(options, name) {
  return typeof options[name] === "string" && options[name].length > 0 ? options[name] : undefined;
}

export async function pathExists(path) {
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

export async function readStdin() {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    stdin += chunk;
  }
  return stdin;
}
