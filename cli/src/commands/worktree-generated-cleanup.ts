import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { printPaperclipCliBanner } from "../utils/banner.js";

const DEFAULT_MIN_AGE_HOURS = 24;
const DEFAULT_MAX_DEPTH = 6;

const GENERATED_DIRECTORY_KINDS: Record<string, GeneratedCleanupCandidateKind> = {
  node_modules: "dependency",
  bower_components: "dependency",
  ".pnpm-store": "dependency",
  ".next": "build",
  ".nuxt": "build",
  ".svelte-kit": "build",
  dist: "build",
  build: "build",
  out: "build",
  "storybook-static": "build",
  target: "build",
  coverage: "cache",
  ".vite": "cache",
  ".turbo": "cache",
  ".cache": "cache",
  ".parcel-cache": "cache",
  ".pytest_cache": "cache",
  ".ruff_cache": "cache",
  ".mypy_cache": "cache",
  ".tox": "cache",
  ".gradle": "cache",
};

const GENERATED_RELATIVE_PATH_KINDS: Record<string, GeneratedCleanupCandidateKind> = {
  ".yarn/cache": "dependency",
  ".yarn/unplugged": "dependency",
};

const TRAVERSAL_EXCLUDED_NAMES = new Set([
  ".git",
  ".paperclip",
]);

export type GeneratedCleanupCandidateKind = "dependency" | "build" | "cache";

export type GeneratedCleanupCandidateAction =
  | "would_delete"
  | "deleted"
  | "skipped"
  | "failed";

export type GeneratedCleanupCandidate = {
  path: string;
  relativePath: string;
  kind: GeneratedCleanupCandidateKind;
  sizeBytes: number;
  ageHours: number;
  ignored: boolean;
  trackedFileCount: number;
  action: GeneratedCleanupCandidateAction;
  reason: string | null;
};

export type GeneratedCleanupWorktree = {
  path: string;
  branch: string | null;
  source: "git_worktree" | "explicit";
  status: "scanned" | "skipped";
  reason: string | null;
  liveProcessCheck: "passed" | "active" | "unavailable" | "skipped";
  candidates: GeneratedCleanupCandidate[];
};

export type GeneratedCleanupSummary = {
  scannedWorktrees: number;
  skippedWorktrees: number;
  totalCandidates: number;
  eligibleCandidates: number;
  skippedCandidates: number;
  deletedCandidates: number;
  failedCandidates: number;
  eligibleBytes: number;
  deletedBytes: number;
  apply: boolean;
  minAgeHours: number;
};

export type GeneratedCleanupPlan = {
  generatedAt: string;
  cwd: string;
  roots: string[];
  summary: GeneratedCleanupSummary;
  worktrees: GeneratedCleanupWorktree[];
};

export type WorktreeGeneratedCleanupOptions = {
  apply?: boolean;
  allGitWorktrees?: boolean;
  includeCurrent?: boolean;
  root?: string | string[];
  minAgeHours?: number;
  maxDepth?: number;
  json?: boolean;
};

export type PlanGeneratedDependencyCleanupInput = WorktreeGeneratedCleanupOptions & {
  cwd?: string;
  now?: Date;
  checkLiveProcesses?: boolean;
};

type ParsedGitWorktree = {
  worktree: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
};

type RootCandidate = {
  path: string;
  branch: string | null;
  source: "git_worktree" | "explicit";
};

export function collectGeneratedCleanupRoot(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function planGeneratedDependencyCleanup(
  input: PlanGeneratedDependencyCleanupInput = {},
): GeneratedCleanupPlan {
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const now = input.now ?? new Date();
  const minAgeHours = normalizeNonNegativeNumber(input.minAgeHours, DEFAULT_MIN_AGE_HOURS, "min age hours");
  const maxDepth = Math.floor(normalizeNonNegativeNumber(input.maxDepth, DEFAULT_MAX_DEPTH, "max depth"));
  const currentGitRoot = resolveGitRoot(cwd);
  const roots = resolveCleanupRoots(input, cwd, currentGitRoot);
  const dedupedRoots = dedupeRootsByGitRoot(roots);
  const worktrees = dedupedRoots.map((root) =>
    inspectCleanupWorktree({
      root,
      currentGitRoot,
      includeCurrent: input.includeCurrent === true,
      checkLiveProcesses: input.checkLiveProcesses !== false,
      minAgeHours,
      maxDepth,
      now,
    }),
  );
  const summary = summarizeCleanupPlan(worktrees, input.apply === true, minAgeHours);

  return {
    generatedAt: now.toISOString(),
    cwd,
    roots: dedupedRoots.map((root) => root.path),
    summary,
    worktrees,
  };
}

export function runGeneratedDependencyCleanup(
  input: PlanGeneratedDependencyCleanupInput = {},
): GeneratedCleanupPlan {
  const plan = planGeneratedDependencyCleanup(input);
  if (input.apply === true) {
    applyGeneratedDependencyCleanupPlan(plan);
  }
  plan.summary = summarizeCleanupPlan(
    plan.worktrees,
    input.apply === true,
    plan.summary.minAgeHours,
  );
  return plan;
}

export async function worktreeGeneratedCleanupCommand(
  opts: WorktreeGeneratedCleanupOptions,
): Promise<void> {
  if (!opts.json) {
    printPaperclipCliBanner();
    p.intro(pc.bgCyan(pc.black(" paperclipai worktree:clean-generated ")));
  }

  const plan = runGeneratedDependencyCleanup(opts);

  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    printCleanupPlan(plan);
  }

  if (plan.summary.failedCandidates > 0) {
    throw new Error(`${plan.summary.failedCandidates} generated director${plan.summary.failedCandidates === 1 ? "y" : "ies"} failed cleanup.`);
  }

  if (!opts.json) {
    const action = opts.apply ? "Cleanup complete." : "Dry run complete.";
    p.outro(pc.green(action));
  }
}

function normalizeNonNegativeNumber(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (Number.isNaN(value) || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${String(value)}.`);
  }
  return value;
}

function resolveCleanupRoots(
  input: PlanGeneratedDependencyCleanupInput,
  cwd: string,
  currentGitRoot: string | null,
): RootCandidate[] {
  const explicitRoots = normalizeRootOptions(input.root);
  if (explicitRoots.length > 0) {
    return explicitRoots.map((root) => ({
      path: path.resolve(cwd, root),
      branch: null,
      source: "explicit",
    }));
  }

  const entries = parseGitWorktreeList(cwd);
  const roots = entries
    .filter((entry) => !entry.bare)
    .filter((entry) => input.allGitWorktrees === true || isPaperclipManagedWorktree(entry.worktree))
    .map((entry) => ({
      path: path.resolve(entry.worktree),
      branch: entry.branch,
      source: "git_worktree" as const,
    }));

  if (roots.length > 0) return roots;
  if (currentGitRoot) {
    return [{
      path: currentGitRoot,
      branch: null,
      source: "git_worktree",
    }];
  }
  return [];
}

function normalizeRootOptions(root: string | string[] | undefined): string[] {
  if (!root) return [];
  const values = Array.isArray(root) ? root : [root];
  return values.map((value) => value.trim()).filter(Boolean);
}

function dedupeRootsByGitRoot(roots: RootCandidate[]): RootCandidate[] {
  const seen = new Set<string>();
  const result: RootCandidate[] = [];
  for (const root of roots) {
    const gitRoot = resolveGitRoot(root.path) ?? path.resolve(root.path);
    const key = path.resolve(gitRoot);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...root,
      path: key,
    });
  }
  return result;
}

function inspectCleanupWorktree(input: {
  root: RootCandidate;
  currentGitRoot: string | null;
  includeCurrent: boolean;
  checkLiveProcesses: boolean;
  minAgeHours: number;
  maxDepth: number;
  now: Date;
}): GeneratedCleanupWorktree {
  const rootPath = path.resolve(input.root.path);
  const base: GeneratedCleanupWorktree = {
    path: rootPath,
    branch: input.root.branch,
    source: input.root.source,
    status: "skipped",
    reason: null,
    liveProcessCheck: input.checkLiveProcesses ? "unavailable" : "skipped",
    candidates: [],
  };

  if (!existsSync(rootPath)) {
    return {
      ...base,
      reason: "worktree path does not exist",
    };
  }

  const gitRoot = resolveGitRoot(rootPath);
  if (!gitRoot) {
    return {
      ...base,
      reason: "path is not inside a git worktree",
    };
  }

  if (!input.includeCurrent && input.currentGitRoot && path.resolve(gitRoot) === path.resolve(input.currentGitRoot)) {
    return {
      ...base,
      path: gitRoot,
      reason: "current worktree is skipped by default; pass --include-current to scan it",
    };
  }

  const cleanState = readGitPorcelainStatus(gitRoot);
  if (cleanState === null) {
    return {
      ...base,
      path: gitRoot,
      reason: "could not read git status",
    };
  }
  if (cleanState.length > 0) {
    return {
      ...base,
      path: gitRoot,
      reason: "worktree has uncommitted or untracked source changes",
    };
  }

  let liveProcessCheck: GeneratedCleanupWorktree["liveProcessCheck"] = input.checkLiveProcesses
    ? "unavailable"
    : "skipped";
  if (input.checkLiveProcesses) {
    const hasLiveProcess = hasLiveProcessCwdUnder(gitRoot);
    if (hasLiveProcess === true) {
      return {
        ...base,
        path: gitRoot,
        liveProcessCheck: "active",
        reason: "a running process has its current directory inside this worktree",
      };
    }
    liveProcessCheck = hasLiveProcess === false ? "passed" : "unavailable";
  }

  return {
    ...base,
    path: gitRoot,
    status: "scanned",
    reason: null,
    liveProcessCheck,
    candidates: scanGeneratedDirectories({
      root: gitRoot,
      minAgeHours: input.minAgeHours,
      maxDepth: input.maxDepth,
      now: input.now,
    }),
  };
}

function scanGeneratedDirectories(input: {
  root: string;
  minAgeHours: number;
  maxDepth: number;
  now: Date;
}): GeneratedCleanupCandidate[] {
  const candidates: GeneratedCleanupCandidate[] = [];
  const root = path.resolve(input.root);
  const nowMs = input.now.getTime();

  function walk(dir: string, depth: number): void {
    if (depth >= input.maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (TRAVERSAL_EXCLUDED_NAMES.has(entry.name)) continue;

      const absolutePath = path.resolve(dir, entry.name);
      if (!isPathInside(absolutePath, root)) continue;
      const relativePath = toPosixPath(path.relative(root, absolutePath));
      const kind = classifyGeneratedDirectory(relativePath, entry.name);
      if (kind) {
        candidates.push(evaluateGeneratedDirectory({
          root,
          absolutePath,
          relativePath,
          kind,
          minAgeHours: input.minAgeHours,
          nowMs,
        }));
        continue;
      }
      walk(absolutePath, depth + 1);
    }
  }

  walk(root, 0);
  return candidates;
}

function evaluateGeneratedDirectory(input: {
  root: string;
  absolutePath: string;
  relativePath: string;
  kind: GeneratedCleanupCandidateKind;
  minAgeHours: number;
  nowMs: number;
}): GeneratedCleanupCandidate {
  const stats = statSync(input.absolutePath);
  const ageHours = Math.max(0, (input.nowMs - stats.mtimeMs) / 3_600_000);
  const ignored = isGitIgnored(input.root, input.relativePath);
  const trackedFileCount = countTrackedFilesUnder(input.root, input.relativePath);
  const sizeBytes = getDirectorySizeBytes(input.absolutePath);
  const base = {
    path: input.absolutePath,
    relativePath: input.relativePath,
    kind: input.kind,
    sizeBytes,
    ageHours,
    ignored,
    trackedFileCount,
  };

  if (!ignored) {
    return {
      ...base,
      action: "skipped",
      reason: "directory is not ignored by git",
    };
  }
  if (trackedFileCount > 0) {
    return {
      ...base,
      action: "skipped",
      reason: "directory contains tracked files",
    };
  }
  if (ageHours < input.minAgeHours) {
    return {
      ...base,
      action: "skipped",
      reason: `directory is newer than ${formatHours(input.minAgeHours)}`,
    };
  }
  return {
    ...base,
    action: "would_delete",
    reason: null,
  };
}

function applyGeneratedDependencyCleanupPlan(plan: GeneratedCleanupPlan): void {
  for (const worktree of plan.worktrees) {
    if (worktree.status !== "scanned") continue;
    for (const candidate of worktree.candidates) {
      if (candidate.action !== "would_delete") continue;
      if (!isPathInside(candidate.path, worktree.path)) {
        candidate.action = "failed";
        candidate.reason = "candidate path is outside the worktree";
        continue;
      }
      try {
        rmSync(candidate.path, { recursive: true, force: true });
        candidate.action = "deleted";
        candidate.reason = null;
      } catch (error) {
        candidate.action = "failed";
        candidate.reason = error instanceof Error ? error.message : String(error);
      }
    }
  }
}

function summarizeCleanupPlan(
  worktrees: GeneratedCleanupWorktree[],
  apply: boolean,
  minAgeHours: number,
): GeneratedCleanupSummary {
  const candidates = worktrees.flatMap((worktree) => worktree.candidates);
  const eligible = candidates.filter((candidate) =>
    candidate.action === "would_delete" || candidate.action === "deleted",
  );
  const deleted = candidates.filter((candidate) => candidate.action === "deleted");
  const failed = candidates.filter((candidate) => candidate.action === "failed");
  return {
    scannedWorktrees: worktrees.filter((worktree) => worktree.status === "scanned").length,
    skippedWorktrees: worktrees.filter((worktree) => worktree.status === "skipped").length,
    totalCandidates: candidates.length,
    eligibleCandidates: eligible.length,
    skippedCandidates: candidates.filter((candidate) => candidate.action === "skipped").length,
    deletedCandidates: deleted.length,
    failedCandidates: failed.length,
    eligibleBytes: eligible.reduce((total, candidate) => total + candidate.sizeBytes, 0),
    deletedBytes: deleted.reduce((total, candidate) => total + candidate.sizeBytes, 0),
    apply,
    minAgeHours,
  };
}

function classifyGeneratedDirectory(
  relativePath: string,
  basename: string,
): GeneratedCleanupCandidateKind | null {
  const normalized = toPosixPath(relativePath);
  const relativeKind = GENERATED_RELATIVE_PATH_KINDS[normalized];
  if (relativeKind) return relativeKind;
  return GENERATED_DIRECTORY_KINDS[basename] ?? null;
}

function isGitIgnored(root: string, relativePath: string): boolean {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", "--", relativePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function countTrackedFilesUnder(root: string, relativePath: string): number {
  try {
    const output = execFileSync("git", ["-C", root, "ls-files", "--", relativePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!output) return 0;
    return output.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function getDirectorySizeBytes(dir: string): number {
  try {
    const output = execFileSync("du", ["-sk", "--", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const kib = Number(output.split(/\s+/)[0] ?? "0");
    return Number.isFinite(kib) ? kib * 1024 : 0;
  } catch {
    return 0;
  }
}

function readGitPorcelainStatus(root: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function resolveGitRoot(cwd: string): string | null {
  try {
    const output = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return output ? path.resolve(output) : null;
  } catch {
    return null;
  }
}

function parseGitWorktreeList(cwd: string): ParsedGitWorktree[] {
  try {
    const raw = execFileSync("git", ["-C", cwd, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const entries: ParsedGitWorktree[] = [];
    let current: Partial<ParsedGitWorktree> = {};
    for (const line of raw.split("\n")) {
      if (line.startsWith("worktree ")) {
        current = {
          worktree: line.slice("worktree ".length),
          branch: null,
          bare: false,
          detached: false,
          prunable: false,
        };
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length);
      } else if (line === "bare") {
        current.bare = true;
      } else if (line === "detached") {
        current.detached = true;
      } else if (line.startsWith("prunable")) {
        current.prunable = true;
      } else if (line === "" && current.worktree) {
        entries.push({
          worktree: current.worktree,
          branch: current.branch ?? null,
          bare: current.bare ?? false,
          detached: current.detached ?? false,
          prunable: current.prunable ?? false,
        });
        current = {};
      }
    }
    if (current.worktree) {
      entries.push({
        worktree: current.worktree,
        branch: current.branch ?? null,
        bare: current.bare ?? false,
        detached: current.detached ?? false,
        prunable: current.prunable ?? false,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

function isPaperclipManagedWorktree(worktreePath: string): boolean {
  const normalized = toPosixPath(path.resolve(worktreePath));
  return normalized.includes("/.paperclip/instances/") || normalized.includes("/.paperclip-worktrees/instances/");
}

function hasLiveProcessCwdUnder(root: string): boolean | null {
  const procRoot = "/proc";
  if (!existsSync(procRoot)) return null;
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return null;
  }
  const normalizedRoot = path.resolve(root);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const cwd = path.resolve(readlinkSync(path.join(procRoot, entry, "cwd")));
      if (cwd === normalizedRoot || cwd.startsWith(`${normalizedRoot}${path.sep}`)) {
        return true;
      }
    } catch {
      // Process exited or cwd is not readable.
    }
  }
  return false;
}

function isPathInside(candidatePath: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function printCleanupPlan(plan: GeneratedCleanupPlan): void {
  const { summary } = plan;
  if (!summary.apply) {
    p.log.warning("Dry run only. Re-run with --apply to delete eligible generated directories.");
  }
  p.log.message(
    [
      `Scanned worktrees: ${summary.scannedWorktrees}`,
      `Skipped worktrees: ${summary.skippedWorktrees}`,
      `Eligible candidates: ${summary.eligibleCandidates}`,
      `Reclaimable: ${formatBytes(summary.eligibleBytes)}`,
      summary.apply ? `Deleted: ${summary.deletedCandidates} (${formatBytes(summary.deletedBytes)})` : null,
    ].filter(Boolean).join(" | "),
  );

  for (const worktree of plan.worktrees) {
    const label = worktree.branch ? `${worktree.path} (${worktree.branch.replace(/^refs\/heads\//, "")})` : worktree.path;
    if (worktree.status === "skipped") {
      p.log.info(`${pc.dim("skip worktree")} ${label}: ${worktree.reason ?? "not eligible"}`);
      continue;
    }
    if (worktree.candidates.length === 0) {
      p.log.info(`${pc.dim("no candidates")} ${label}`);
      continue;
    }
    p.log.info(`${pc.bold("worktree")} ${label}`);
    for (const candidate of worktree.candidates) {
      const action = formatCandidateAction(candidate.action);
      const detail = [
        candidate.kind,
        formatBytes(candidate.sizeBytes),
        `${formatHours(candidate.ageHours)} old`,
        candidate.reason,
      ].filter(Boolean).join(", ");
      p.log.message(`  ${action} ${candidate.relativePath} (${detail})`);
    }
  }
}

function formatCandidateAction(action: GeneratedCleanupCandidateAction): string {
  if (action === "would_delete") return pc.yellow("would delete");
  if (action === "deleted") return pc.green("deleted");
  if (action === "failed") return pc.red("failed");
  return pc.dim("skip");
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
  const days = hours / 24;
  return `${days.toFixed(days >= 10 ? 0 : 1)}d`;
}
