import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeRuntimeServiceBaseEnv } from "./workspace-runtime.js";

const execFile = promisify(execFileCallback);

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function hasGitPushRemote(cwd: string | null | undefined) {
  const normalized = readNonEmptyString(cwd);
  if (!normalized) return false;
  const gitEnv = sanitizeRuntimeServiceBaseEnv(process.env);
  const remoteNames = await execFile("git", ["remote"], { cwd: normalized, env: gitEnv })
    .then((result) =>
      result.stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    )
    .catch(() => []);

  for (const remoteName of remoteNames) {
    const pushUrl = await execFile("git", ["remote", "get-url", "--push", remoteName], {
      cwd: normalized,
      env: gitEnv,
    })
      .then((result) => readNonEmptyString(result.stdout))
      .catch(() => null);
    if (pushUrl) return true;
  }
  return false;
}
