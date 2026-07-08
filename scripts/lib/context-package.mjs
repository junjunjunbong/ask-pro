import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  copySelectedFiles,
  renderPrompt,
  writeManifest,
  zipContext,
} from "./context-package-archive.mjs";
import {
  detectGit,
  gitCandidates,
  gitInfo,
  readCandidate,
  walkCandidates,
} from "./context-package-files.mjs";
import {
  createContextError,
  DEFAULT_CONTEXT_LIMITS,
  isInside,
  scoreFile,
  tokenizeRequest,
} from "./context-package-rules.mjs";

export { DEFAULT_CONTEXT_LIMITS } from "./context-package-rules.mjs";

export async function prepareContextPackage({
  project,
  request,
  out,
  limits = DEFAULT_CONTEXT_LIMITS,
  now = new Date(),
}) {
  if (typeof project !== "string" || project.length === 0) {
    throw createContextError("ASK_PRO_INVALID_CONTEXT_INPUT", "missing project path");
  }
  if (typeof request !== "string" || request.trim().length === 0) {
    throw createContextError("ASK_PRO_INVALID_CONTEXT_INPUT", "missing request");
  }
  if (typeof out !== "string" || out.length === 0) {
    throw createContextError("ASK_PRO_INVALID_CONTEXT_INPUT", "missing output path");
  }

  const projectRoot = resolve(project);
  const outRoot = resolve(out);
  const projectStat = await stat(projectRoot).catch((error) => {
    if (error?.code === "ENOENT") {
      throw createContextError("ASK_PRO_INVALID_CONTEXT_INPUT", `project path does not exist: ${projectRoot}`);
    }
    throw error;
  });
  if (!projectStat.isDirectory()) {
    throw createContextError("ASK_PRO_INVALID_CONTEXT_INPUT", `project path is not a directory: ${projectRoot}`);
  }

  await mkdir(outRoot, { recursive: true });

  const isGitRepo = await detectGit(projectRoot);
  const git = await gitInfo(projectRoot, isGitRepo);
  const changedPaths = new Set(git.changed_paths);
  const requestTokens = tokenizeRequest(request);
  const candidatePaths = isGitRepo
    ? await gitCandidates(projectRoot)
    : await walkCandidates(projectRoot, outRoot);

  const skipped = [];
  const scoredFiles = [];
  for (const path of candidatePaths) {
    if (isInside(outRoot, resolve(projectRoot, path))) {
      skipped.push({ path, reason: "output-path" });
      continue;
    }
    const candidate = await readCandidate(projectRoot, path);
    if (candidate.skip !== undefined) {
      skipped.push(candidate.skip);
      continue;
    }
    const score = scoreFile({ ...candidate.file, requestTokens, changedPaths });
    if (score.score === 0) {
      skipped.push({ path, reason: score.reason, size_bytes: candidate.file.size_bytes });
      continue;
    }
    scoredFiles.push({ ...candidate.file, score: score.score, reason: score.reason });
  }

  scoredFiles.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  const selected = [];
  let selectedTextBytes = 0;
  let limitExceeded = false;
  for (const file of scoredFiles) {
    if (selected.length >= limits.maxFiles) {
      skipped.push({ path: file.path, reason: "max-files", size_bytes: file.size_bytes });
      limitExceeded = true;
      continue;
    }
    if (selectedTextBytes + file.size_bytes > limits.maxTextBytes) {
      skipped.push({ path: file.path, reason: "max-text-bytes", size_bytes: file.size_bytes });
      limitExceeded = true;
      continue;
    }
    selectedTextBytes += file.size_bytes;
    selected.push(file);
  }

  const manifest = {
    schema_version: 1,
    status: limitExceeded ? "limit_exceeded" : "ok",
    generated_at: now.toISOString(),
    request,
    project: { root: projectRoot },
    limits: {
      max_files: limits.maxFiles,
      max_text_bytes: limits.maxTextBytes,
      max_archive_bytes: limits.maxArchiveBytes,
    },
    totals: {
      candidate_files: candidatePaths.length,
      selected_files: selected.length,
      selected_text_bytes: selectedTextBytes,
      archive_bytes: 0,
    },
    git: {
      is_repo: git.is_repo,
      status: git.status,
      diff: git.diff,
      diff_bytes: Buffer.byteLength(git.diff),
    },
    files: {
      selected: selected.map(({ absolute, text, score, ...file }) => file),
      skipped: skipped.sort((left, right) => left.path.localeCompare(right.path)),
    },
  };

  const manifestPath = await writeManifest(outRoot, manifest);
  const promptPath = join(outRoot, "prompt.md");
  const zipPath = join(outRoot, "context.zip");

  if (limitExceeded) {
    await writeFile(promptPath, renderPrompt({ request, manifest, hasDiff: git.diff.length > 0 }));
    await rm(zipPath, { force: true });
    throw createContextError("ASK_PRO_CONTEXT_LIMIT_EXCEEDED", "context package exceeds configured limits");
  }

  const staging = join(outRoot, `.context-package-staging-${process.pid}`);
  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await copySelectedFiles(staging, selected);

    const prompt = renderPrompt({ request, manifest, hasDiff: git.diff.length > 0 });
    await writeFile(promptPath, prompt);
    await writeFile(join(staging, "prompt.md"), prompt);
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const zipEntries = ["manifest.json", "prompt.md"];
    if (git.diff.length > 0) {
      await writeFile(join(outRoot, "git-diff.patch"), git.diff);
      await writeFile(join(staging, "git-diff.patch"), git.diff);
      zipEntries.push("git-diff.patch");
    } else {
      await rm(join(outRoot, "git-diff.patch"), { force: true });
    }
    if (selected.length > 0) {
      zipEntries.push("files");
    }

    let archiveBytes = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await writeManifest(outRoot, manifest);
      await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      await zipContext({ staging, zipPath, entries: zipEntries });
      const archiveStat = await stat(zipPath);
      if (archiveStat.size === archiveBytes) {
        break;
      }
      archiveBytes = archiveStat.size;
      manifest.totals.archive_bytes = archiveBytes;
    }

    if (archiveBytes > limits.maxArchiveBytes) {
      manifest.status = "limit_exceeded";
      manifest.files.skipped.push({ path: "context.zip", reason: "max-archive-bytes", size_bytes: archiveBytes });
      await writeManifest(outRoot, manifest);
      await rm(zipPath, { force: true });
      throw createContextError("ASK_PRO_CONTEXT_LIMIT_EXCEEDED", "context archive exceeds configured limits");
    }

    return { status: manifest.status, manifestPath, promptPath, zipPath, manifest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
