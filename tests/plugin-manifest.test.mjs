import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;

test("manifest names distributable ask-pro plugin when present", async () => {
  // Given: the distributable plugin manifest path.
  const manifestPath = join(root, ".codex-plugin/plugin.json");

  // When: the manifest is parsed.
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  // Then: it exposes the plugin contract expected by Codex plugin packaging.
  assert.equal(manifest.name, "ask-pro");
  assert.equal(manifest.skills, "./skills/");
  assert.deepEqual(manifest.hooks, ["./hooks/user-prompt-submit-ask-pro.json"]);
  assert.equal(manifest.interface?.title, "Ask Pro");
  assert.equal(manifest.interface?.description.length > 0, true);
  assert.equal(Object.hasOwn(manifest, "mcpServers"), false);
});

test("validate-plugin reports manifest, hook, and future skill contract", async () => {
  // Given: the plugin root.
  const command = join(root, "scripts/ask-pro.mjs");

  // When: the validator runs through the CLI surface.
  const { stdout } = await execFileAsync(process.execPath, [
    command,
    "validate-plugin",
    "--root",
    root,
  ]);

  // Then: concrete plugin artifacts are named in machine-checkable output.
  assert.match(stdout, /\.codex-plugin\/plugin\.json/);
  assert.match(stdout, /hooks\/user-prompt-submit-ask-pro\.json/);
  assert.match(stdout, /missing-later: skills\/ask-pro\/SKILL\.md|skills\/ask-pro\/SKILL\.md/);
});
