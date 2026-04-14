import { describe, expect, it } from "vitest";

import {
  renderAcceptanceCriteriaLines,
  resolveAcceptanceCriteriaPolicy,
} from "../../src/index.js";

describe("acceptance criteria policy", () => {
  it("adds non-test Architect goals while preserving the mandatory test gate", () => {
    const policy = resolveAcceptanceCriteriaPolicy({
      architectPlan: {
        acceptanceCriteria: ["Update the docs", "Keep the public API stable"],
      },
      requiredTestCommand: "npm run test",
      requirePassingChecks: true,
    });

    expect(policy).toEqual({
      additionalGoals: ["Update the docs", "Keep the public API stable"],
      requiredTestCommand: "npm run test",
      requirePassingChecks: true,
    });
    expect(renderAcceptanceCriteriaLines(policy)).toEqual([
      "- Mandatory test gate: `npm run test` must pass before completion.",
      "- Additional Architect goal: Update the docs",
      "- Additional Architect goal: Keep the public API stable",
    ]);
  });

  it("can represent additional goals without a mandatory test gate when checks are disabled", () => {
    const policy = resolveAcceptanceCriteriaPolicy({
      architectPlan: {
        acceptanceCriteria: ["Confirm the migration notes are updated"],
      },
      requirePassingChecks: false,
    });

    expect(renderAcceptanceCriteriaLines(policy)).toEqual([
      "- Additional Architect goal: Confirm the migration notes are updated",
    ]);
  });
});
