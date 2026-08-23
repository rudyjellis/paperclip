import { afterEach, describe, expect, it, vi } from "vitest";

const mockExecFilePromisified = vi.hoisted(() => vi.fn());
const mockExecFile = vi.hoisted(() => {
  const fn = vi.fn();
  Object.defineProperty(fn, Symbol.for("nodejs.util.promisify.custom"), {
    value: mockExecFilePromisified,
  });
  return fn;
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: mockExecFile,
  };
});

import { hasGitPushRemote } from "../services/heartbeat-git.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  mockExecFile.mockReset();
  mockExecFilePromisified.mockReset();
});

describe("hasGitPushRemote", () => {
  it("sanitizes server-only env before probing git remotes", async () => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "super-secret");
    vi.stubEnv("PAPERCLIP_API_KEY", "run-token");
    vi.stubEnv("DATABASE_URL", "postgres://secret");
    vi.stubEnv("npm_config_tailscale_auth", "ts-auth");
    vi.stubEnv("npm_config_authenticated_private", "true");

    mockExecFilePromisified.mockImplementation(async (file, args, options) => {
      expect(file).toBe("git");
      if (Array.isArray(args) && args.length === 1 && args[0] === "remote") {
        return { stdout: "origin\n", stderr: "" };
      }
      if (
        Array.isArray(args) &&
        args.length === 4 &&
        args[0] === "remote" &&
        args[1] === "get-url" &&
        args[2] === "--push" &&
        args[3] === "origin"
      ) {
        return { stdout: "https://github.com/example/repo.git\n", stderr: "" };
      }
      throw new Error(`unexpected execFile call: ${file} ${JSON.stringify(args)}`);
    });

    await expect(hasGitPushRemote("/tmp/fake-checkout")).resolves.toBe(true);

    expect(mockExecFilePromisified).toHaveBeenCalledTimes(2);
    for (const [, , options] of mockExecFilePromisified.mock.calls) {
      expect(options).toMatchObject({
        cwd: "/tmp/fake-checkout",
      });
      expect(options.env.PATH).toBe("/usr/bin");
      expect(options.env).not.toHaveProperty("PAPERCLIP_AGENT_JWT_SECRET");
      expect(options.env).not.toHaveProperty("PAPERCLIP_API_KEY");
      expect(options.env).not.toHaveProperty("DATABASE_URL");
      expect(options.env).not.toHaveProperty("npm_config_tailscale_auth");
      expect(options.env).not.toHaveProperty("npm_config_authenticated_private");
    }
  });
});
