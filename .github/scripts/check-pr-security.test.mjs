import assert from "node:assert/strict";
import test from "node:test";

import {
  isRecoverableAdvisorySyncError,
  syncDraftAdvisoryBestEffort,
} from "./check-pr-security.mjs";

test("isRecoverableAdvisorySyncError treats GitHub advisory permission failures as non-blocking", () => {
  assert.equal(
    isRecoverableAdvisorySyncError({
      status: 403,
      message: "Resource not accessible by integration",
    }),
    true,
  );
});

test("syncDraftAdvisoryBestEffort downgrades advisory permission failures to warnings", async () => {
  const warnings = [];
  const fetchCalls = [];

  const synced = await syncDraftAdvisoryBestEffort(
    async (path, _token, options) => {
      fetchCalls.push({ path, method: options?.method ?? "GET" });
      if (path.startsWith("/repos/rudyjellis/paperclip/security-advisories?")) {
        return [];
      }
      if (path === "/repos/rudyjellis/paperclip/security-advisories") {
        const error = new Error("Resource not accessible by integration");
        error.status = 403;
        throw error;
      }
      throw new Error(`unexpected path: ${path}`);
    },
    "token",
    "rudyjellis/paperclip",
    39,
    "DIG-2021: add workspace cleanup inventory",
    [{ check: "sensitive-path", file: "server/src/routes/execution-workspaces.ts" }],
    (message) => warnings.push(message),
  );

  assert.equal(synced, false);
  assert.deepEqual(fetchCalls, [
    {
      path: "/repos/rudyjellis/paperclip/security-advisories?state=draft&per_page=100&page=1",
      method: "GET",
    },
    {
      path: "/repos/rudyjellis/paperclip/security-advisories",
      method: "POST",
    },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /continuing without advisory/);
});

test("syncDraftAdvisoryBestEffort rethrows unexpected advisory sync failures", async () => {
  await assert.rejects(
    syncDraftAdvisoryBestEffort(
      async () => {
        const error = new Error("boom");
        error.status = 500;
        throw error;
      },
      "token",
      "rudyjellis/paperclip",
      39,
      "DIG-2021: add workspace cleanup inventory",
      [],
    ),
    /boom/,
  );
});
