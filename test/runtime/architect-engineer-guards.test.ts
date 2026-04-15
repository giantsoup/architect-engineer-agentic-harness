import { describe, expect, it } from "vitest";

import {
  createArchitectEngineerState,
  withArchitectReview,
  withEngineerExecution,
} from "../../src/runtime/architect-engineer-state.js";
import {
  getEngineerStopOutcome,
  getRemainingRunTimeMs,
  getReviewOutcome,
  getStopConditionOutcome,
  hasArchitectEngineerTimedOut,
  hasReachedFailedCheckThreshold,
} from "../../src/runtime/architect-engineer-guards.js";
import type { ToolExecutionSummary } from "../../src/tools/types.js";

const EMPTY_TOOL_SUMMARY: ToolExecutionSummary = {
  builtInCallCount: 0,
  builtInTools: [
    "command.execute",
    "file.list",
    "file.read_many",
    "file.read",
    "file.search",
    "file.write",
    "git.diff",
    "git.status",
  ],
  duplicateExplorationSuppressions: 0,
  mcpCallCount: 0,
  mcpCalls: [],
  mcpServers: {
    available: [],
    configured: [],
    unavailable: [],
  },
  mcpTools: [],
  repeatedListingCount: 0,
  repeatedReadCount: 0,
  repoMemoryHits: 0,
};

describe("architect-engineer guards", () => {
  it("reports remaining time and timeout state", () => {
    const state = createArchitectEngineerState({
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      maxConsecutiveFailedRequiredChecks: 5,
      runId: "20260414T120000.000Z-abc123",
      task: "Task",
      timeoutMs: 60_000,
    });

    expect(
      getRemainingRunTimeMs(state, new Date("2026-04-14T12:00:30.000Z")),
    ).toBe(30_000);
    expect(
      hasArchitectEngineerTimedOut(state, new Date("2026-04-14T12:01:00.000Z")),
    ).toBe(true);
  });

  it("stops once the failed-check threshold is reached", () => {
    const seededState = withEngineerExecution(
      createArchitectEngineerState({
        createdAt: new Date("2026-04-14T12:00:00.000Z"),
        maxConsecutiveFailedRequiredChecks: 5,
        runId: "20260414T120000.000Z-abc124",
        task: "Task",
        timeoutMs: 60_000,
      }),
      {
        checks: [
          {
            command: "npm run test",
            name: "test",
            status: "failed",
            summary: "Required check failed with exit code 1.",
          },
        ],
        consecutiveFailedChecks: 5,
        dossier: undefined as never,
        iterationCount: 2,
        result: {
          status: "failed",
          summary: "Required check failed 5 consecutive times.",
        },
        stopReason: "max-consecutive-failed-checks",
        toolSummary: EMPTY_TOOL_SUMMARY,
      },
    );

    expect(hasReachedFailedCheckThreshold(seededState)).toBe(true);
    expect(
      getStopConditionOutcome(
        seededState,
        new Date("2026-04-14T12:00:10.000Z"),
      ),
    ).toEqual({
      status: "failed",
      stopReason: "max-consecutive-failed-checks",
      summary: "Required check failed 5 consecutive times.",
    });
  });

  it("maps Engineer and Architect outcomes into final run outcomes", () => {
    expect(
      getEngineerStopOutcome("max-consecutive-failed-checks", "Checks failed."),
    ).toEqual({
      status: "failed",
      stopReason: "max-consecutive-failed-checks",
      summary: "Checks failed.",
    });
    expect(getEngineerStopOutcome("blocked", "Blocked.")).toBeUndefined();

    const reviewState = withArchitectReview(
      createArchitectEngineerState({
        createdAt: new Date("2026-04-14T12:00:00.000Z"),
        maxConsecutiveFailedRequiredChecks: 5,
        runId: "20260414T120000.000Z-abc125",
        task: "Task",
        timeoutMs: 60_000,
      }),
      {
        decision: "approve",
        summary: "Looks good.",
      },
    );

    expect(getReviewOutcome(reviewState.architectReview!)).toEqual({
      status: "success",
      stopReason: "architect-approved",
      summary: "Looks good.",
    });
    expect(
      getReviewOutcome({
        decision: "revise",
        nextActions: ["Add tests"],
        summary: "Not done yet.",
      }),
    ).toBeUndefined();
  });
});
