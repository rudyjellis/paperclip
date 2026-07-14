import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../adapters/process/execute.js";

async function writeFakeProcessCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({
    paperclipApiUrl: process.env.PAPERCLIP_API_URL || null,
  }), "utf8");
}
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  paperclipApiUrl: string | null;
};

describe("process execute", () => {
  it("prefers the direct listen URL over a configured public Paperclip URL for local runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-execute-local-api-url-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "process-command");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeProcessCommand(commandPath);

    const previousPaperclipRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;
    const previousPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    const previousPaperclipListenHost = process.env.PAPERCLIP_LISTEN_HOST;
    const previousPaperclipListenPort = process.env.PAPERCLIP_LISTEN_PORT;
    process.env.PAPERCLIP_RUNTIME_API_URL = "https://paperclip.example.test";
    process.env.PAPERCLIP_API_URL = "https://paperclip.example.test";
    process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_PORT = "4310";

    try {
      const result = await execute({
        runId: "run-process-local-api-url",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Process Agent",
          adapterType: "process",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
        },
        context: {},
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage ?? null).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipApiUrl).toBe("http://localhost:4310");
    } finally {
      if (previousPaperclipRuntimeApiUrl === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
      else process.env.PAPERCLIP_RUNTIME_API_URL = previousPaperclipRuntimeApiUrl;
      if (previousPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
      else process.env.PAPERCLIP_API_URL = previousPaperclipApiUrl;
      if (previousPaperclipListenHost === undefined) delete process.env.PAPERCLIP_LISTEN_HOST;
      else process.env.PAPERCLIP_LISTEN_HOST = previousPaperclipListenHost;
      if (previousPaperclipListenPort === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
      else process.env.PAPERCLIP_LISTEN_PORT = previousPaperclipListenPort;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
