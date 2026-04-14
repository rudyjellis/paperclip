import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("default agent instructions", () => {
  it.each([
    ["ceo", "ceo"],
    ["cto", "cto"],
    ["pm", "pm"],
    ["engineer", "engineer"],
    ["senior_engineer", "engineer"],
    ["backend_engineer", "engineer"],
    ["devops", "engineer"],
    ["designer", "default"],
  ] as const)("maps %s to the %s default instruction bundle", (role, expectedBundle) => {
    expect(resolveDefaultAgentInstructionsBundleRole(role)).toBe(expectedBundle);
  });

  it("loads the CTO default instruction bundle", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("cto");

    expect(Object.keys(bundle).sort()).toEqual(["AGENTS.md", "SOUL.md"]);
    expect(bundle["AGENTS.md"]).toContain("You are the CTO");
    expect(bundle["AGENTS.md"]).toContain("default feature implementer");
    expect(bundle["SOUL.md"]).toContain("CTO Persona");
  });

  it("loads the engineering persona with the engineer default instruction bundle", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("engineer");

    expect(Object.keys(bundle).sort()).toEqual(["AGENTS.md", "SOUL.md"]);
    expect(bundle["AGENTS.md"]).toContain("You are the Senior Engineer");
    expect(bundle["SOUL.md"]).toContain("Engineering Persona");
  });
});
