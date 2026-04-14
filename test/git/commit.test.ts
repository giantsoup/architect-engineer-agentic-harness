import { describe, expect, it } from "vitest";

import {
  createRunCommitMessage,
  isCommitNeeded,
} from "../../src/git/commit.js";

describe("git commit helpers", () => {
  it("detects when a commit is required", () => {
    expect(isCommitNeeded([])).toBe(false);
    expect(
      isCommitNeeded([
        {
          indexStatus: "M",
          path: "src/example.ts",
          workingTreeStatus: " ",
        },
      ]),
    ).toBe(true);
  });

  it("renders readable machine-generated commit messages", () => {
    expect(
      createRunCommitMessage({
        engineerAttempt: 2,
        phase: "engineer-milestone",
        reviewCycle: 1,
        runId: "20260414T120000.000Z-abc128",
        task: "Update src/example.ts and rerun tests",
      }),
    ).toContain("ae(20260414T120000.000Z-abc128): engineer milestone 2");

    expect(
      createRunCommitMessage({
        phase: "final-state",
        reviewCycle: 1,
        runId: "20260414T120000.000Z-abc128",
        task: "Update src/example.ts and rerun tests",
      }),
    ).toContain("ae(20260414T120000.000Z-abc128): finalize successful run");
  });
});
