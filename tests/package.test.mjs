import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const command = join(root, "scripts/ask-pro.mjs");

async function unzipList(archive) {
  const { stdout } = await execFileAsync("unzip", ["-Z1", archive], { encoding: "utf8" });
  return stdout.trim().split("\n").filter(Boolean).sort();
}

test("pack-plugin archives only distributable plugin files", async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), "ask-pro-pack-"));
  const archive = join(fixtureDir, "ask-pro.zip");

  const { stdout } = await execFileAsync(process.execPath, [
    command,
    "pack-plugin",
    "--root",
    root,
    "--out",
    archive,
  ]);
  const report = JSON.parse(stdout);
  const entries = await unzipList(archive);

  assert.equal(report.status, "packed");
  assert.equal(entries.includes(".codex-plugin/plugin.json"), true);
  assert.equal(entries.includes("hooks/user-prompt-submit-ask-pro.json"), true);
  assert.equal(entries.includes("skills/ask-pro/SKILL.md"), true);
  assert.equal(entries.includes("scripts/ask-pro.mjs"), true);
  assert.equal(entries.includes("tests/package.test.mjs"), true);
  assert.equal(entries.includes("README.md"), true);
  assert.equal(entries.includes("package.json"), true);
  assert.equal(entries.some((entry) => entry.startsWith(".git/")), false);
  assert.equal(entries.some((entry) => entry.startsWith(".ask-pro/")), false);
  assert.equal(entries.some((entry) => entry.startsWith("node_modules/")), false);
  assert.deepEqual(entries, report.files);
});

test("pack-plugin excludes sensitive local state from package input", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ask-pro-fixture-"));
  for (const path of [".codex-plugin", "hooks", "skills", "scripts", "tests"]) {
    await cp(join(root, path), join(fixtureRoot, path), { recursive: true });
  }
  await cp(join(root, "README.md"), join(fixtureRoot, "README.md"));
  await cp(join(root, "package.json"), join(fixtureRoot, "package.json"));
  await mkdir(join(fixtureRoot, ".ask-pro/sessions"), { recursive: true });
  await mkdir(join(fixtureRoot, "node_modules/pkg"), { recursive: true });
  await mkdir(join(fixtureRoot, ".git"), { recursive: true });
  await writeFile(join(fixtureRoot, ".ask-pro/sessions/raw.md"), "raw transcript");
  await writeFile(join(fixtureRoot, "node_modules/pkg/index.js"), "module");
  await writeFile(join(fixtureRoot, ".git/config"), "local git state");

  const archive = join(fixtureRoot, "ask-pro.zip");
  await execFileAsync(process.execPath, [command, "pack-plugin", "--root", fixtureRoot, "--out", archive]);
  const entries = await unzipList(archive);

  assert.equal(entries.some((entry) => entry.includes(".ask-pro/")), false);
  assert.equal(entries.some((entry) => entry.includes("node_modules/")), false);
  assert.equal(entries.some((entry) => entry.includes(".git/")), false);
});
