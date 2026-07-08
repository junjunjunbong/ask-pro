import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const STATIC_FILES = Object.freeze([
  ".codex-plugin/plugin.json",
  "hooks/user-prompt-submit-ask-pro.json",
  "skills/ask-pro/SKILL.md",
  "README.md",
  "package.json",
]);

const DISTRIBUTION_DIRS = Object.freeze([
  { dir: "scripts", extensions: new Set([".mjs", ".applescript"]) },
  { dir: "tests", extensions: new Set([".mjs"]) },
]);

const SENSITIVE_PARTS = new Set([
  ".git",
  ".ask-pro",
  ".omo",
  "node_modules",
  ".cache",
  ".DS_Store",
]);

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function assertRelativeSafe(path) {
  if (path.length === 0 || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`unsafe package path: ${path}`);
  }
}

function sensitiveReason(path) {
  const parts = path.split("/");
  if (parts.some((part) => SENSITIVE_PARTS.has(part))) return "sensitive-artifact";
  const lower = path.toLowerCase();
  if (
    lower.includes(".env") ||
    lower.includes("secret") ||
    lower.includes("credential") ||
    lower.includes("cookie") ||
    lower.includes("auth-header")
  ) {
    return "sensitive-artifact";
  }
  return null;
}

async function walkAllowed(root, dir, extensions, current = join(root, dir)) {
  const entries = await readdir(current, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const relativePath = toPosixPath(relative(root, absolute));
    const reason = sensitiveReason(relativePath);
    if (reason !== null) {
      throw new Error(`${reason}: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      paths.push(...(await walkAllowed(root, dir, extensions, absolute)));
      continue;
    }
    if (entry.isFile() && extensions.has(extname(entry.name))) {
      paths.push(relativePath);
    }
  }
  return paths;
}

export async function collectPluginPackageFiles(rootInput) {
  const root = resolve(rootInput);
  const files = [];
  for (const path of STATIC_FILES) {
    assertRelativeSafe(path);
    const reason = sensitiveReason(path);
    if (reason !== null) throw new Error(`${reason}: ${path}`);
    await stat(join(root, path));
    files.push(path);
  }
  for (const { dir, extensions } of DISTRIBUTION_DIRS) {
    files.push(...(await walkAllowed(root, dir, extensions)));
  }
  return [...new Set(files)].sort();
}

export async function packPluginBundle({ root, out }) {
  const absoluteRoot = resolve(root);
  const outputPath = resolve(out);
  const files = await collectPluginPackageFiles(absoluteRoot);
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });
  await execFileAsync("zip", ["-qD", outputPath, ...files], {
    cwd: absoluteRoot,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return { archive: outputPath, files };
}
