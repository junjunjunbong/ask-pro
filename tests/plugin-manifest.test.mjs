import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const command = join(root, "scripts/ask-pro.mjs");

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

test("validate-plugin reports manifest, hook, and skill guardrail contract", async () => {
  // Given: the plugin root.
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
  assert.match(stdout, /skills\/ask-pro\/SKILL\.md/);
  assert.match(stdout, /skill guardrails/);
});

test("validate-skill passes the ask-pro skill guardrail contract", async () => {
  // Given: the approved ask-pro skill file.
  const skillPath = join(root, "skills/ask-pro/SKILL.md");

  // When: the dedicated skill validator runs through the CLI surface.
  const { stdout } = await execFileAsync(process.execPath, [command, "validate-skill", "--path", skillPath]);

  // Then: it reports the skill as valid.
  assert.match(stdout, /PASS validate-skill/);
});

test("validate-skill fails when Chrome browser fallback guardrail is removed", async () => {
  // Given: a temporary skill fixture with the browser fallback guardrail removed.
  const source = await readFile(join(root, "skills/ask-pro/SKILL.md"), "utf8");
  const fixtureDir = await mkdtemp(join(tmpdir(), "ask-pro-skill-"));
  const fixturePath = join(fixtureDir, "SKILL.md");
  await writeFile(
    fixturePath,
    source
      .replace("Do not use Chrome, browser control, web tabs, or a browser fallback.", "Do not use Chrome automation.")
      .replace("No Chrome or browser fallback.", "No Chrome automation."),
  );

  // When: the dedicated skill validator runs against the broken fixture.
  let failure;
  try {
    await execFileAsync(process.execPath, [command, "validate-skill", "--path", fixturePath]);
  } catch (error) {
    failure = error;
  }

  // Then: the process fails and names the missing semantic guardrail.
  assert.equal(failure?.code, 1);
  assert.match(failure.stderr, /skill guardrail missing \(no Chrome\/browser fallback wording\)/);
});
