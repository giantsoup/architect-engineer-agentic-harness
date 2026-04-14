import { describe, expect, it } from "vitest";

import { renderRunGitSection } from "../../src/runtime/run-git-automation.js";
import { evaluateDirtyWorkingTreePolicy } from "../../src/runtime/run-git-state.js";

describe("run git state helpers", () => {
  it("stops a run when the dirty-tree policy is stop and the repo is dirty", () => {
    expect(
      evaluateDirtyWorkingTreePolicy(
        {
          changedPaths: ["src/example.ts"],
          hasStagedChanges: false,
          hasUnstagedChanges: true,
          hasUntrackedChanges: false,
          isDirty: true,
        },
        "stop",
      ),
    ).toEqual({
      outcome: "stopped",
      shouldProceed: false,
      summary:
        "Run stopped before branch creation because the repository started with a dirty working tree.",
    });
  });

  it("renders git metadata for the final report", () => {
    const lines = renderRunGitSection({
      createdCommits: [
        {
          commitHash: "abc123",
          message: "ae(run): engineer milestone 1",
          phase: "engineer-milestone",
          recordedAt: "2026-04-14T12:00:30.000Z",
        },
      ],
      dirtyWorkingTreeOutcome: "clean",
      dirtyWorkingTreePolicy: "stop",
      errors: [],
      finalCommit: "abc123",
      initialWorkingTree: {
        changedPaths: [],
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        hasUntrackedChanges: false,
        isDirty: false,
      },
      runBranch: "ae/run-branch",
      startingBranch: "main",
      startingCommit: "def456",
      warnings: [],
    });

    expect(lines.join("\n")).toContain("Starting branch: main");
    expect(lines.join("\n")).toContain("Run branch: ae/run-branch");
    expect(lines.join("\n")).toContain("abc123 (engineer-milestone)");
  });
});
