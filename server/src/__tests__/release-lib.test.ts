import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const releaseLibPath = path.join(repoRoot, "scripts", "release-lib.sh");

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function withTempGitRepo(
  remotes: Record<string, string>,
  fn: (cwd: string) => Promise<void>,
) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-release-remote-"));
  try {
    await execFileAsync("git", ["init"], { cwd });
    for (const [name, url] of Object.entries(remotes)) {
      await execFileAsync("git", ["remote", "add", name, url], { cwd });
    }
    await fn(cwd);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

function runReleaseLib(
  cwd: string,
  command: string,
  env: Record<string, string> = {},
) {
  return execFileAsync(
    "bash",
    ["-lc", `. ${shellQuote(releaseLibPath)}; ${command}`],
    {
      cwd,
      env: {
        ...process.env,
        REPO_ROOT: cwd,
        ...env,
      },
    },
  );
}

describe("release-lib publish remote guard", () => {
  it("defaults to the configured fork remote before an upstream origin", async () => {
    await withTempGitRepo(
      {
        origin: "https://github.com/paperclipai/paperclip.git",
        fork: "https://github.com/rudyjellis/paperclip.git",
      },
      async (cwd) => {
        const result = await runReleaseLib(cwd, "resolve_release_remote");
        expect(result.stdout.trim()).toBe("fork");
      },
    );
  });

  it("rejects an upstream Paperclip remote without explicit intent", async () => {
    await withTempGitRepo(
      {
        origin: "https://github.com/paperclipai/paperclip.git",
      },
      async (cwd) => {
        let error: unknown;
        try {
          await runReleaseLib(cwd, "resolve_release_remote", {
            PUBLISH_REMOTE: "origin",
          });
        } catch (err) {
          error = err;
        }

        expect(error).toBeTruthy();
        const stderr = String((error as { stderr?: string }).stderr ?? "");
        expect(stderr).toContain("refuses to target upstream repo paperclipai/paperclip");
        expect(stderr).toContain("submit an internal Paperclip issue for upstream coordination");
      },
    );
  });

  it("allows an upstream Paperclip remote when upstream intent is explicit", async () => {
    await withTempGitRepo(
      {
        origin: "https://github.com/paperclipai/paperclip.git",
      },
      async (cwd) => {
        const result = await runReleaseLib(cwd, "resolve_release_remote", {
          PUBLISH_REMOTE: "origin",
          PAPERCLIP_UPSTREAM_INTENT: "release",
        });
        expect(result.stdout.trim()).toBe("origin");
        expect(result.stderr).toContain("upstream Paperclip publish target allowed");
      },
    );
  });

  it("allows origin when origin is a fork target", async () => {
    await withTempGitRepo(
      {
        origin: "https://github.com/rudyjellis/paperclip.git",
      },
      async (cwd) => {
        const result = await runReleaseLib(cwd, "resolve_release_remote");
        expect(result.stdout.trim()).toBe("origin");
      },
    );
  });
});
