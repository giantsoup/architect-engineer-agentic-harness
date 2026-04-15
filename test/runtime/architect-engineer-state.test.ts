import { describe, expect, it } from "vitest";

import {
  appendFailureNote,
  createArchitectEngineerState,
  createArchitectFailureNote,
  createEngineerFailureNote,
  withArchitectPlan,
  withArchitectReview,
  withEngineerExecution,
  withFinalOutcome,
} from "../../src/runtime/architect-engineer-state.js";
import {
  renderArchitectPlanMarkdown,
  renderArchitectReviewMarkdown,
  renderFailureNotesMarkdown,
} from "../../src/runtime/architect-engineer-nodes.js";
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

describe("architect-engineer state", () => {
  it("transitions through plan, execute, review, and finalize states", () => {
    let state = createArchitectEngineerState({
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      maxConsecutiveFailedRequiredChecks: 5,
      runId: "20260414T120000.000Z-abc126",
      task: "Implement the task.",
      timeoutMs: 60_000,
    });

    state = withArchitectPlan(state, {
      acceptanceCriteria: ["Tests pass"],
      steps: ["Inspect", "Fix", "Verify"],
      summary: "Ship the focused fix.",
    });
    expect(state.nextNode).toBe("execute");

    state = withEngineerExecution(state, {
      checks: [
        {
          command: "npm run test",
          name: "test",
          status: "passed",
          summary: "Required check passed.",
        },
      ],
      consecutiveFailedChecks: 0,
      dossier: undefined as never,
      iterationCount: 2,
      result: {
        status: "success",
        summary: "Tests passed after the fix.",
      },
      stopReason: "passing-checks",
      toolSummary: EMPTY_TOOL_SUMMARY,
    });
    expect(state.nextNode).toBe("review");
    expect(state.iterations.engineerAttempts).toBe(1);

    state = withArchitectReview(state, {
      decision: "revise",
      nextActions: ["Tighten the acceptance case"],
      summary: "One edge case still needs work.",
    });
    expect(state.nextNode).toBe("execute");
    expect(state.iterations.reviewCycles).toBe(1);

    state = withFinalOutcome(state, {
      status: "failed",
      stopReason: "architect-failed",
      summary: "The run failed review.",
    });
    expect(state.nextNode).toBe("finalize");
    expect(state.finalOutcome?.status).toBe("failed");
  });

  it("creates carried failure notes and renders markdown artifacts", () => {
    let state = createArchitectEngineerState({
      createdAt: new Date("2026-04-14T12:00:00.000Z"),
      maxConsecutiveFailedRequiredChecks: 5,
      runId: "20260414T120000.000Z-abc127",
      task: "Implement the task.",
      timeoutMs: 60_000,
    });

    state = appendFailureNote(
      state,
      createEngineerFailureNote(
        {
          checks: [
            {
              command: "npm run test",
              name: "test",
              status: "failed",
              summary: "Required check failed with exit code 1.",
            },
          ],
          consecutiveFailedChecks: 1,
          iterationCount: 2,
          result: {
            status: "failed",
            summary: "Tests failed after the first attempt.",
          },
          stopReason: "blocked",
          toolSummary: EMPTY_TOOL_SUMMARY,
        },
        "2026-04-14T12:00:30.000Z",
      ),
    );
    state = appendFailureNote(
      state,
      createArchitectFailureNote(
        {
          decision: "revise",
          nextActions: ["Fix the failing edge case", "Rerun tests"],
          summary: "The fix is close but incomplete.",
        },
        "2026-04-14T12:01:00.000Z",
      ),
    );

    expect(state.failureNotes).toHaveLength(2);

    const planMarkdown = renderArchitectPlanMarkdown({
      acceptanceCriteria: ["Tests pass"],
      steps: ["Inspect", "Fix"],
      summary: "Fix the regression.",
    });
    const reviewMarkdown = renderArchitectReviewMarkdown({
      decision: "revise",
      nextActions: ["Add tests"],
      summary: "Needs one more pass.",
    });
    const failureNotesMarkdown = renderFailureNotesMarkdown(state.failureNotes);

    expect(planMarkdown).toContain("## Acceptance Criteria");
    expect(reviewMarkdown).toContain("Decision: revise");
    expect(failureNotesMarkdown).toContain("Engineer Note");
    expect(failureNotesMarkdown).toContain("Architect Note");
    expect(failureNotesMarkdown).toContain("Fix the failing edge case");
  });
});
