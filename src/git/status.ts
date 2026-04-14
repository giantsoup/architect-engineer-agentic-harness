import type { GitStatusBranchSummary, GitStatusEntry } from "../tools/types.js";

export class GitStatusParseError extends Error {
  constructor(message: string) {
    super(message);

    this.name = "GitStatusParseError";
  }
}

export interface GitStatusSnapshot {
  branch: GitStatusBranchSummary;
  entries: GitStatusEntry[];
  isClean: boolean;
}

export interface GitWorkingTreeClassification {
  changedPaths: string[];
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  hasUntrackedChanges: boolean;
  isDirty: boolean;
}

export function parseGitStatusPorcelain(stdout: string): GitStatusSnapshot {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const branchLine = lines.shift();

  if (branchLine === undefined || !branchLine.startsWith("## ")) {
    throw new GitStatusParseError(
      "Git status output did not include a porcelain branch header.",
    );
  }

  const entries = lines.map(parseGitStatusEntry);

  return {
    branch: parseGitBranchSummary(branchLine.slice(3)),
    entries,
    isClean: entries.length === 0,
  };
}

export function classifyGitWorkingTree(
  entries: readonly GitStatusEntry[],
): GitWorkingTreeClassification {
  const changedPaths = [...new Set(entries.map((entry) => entry.path))];

  return {
    changedPaths,
    hasStagedChanges: entries.some(
      (entry) => entry.indexStatus !== " " && entry.indexStatus !== "?",
    ),
    hasUnstagedChanges: entries.some(
      (entry) =>
        entry.workingTreeStatus !== " " && entry.workingTreeStatus !== "?",
    ),
    hasUntrackedChanges: entries.some(
      (entry) => entry.indexStatus === "?" || entry.workingTreeStatus === "?",
    ),
    isDirty: entries.length > 0,
  };
}

function parseGitBranchSummary(line: string): GitStatusBranchSummary {
  if (line === "HEAD (no branch)") {
    return {
      ahead: 0,
      behind: 0,
      detached: true,
      head: "HEAD",
    };
  }

  const [rawHeadSection, trackingSection] = line.split(" [", 2);
  const headSection = rawHeadSection ?? "";
  const headSegments = headSection.split("...", 2);
  const head = headSegments[0] ?? "";
  const upstream = headSegments[1];

  if (head.length === 0) {
    throw new GitStatusParseError(
      `Git branch header is malformed: \`${line}\`.`,
    );
  }

  const branch: GitStatusBranchSummary = {
    ahead: 0,
    behind: 0,
    detached: false,
    head,
    ...(upstream === undefined ? {} : { upstream }),
  };

  if (trackingSection === undefined) {
    return branch;
  }

  const tracking = trackingSection.endsWith("]")
    ? trackingSection.slice(0, -1)
    : trackingSection;

  for (const part of tracking.split(", ")) {
    const match = /^(ahead|behind) (\d+)$/u.exec(part);

    if (match?.[1] === "ahead" && match[2] !== undefined) {
      branch.ahead = Number.parseInt(match[2], 10);
    }

    if (match?.[1] === "behind" && match[2] !== undefined) {
      branch.behind = Number.parseInt(match[2], 10);
    }
  }

  return branch;
}

function parseGitStatusEntry(line: string): GitStatusEntry {
  if (line.length < 4) {
    throw new GitStatusParseError(
      `Git status entry is malformed: \`${line}\`.`,
    );
  }

  const pathSection = line.slice(3);
  const renameSegments = pathSection.split(" -> ");
  const originalPath =
    renameSegments.length === 2 ? renameSegments[0] : undefined;
  const nextPath =
    renameSegments.length === 2 ? renameSegments[1] : pathSection;

  if (nextPath === undefined || nextPath.length === 0) {
    throw new GitStatusParseError(
      `Git status entry is missing a path: \`${line}\`.`,
    );
  }

  return {
    indexStatus: line[0] ?? " ",
    ...(originalPath === undefined ? {} : { originalPath }),
    path: nextPath,
    workingTreeStatus: line[1] ?? " ",
  };
}
