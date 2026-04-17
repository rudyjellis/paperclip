import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  planGeneratedDependencyCleanup,
  runGeneratedDependencyCleanup,
} from "../commands/worktree-generated-cleanup.js";

const cleanupRoots = new Set<string>();

afterEach(() => {
  for (const root of cleanupRoots) {
    fs.rmSync(root, { recursive: true, force: true });
    cleanupRoots.delete(root);
  }
});

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createTempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-generated-cleanup-"));
  cleanupRoots.add(root);
  runGit(root, ["init"]);
  runGit(root, ["config", "user.email", "paperclip@example.com"]);
  runGit(root, ["config", "user.name", "Paperclip Test"]);
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    [
      "node_modules/",
      "dist/",
      "coverage/",
      ".vite/",
      ".yarn/cache/",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "Initial commit"]);
  return root;
}

describe("worktree generated dependency cleanup", () => {
  it("inventories ignored generated directories in a clean worktree", () => {
    const repo = createTempRepo();
    fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");
    fs.mkdirSync(path.join(repo, "ui", "dist"), { recursive: true });
    fs.writeFileSync(path.join(repo, "ui", "dist", "bundle.js"), "console.log('built');\n", "utf8");

    const plan = planGeneratedDependencyCleanup({
      root: [repo],
      minAgeHours: 0,
      maxDepth: 6,
      checkLiveProcesses: false,
    });

    expect(plan.summary.scannedWorktrees).toBe(1);
    expect(plan.summary.eligibleCandidates).toBe(2);
    expect(plan.worktrees[0]?.status).toBe("scanned");
    expect(plan.worktrees[0]?.candidates.map((candidate) => candidate.relativePath).sort()).toEqual([
      "node_modules",
      "ui/dist",
    ]);
    expect(plan.worktrees[0]?.candidates.every((candidate) => candidate.action === "would_delete")).toBe(true);
  });

  it("skips dirty worktrees before inspecting generated directories", () => {
    const repo = createTempRepo();
    fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repo, "untracked-source.txt"), "not ignored\n", "utf8");

    const plan = planGeneratedDependencyCleanup({
      root: [repo],
      minAgeHours: 0,
      checkLiveProcesses: false,
    });

    expect(plan.summary.scannedWorktrees).toBe(0);
    expect(plan.summary.skippedWorktrees).toBe(1);
    expect(plan.worktrees[0]?.reason).toContain("uncommitted or untracked");
    expect(fs.existsSync(path.join(repo, "node_modules"))).toBe(true);
  });

  it("skips worktrees when live process inspection is unavailable", () => {
    const repo = createTempRepo();
    fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");

    const plan = planGeneratedDependencyCleanup({
      root: [repo],
      minAgeHours: 0,
      liveProcessCwdChecker: () => null,
    });

    expect(plan.summary.scannedWorktrees).toBe(0);
    expect(plan.summary.skippedWorktrees).toBe(1);
    expect(plan.summary.eligibleCandidates).toBe(0);
    expect(plan.worktrees[0]?.liveProcessCheck).toBe("unavailable");
    expect(plan.worktrees[0]?.reason).toContain("cannot confirm worktree is inactive");
    expect(plan.worktrees[0]?.candidates).toEqual([]);
    expect(fs.existsSync(path.join(repo, "node_modules"))).toBe(true);
  });

  it("does not mark matching directories eligible when they contain tracked files", () => {
    const repo = createTempRepo();
    fs.mkdirSync(path.join(repo, "dist"), { recursive: true });
    fs.writeFileSync(path.join(repo, "dist", "keep.txt"), "tracked build artifact\n", "utf8");
    runGit(repo, ["add", "-f", "dist/keep.txt"]);
    runGit(repo, ["commit", "-m", "Track dist fixture"]);

    const plan = planGeneratedDependencyCleanup({
      root: [repo],
      minAgeHours: 0,
      checkLiveProcesses: false,
    });
    const candidate = plan.worktrees[0]?.candidates.find((item) => item.relativePath === "dist");

    expect(candidate).toBeDefined();
    expect(candidate?.action).toBe("skipped");
    expect(candidate?.reason).not.toBeNull();
    expect(fs.existsSync(path.join(repo, "dist", "keep.txt"))).toBe(true);
  });

  it("removes eligible generated directories only when apply is set", () => {
    const repo = createTempRepo();
    fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");

    const plan = runGeneratedDependencyCleanup({
      root: [repo],
      minAgeHours: 0,
      apply: true,
      checkLiveProcesses: false,
    });

    expect(plan.summary.deletedCandidates).toBe(1);
    expect(fs.existsSync(path.join(repo, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "src", "index.ts"))).toBe(true);
  });

  it("rejects invalid cleanup policy numbers", () => {
    const repo = createTempRepo();

    expect(() =>
      planGeneratedDependencyCleanup({
        root: [repo],
        minAgeHours: Number.NaN,
        checkLiveProcesses: false,
      }),
    ).toThrow("Invalid min age hours");
  });
});
