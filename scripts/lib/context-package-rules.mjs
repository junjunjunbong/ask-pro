import { basename, extname, resolve, sep } from "node:path";

export const DEFAULT_CONTEXT_LIMITS = Object.freeze({
  maxFiles: 80,
  maxTextBytes: 15 * 1024 * 1024,
  maxArchiveBytes: 25 * 1024 * 1024,
});

const EXCLUDED_DIRS = new Set([
  ".git",
  ".ask-pro",
  "node_modules",
  ".cache",
  "cache",
  "caches",
  ".next",
  ".nuxt",
  ".turbo",
  ".vite",
  "dist",
  "build",
  "coverage",
  "target",
  "__pycache__",
]);

const LARGE_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".bin",
  ".bmp",
  ".ckpt",
  ".dmg",
  ".exe",
  ".gif",
  ".gz",
  ".heic",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".onnx",
  ".pdf",
  ".png",
  ".pt",
  ".safetensors",
  ".sqlite",
  ".tar",
  ".tgz",
  ".webp",
  ".zip",
]);

const PROJECT_METADATA = new Set([
  "AGENTS.md",
  "README",
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
]);

const REQUEST_STOP_WORDS = new Set([
  "ask",
  "pro",
  "please",
  "fix",
  "change",
  "update",
  "make",
  "the",
  "this",
  "that",
  "with",
  "from",
  "into",
]);

export function createContextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function toPosixPath(path) {
  return path.split(sep).join("/");
}

export function isInside(parent, child) {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

function validateRelativePath(path) {
  if (path.length === 0 || path.startsWith("/") || path.split("/").includes("..")) {
    return false;
  }
  return true;
}

export function excludedPathReason(path) {
  if (!validateRelativePath(path)) {
    return "unsafe-path";
  }

  const parts = path.split("/");
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) {
    return "excluded-path";
  }

  const fileName = basename(path);
  const lowerName = fileName.toLowerCase();
  const lowerPath = path.toLowerCase();
  if (lowerName === ".env" || lowerName.startsWith(".env.")) {
    return "excluded-path";
  }
  if (
    lowerPath.includes("secret") ||
    lowerPath.includes("credential") ||
    lowerPath.includes("cookie") ||
    lowerPath.includes("auth-header")
  ) {
    return "excluded-path";
  }
  if (LARGE_BINARY_EXTENSIONS.has(extname(lowerName))) {
    return "binary";
  }
  return null;
}

export function looksBinary(buffer) {
  if (buffer.length === 0) {
    return false;
  }
  const sampleLength = Math.min(buffer.length, 8192);
  let controlCount = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index];
    if (byte === 0) {
      return true;
    }
    if (byte < 8 || (byte > 13 && byte < 32)) {
      controlCount += 1;
    }
  }
  return controlCount / sampleLength > 0.05;
}

export function secretReason(text) {
  if (/(api[_-]?key|secret|password|credential|authorization|cookie|set-cookie)\s*[:=]/iu.test(text)) {
    return "secret-pattern";
  }
  if (/bearer\s+[a-z0-9._-]{16,}/iu.test(text)) {
    return "secret-pattern";
  }
  return null;
}

export function tokenizeRequest(request) {
  const tokens = request
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{2,}/gu);
  return [...new Set((tokens ?? []).filter((token) => !REQUEST_STOP_WORDS.has(token)))];
}

function isProjectMetadata(path) {
  const fileName = basename(path);
  return PROJECT_METADATA.has(fileName);
}

export function scoreFile({ path, text, requestTokens, changedPaths }) {
  if (changedPaths.has(path)) {
    return { score: 100, reason: "git-changed" };
  }
  if (isProjectMetadata(path)) {
    return { score: 50, reason: "project-metadata" };
  }

  const lowerPath = path.toLowerCase();
  const lowerText = text.toLowerCase();
  let score = 0;
  const matched = [];
  for (const token of requestTokens) {
    if (lowerPath.includes(token)) {
      score += 20;
      matched.push(token);
      continue;
    }
    if (lowerText.includes(token)) {
      score += 5;
      matched.push(token);
    }
  }
  return { score, reason: matched.length > 0 ? `request-match:${matched.join(",")}` : "not-relevant" };
}
