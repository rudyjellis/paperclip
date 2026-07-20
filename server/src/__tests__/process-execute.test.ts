import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../adapters/process/execute.js";

const ORIGINAL_PAPERCLIP_RUNTIME_API_URL = process.env.PAPERCLIP_RUNTIME_API_URL;
const ORIGINAL_PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;

afterEach(() => {
  if (ORIGINAL_PAPERCLIP_RUNTIME_API_URL === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
  else process.env.PAPERCLIP_RUNTIME_API_URL = ORIGINAL_PAPERCLIP_RUNTIME_API_URL;

  if (ORIGINAL_PAPERCLIP_API_URL === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = ORIGINAL_PAPERCLIP_API_URL;

  if (ORIGINAL_PAPERCLIP_LISTEN_HOST === undefined) delete process.env.PAPERCLIP_LISTEN_HOST;
  else process.env.PAPERCLIP_LISTEN_HOST = ORIGINAL_PAPERCLIP_LISTEN_HOST;

  if (ORIGINAL_PAPERCLIP_LISTEN_PORT === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
  else process.env.PAPERCLIP_LISTEN_PORT = ORIGINAL_PAPERCLIP_LISTEN_PORT;
});

describe("process execute", () => {
  it("prefers the local listen URL for local child-process heartbeats", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-execute-"));
    const capturePath = path.join(root, "capture.json");
    const script = [
      "const fs = require('node:fs');",
      "fs.writeFileSync(",
      "  process.env.PAPERCLIP_TEST_CAPTURE_PATH,",
      "  JSON.stringify({ apiUrl: process.env.PAPERCLIP_API_URL }),",
      "  'utf8',",
      ");",
    ].join("\n");

    process.env.PAPERCLIP_RUNTIME_API_URL = "https://paperclip.example";
    process.env.PAPERCLIP_API_URL = "https://paperclip.example";
    process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    let loggedEnv: Record<string, string> = {};
    try {
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
        },
        runtime: {},
        config: {
          command: process.execPath,
          args: ["-e", script],
          cwd: root,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          loggedEnv = meta.env ?? {};
        },
      } as never);

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeUndefined();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { apiUrl: string };
      expect(capture.apiUrl).toBe("http://localhost:3101");
      expect(loggedEnv.PAPERCLIP_API_URL).toBe("http://localhost:3101");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
