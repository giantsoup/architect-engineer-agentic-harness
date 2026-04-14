import { describe, expect, it } from "vitest";

import {
  classifyGitWorkingTree,
  parseGitStatusPorcelain,
} from "../../src/git/status.js";

describe("git status helpers", () => {
  it("parses porcelain status output and classifies the working tree", () => {
    const status = parseGitStatusPorcelain(
      [
        "## main...origin/main [ahead 1]",
        "M  src/index.ts",
        " M src/runtime.ts",
        "?? docs/new.md",
        "",
      ].join("\n"),
    );
    const classification = classifyGitWorkingTree(status.entries);

    expect(status.branch.head).toBe("main");
    expect(status.isClean).toBe(false);
    expect(classification).toEqual({
      changedPaths: ["src/index.ts", "src/runtime.ts", "docs/new.md"],
      hasStagedChanges: true,
      hasUnstagedChanges: true,
      hasUntrackedChanges: true,
      isDirty: true,
    });
  });

  it("classifies a clean working tree", () => {
    const status = parseGitStatusPorcelain("## main\n");

    expect(classifyGitWorkingTree(status.entries)).toEqual({
      changedPaths: [],
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasUntrackedChanges: false,
      isDirty: false,
    });
  });

  it("parses unborn branch headers without treating the full sentence as the branch name", () => {
    const status = parseGitStatusPorcelain("## No commits yet on main\n");

    expect(status.branch).toEqual({
      ahead: 0,
      behind: 0,
      detached: false,
      head: "main",
    });
  });
});
