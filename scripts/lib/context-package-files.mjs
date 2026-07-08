import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  excludedPathReason,
  isInside,
  looksBinary,
  secretReason,
  toPosixPath,
} from "./context-package-rules.mjs";

const execFileAsync = promisify(execFile);

async function runGit(project, args) {
  return execFileAsync("git", args, {
    cwd: project,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

export async function detectGit(project) {
  try {
    const [{ stdout: inside }, { stdout: topLevel }] = await Promise.all([
      runGit(project, ["rev-parse", "--is-inside-work-tree"]),
      runGit(project, ["rev-parse", "--show-toplevel"]),
    ]);
    const [projectRealPath, topLevelRealPath] = await Promise.all([realpath(project), realpath(topLevel.trim())]);
    return inside.trim() === "true" && topLevelRealPath === projectRealPath;
  } catch {
    return false;
  }
}

export async function gitCandidates(project) {
  const { stdout } = await runGit(project, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return stdout.split("\0").filter(Boolean).map(toPosixPath).sort();
}

export async function walkCandidates(project, outputRoot, current = project) {
  const entries = await readdir(current, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (isInside(outputRoot, absolute)) {
      continue;
    }
    const rel = toPosixPath(relative(project, absolute));
    const excluded = excludedPathReason(rel);
    if (entry.isDirectory()) {
      if (excluded === null) {
        paths.push(...(await walkCandidates(project, outputRoot, absolute)));
      }
      continue;
    }
    if (entry.isFile()) {
      paths.push(rel);
    }
  }
  return paths.sort();
}

export async function gitInfo(project, isGitRepo) {
  if (!isGitRepo) {
    return { is_repo: false, status: "", diff: "", changed_paths: [] };
  }

  const [{ stdout: status }, { stdout: diff }, { stdout: changed }] = await Promise.all([
    runGit(project, ["status", "--short", "--", "."]),
    runGit(project, ["diff", "--no-ext-diff", "--no-color", "HEAD", "--", "."]),
    runGit(project, ["diff", "--name-only", "HEAD", "--", "."]),
  ]);
  return {
    is_repo: true,
    status,
    diff,
    changed_paths: changed.split("\n").filter(Boolean).map(toPosixPath),
  };
}

export async function readCandidate(project, relPath) {
  const absolute = resolve(project, relPath);
  if (!isInside(project, absolute)) {
    return { skip: { path: relPath, reason: "unsafe-path" } };
  }

  const fileStat = await lstat(absolute);
  if (!fileStat.isFile()) {
    return { skip: { path: relPath, reason: "not-file" } };
  }
  if (fileStat.isSymbolicLink()) {
    return { skip: { path: relPath, reason: "symlink" } };
  }

  const excluded = excludedPathReason(relPath);
  if (excluded !== null) {
    return { skip: { path: relPath, reason: excluded } };
  }

  const buffer = await readFile(absolute);
  if (looksBinary(buffer)) {
    return { skip: { path: relPath, reason: "binary", size_bytes: buffer.length } };
  }

  const text = buffer.toString("utf8");
  const secret = secretReason(text);
  if (secret !== null) {
    return { skip: { path: relPath, reason: secret, size_bytes: buffer.length } };
  }

  return { file: { path: relPath, absolute, text, size_bytes: buffer.length } };
}
