import * as p from "@clack/prompts";
import {
  collectGeneratedCleanupRoot,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MIN_AGE_HOURS,
  planGeneratedDependencyCleanup,
  runGeneratedDependencyCleanup,
  type GeneratedCleanupCandidate,
  type GeneratedCleanupCandidateAction,
  type GeneratedCleanupPlan,
  type WorktreeGeneratedCleanupOptions,
} from "@paperclipai/server/workspace-cleanup";
import pc from "picocolors";
import { printPaperclipCliBanner } from "../utils/banner.js";
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
export {
  collectGeneratedCleanupRoot,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MIN_AGE_HOURS,
  planGeneratedDependencyCleanup,
  runGeneratedDependencyCleanup,
};
export type {
  GeneratedCleanupCandidate,
  GeneratedCleanupCandidateAction,
  GeneratedCleanupPlan,
  WorktreeGeneratedCleanupOptions,
};

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
