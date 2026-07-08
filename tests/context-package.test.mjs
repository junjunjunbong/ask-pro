import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { prepareContextPackage } from "../scripts/lib/context-package.mjs";

const execFileAsync = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const command = join(root, "scripts/ask-pro.mjs");

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

async function unzipList(zipPath) {
  const { stdout } = await execFileAsync("unzip", ["-Z1", zipPath]);
  return stdout.trim().split("\n").filter(Boolean);
}

async function makeGitFixture(prefix = "ask-pro-context-") {
  const project = await mkdtemp(join(tmpdir(), prefix));
  await git(project, ["init"]);
  await git(project, ["config", "user.email", "ask-pro@example.test"]);
  await git(project, ["config", "user.name", "Ask Pro Test"]);
  await writeFile(join(project, ".gitignore"), "cache/\nbuild/\n*.ignored\n");
  await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src/parser.js"), "export function parse(input) {\n  return input.trim();\n}\n");
  await writeFile(join(project, "src/unrelated.js"), "export const unrelated = true;\n");
  await git(project, ["add", "."]);
  await git(project, ["commit", "-m", "initial"]);

  await writeFile(join(project, ".env"), "ASK_PRO_SECRET=do-not-include\n");
  await mkdir(join(project, ".ask-pro"), { recursive: true });
  await writeFile(join(project, ".ask-pro/state.json"), "{}\n");
  await mkdir(join(project, "node_modules/pkg"), { recursive: true });
  await writeFile(join(project, "node_modules/pkg/index.js"), "module.exports = true;\n");
  await mkdir(join(project, "cache"), { recursive: true });
  await writeFile(join(project, "cache/generated.txt"), "ignored generated cache\n");
  await writeFile(join(project, "large.bin"), Buffer.alloc(256 * 1024, 0));
  await writeFile(join(project, "src/parser.js"), "export function parse(input) {\n  return input.trim().toLowerCase();\n}\n");

  return project;
}

test("prepareContextPackage writes manifest, prompt, zip, selected files, and git diff safely", async () => {
  const project = await makeGitFixture();
  const out = await mkdtemp(join(tmpdir(), "ask-pro-context-out-"));

  try {
    const result = await prepareContextPackage({
      project,
      request: "ask pro fix parser",
      out,
      now: new Date("2026-07-08T00:00:00.000Z"),
    });
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const prompt = await readFile(result.promptPath, "utf8");
    const zipEntries = await unzipList(result.zipPath);

    assert.equal(manifest.status, "ok");
    assert.equal(manifest.project.root, project);
    assert.equal(manifest.request, "ask pro fix parser");
    assert.equal(manifest.git.is_repo, true);
    assert.match(manifest.git.diff, /toLowerCase/);
    assert.deepEqual(
      manifest.files.selected.map((file) => file.path).sort(),
      ["package.json", "src/parser.js"],
    );
    assert.equal(manifest.files.skipped.some((file) => file.path === ".env" && file.reason === "excluded-path"), true);
    assert.equal(manifest.files.skipped.some((file) => file.path === "large.bin" && file.reason === "binary"), true);

    assert.match(prompt, /ask pro fix parser/);
    assert.match(prompt, /src\/parser\.js/);
    assert.match(prompt, /git-diff\.patch/);
    assert.deepEqual(zipEntries.sort(), [
      "files/package.json",
      "files/src/parser.js",
      "git-diff.patch",
      "manifest.json",
      "prompt.md",
    ]);
    assert.equal(zipEntries.some((entry) => entry.includes(".env")), false);
    assert.equal(zipEntries.some((entry) => entry.includes(".git/")), false);
    assert.equal(zipEntries.some((entry) => entry.includes(".ask-pro/")), false);
    assert.equal(zipEntries.some((entry) => entry.includes("node_modules/")), false);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("prepareContextPackage fails closed with a limit-report manifest when too many files are relevant", async () => {
  const project = await mkdtemp(join(tmpdir(), "ask-pro-context-limit-"));
  const out = await mkdtemp(join(tmpdir(), "ask-pro-context-limit-out-"));

  try {
    for (let index = 0; index < 81; index += 1) {
      await writeFile(join(project, `parser-${String(index).padStart(2, "0")}.js`), "export const parser = true;\n");
    }

    await assert.rejects(
      () =>
        prepareContextPackage({
          project,
          request: "parser",
          out,
          now: new Date("2026-07-08T00:00:00.000Z"),
        }),
      (error) => error?.code === "ASK_PRO_CONTEXT_LIMIT_EXCEEDED",
    );
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "limit_exceeded");
    assert.equal(manifest.limits.max_files, 80);
    assert.equal(manifest.files.selected.length, 80);
    assert.equal(manifest.files.skipped.filter((file) => file.reason === "max-files").length, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("prepare-context CLI routes invalid input and successful packaging through ask-pro.mjs", async () => {
  const project = await makeGitFixture("ask-pro-context-cli-");
  const out = await mkdtemp(join(tmpdir(), "ask-pro-context-cli-out-"));

  try {
    const missing = await execFileAsync(process.execPath, [command, "prepare-context", "--project", project, "--out", out], {
      encoding: "utf8",
    }).then(
      () => ({ code: 0, stderr: "" }),
      (error) => ({ code: error.code, stderr: error.stderr }),
    );
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /missing --request/);

    const { stdout } = await execFileAsync(process.execPath, [
      command,
      "prepare-context",
      "--project",
      project,
      "--request",
      "ask pro fix parser",
      "--out",
      out,
    ]);
    const response = JSON.parse(stdout);
    assert.equal(response.status, "ok");
    assert.equal(response.manifest, join(out, "manifest.json"));
    assert.equal(response.prompt, join(out, "prompt.md"));
    assert.equal(response.zip, join(out, "context.zip"));
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});
