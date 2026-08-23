import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const { runChildProcess } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "hello from hermes\nsession_id: hermes-session-1\n",
    stderr: "",
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

function snapshotEnv() {
  return {
    PAPERCLIP_AGENT_JWT_SECRET: process.env.PAPERCLIP_AGENT_JWT_SECRET,
    PAPERCLIP_BOARD_API_KEY: process.env.PAPERCLIP_BOARD_API_KEY,
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
  };
}

function restoreEnv(snapshot: ReturnType<typeof snapshotEnv>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("hermes execute", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("does not leak server-only Paperclip secrets into the spawned hermes env", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-execute-"));
    tempDirs.push(root);
    const previousEnv = snapshotEnv();
    try {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = "server-only-secret";
      process.env.PAPERCLIP_BOARD_API_KEY = "board-only-secret";
      process.env.PAPERCLIP_API_KEY = "host-token";

      const ctx: AdapterExecutionContext = {
        runId: "run-hermes-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Hermes Engineer",
          adapterType: "hermes",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          cwd: root,
          provider: "anthropic",
          quiet: true,
          env: {
            CUSTOM_ENV: "visible",
          },
        },
        context: {
          taskId: "issue-123",
          wakeReason: "heartbeat_timer",
          commentId: "comment-456",
        },
        authToken: "run-token",
        onLog: async () => {},
      };

      const result = await execute(ctx);

      expect(result.exitCode).toBe(0);
      expect(runChildProcess).toHaveBeenCalledTimes(1);
      const call = runChildProcess.mock.calls[0] as unknown as
        | [string | undefined, string, string[], { env: Record<string, string> }]
        | undefined;
      const env = call?.[3].env ?? {};
      expect(env.CUSTOM_ENV).toBe("visible");
      expect(env.PAPERCLIP_API_KEY).toBe("run-token");
      expect(env.PAPERCLIP_RUN_ID).toBe("run-hermes-1");
      expect(env.PAPERCLIP_TASK_ID).toBe("issue-123");
      expect(env.PAPERCLIP_WAKE_REASON).toBe("heartbeat_timer");
      expect(env.PAPERCLIP_WAKE_COMMENT_ID).toBe("comment-456");
      expect(env).not.toHaveProperty("PAPERCLIP_AGENT_JWT_SECRET");
      expect(env).not.toHaveProperty("PAPERCLIP_BOARD_API_KEY");
    } finally {
      restoreEnv(previousEnv);
    }
  });
});
