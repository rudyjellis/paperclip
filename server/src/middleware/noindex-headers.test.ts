import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { NOINDEX_ROBOTS_TAG, noindexHeaders } from "./noindex-headers.js";

function createApp() {
  const app = express();
  app.use(noindexHeaders());
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/dashboard", (_req, res) => {
    res.status(200).send("ok");
  });
  return app;
}

describe("noindexHeaders", () => {
  it("sets X-Robots-Tag on API responses", async () => {
    const res = await request(createApp()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-robots-tag"]).toBe(NOINDEX_ROBOTS_TAG);
  });

  it("sets X-Robots-Tag on HTML page responses", async () => {
    const res = await request(createApp()).get("/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers["x-robots-tag"]).toBe(NOINDEX_ROBOTS_TAG);
  });
});
