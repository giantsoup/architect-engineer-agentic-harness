import { describe, expect, it } from "vitest";

import { createRunBranchName } from "../../src/git/branch.js";

describe("createRunBranchName", () => {
  it("builds a deterministic safe branch name from the run id and task", () => {
    const branchName = createRunBranchName({
      runId: "20260414T120000.000Z-abc128",
      task: "Implement Milestone 8: Git Branch + Commit Automation!",
    });

    expect(branchName).toBe(
      "ae/run-20260414t120000-000z-abc128-implement-milestone-8-git-branch-commit-automati",
    );
    expect(branchName.length).toBeLessThanOrEqual(96);
  });

  it("falls back to a generic task segment when the task has no slug characters", () => {
    expect(
      createRunBranchName({
        runId: "20260414T120000.000Z-abc129",
        task: "!!!",
      }),
    ).toBe("ae/run-20260414t120000-000z-abc129-task");
  });
});
