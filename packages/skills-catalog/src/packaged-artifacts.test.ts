import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distManifestPackPath = "dist/generated/catalog.json";
const distManifestFsPath = path.join("dist", "generated", "catalog.json");

function readPackMetadata(packageDir: string, packDestination: string) {
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", packDestination], {
    cwd: packageDir,
    encoding: "utf8",
  });
  const metadata = JSON.parse(output);
  if (!Array.isArray(metadata) || metadata.length === 0 || typeof metadata[0]?.filename !== "string") {
    throw new Error(`Unexpected npm pack output from ${packageDir}: ${output}`);
  }
  return metadata[0] as { filename: string; files: Array<{ path: string }> };
}

describe("skills catalog package artifacts", () => {
  const cleanup: string[] = [];

  function createTempDir(prefix: string) {
    const directory = mkdtempSync(path.join(tmpdir(), prefix));
    cleanup.push(directory);
    return directory;
  }

  function createPackDestination() {
    return createTempDir("paperclip-skills-catalog-pack-");
  }

  function createPackageFixture() {
    const fixtureRoot = createTempDir("paperclip-skills-catalog-fixture-");
    const packageDir = path.join(fixtureRoot, "package");
    cpSync(packageRoot, packageDir, { recursive: true });

    const fixtureDistManifestPath = path.join(packageDir, distManifestFsPath);
    if (!existsSync(fixtureDistManifestPath)) {
      // Fresh checkouts ship the generated manifest but not dist output.
      mkdirSync(path.dirname(fixtureDistManifestPath), { recursive: true });
      copyFileSync(path.join(packageDir, "generated", "catalog.json"), fixtureDistManifestPath);
    }

    return packageDir;
  }

  afterEach(async () => {
    await Promise.all(cleanup.map((entry) => rm(entry, { force: true, recursive: true })));
    cleanup.length = 0;
  });

  it("packs dist manifest and catalog files for npm artifact consumers", () => {
    const metadata = readPackMetadata(createPackageFixture(), createPackDestination());
    const paths = metadata.files.map((entry) => entry.path);

    expect(paths).toContain(distManifestPackPath);
    expect(paths).toContain("generated/catalog.json");
    expect(paths).toContain("catalog/bundled/software-development/github-pr-workflow/SKILL.md");
    expect(paths).toContain("catalog/optional/browser/agent-browser/SKILL.md");
    expect(paths).toContain("package.json");
  }, 30_000);
});
