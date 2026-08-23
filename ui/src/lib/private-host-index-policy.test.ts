import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("private host index policy", () => {
  it("disallows all crawlers in robots.txt", () => {
    const robots = readFileSync(resolve(uiRoot, "public/robots.txt"), "utf8");
    expect(robots).toMatch(/^\s*User-agent:\s*\*\s*$/m);
    expect(robots).toMatch(/^\s*Disallow:\s*\/\s*$/m);
    expect(robots).not.toMatch(/sitemap/i);
    expect(robots).not.toMatch(/llms\.txt/i);
  });

  it("marks the HTML shell noindex", () => {
    const html = readFileSync(resolve(uiRoot, "index.html"), "utf8");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(html).not.toContain("sitemap");
    expect(html).not.toContain("llms.txt");
  });
});
