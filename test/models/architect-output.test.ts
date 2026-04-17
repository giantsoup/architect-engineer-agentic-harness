import { describe, expect, it } from "vitest";

import {
  ArchitectControlOutputValidationError,
  createArchitectStructuredOutputFormat,
  validateArchitectControlOutput,
} from "../../src/index.js";

describe("architect output validation", () => {
  it("accepts a valid Architect plan and review payload", async () => {
    await expect(
      validateArchitectControlOutput("plan", {
        type: "plan",
        acceptanceCriteria: ["Tests pass"],
        steps: ["Inspect the failing module", "Apply a focused fix"],
        summary: "Fix the regression and verify it.",
      }),
    ).resolves.toEqual({
      type: "plan",
      acceptanceCriteria: ["Tests pass"],
      steps: ["Inspect the failing module", "Apply a focused fix"],
      summary: "Fix the regression and verify it.",
    });

    const reviewFormat = await createArchitectStructuredOutputFormat("review");

    await expect(
      reviewFormat.validate({
        type: "review",
        decision: "approve",
        nextActions: ["Ship the change"],
        summary: "The task is complete.",
      }),
    ).resolves.toEqual({
      type: "review",
      decision: "approve",
      nextActions: ["Ship the change"],
      summary: "The task is complete.",
    });
  });

  it("accepts legacy final Architect plan and review payloads without a type discriminator", async () => {
    await expect(
      validateArchitectControlOutput("plan", {
        acceptanceCriteria: ["Tests pass"],
        steps: ["Inspect the failing module", "Apply a focused fix"],
        summary: "Fix the regression and verify it.",
      }),
    ).resolves.toEqual({
      acceptanceCriteria: ["Tests pass"],
      steps: ["Inspect the failing module", "Apply a focused fix"],
      summary: "Fix the regression and verify it.",
    });

    await expect(
      validateArchitectControlOutput("review", {
        decision: "approve",
        nextActions: ["Ship the change"],
        summary: "The task is complete.",
      }),
    ).resolves.toEqual({
      decision: "approve",
      nextActions: ["Ship the change"],
      summary: "The task is complete.",
    });
  });

  it("rejects unexpected properties and invalid decisions", async () => {
    await expect(
      validateArchitectControlOutput("plan", {
        type: "plan",
        steps: ["Only step"],
        summary: "Plan summary",
        unexpected: true,
      }),
    ).rejects.toBeInstanceOf(ArchitectControlOutputValidationError);

    await expect(
      validateArchitectControlOutput("review", {
        type: "review",
        decision: "retry",
        summary: "Not a valid decision",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ArchitectControlOutputValidationError);
      expect((error as Error).message).toContain(
        'review.decision: Expected one of "approve", "revise", or "fail".',
      );

      return true;
    });
  });

  it("accepts tool actions for Architect planning and review", async () => {
    await expect(
      validateArchitectControlOutput("plan", {
        request: {
          name: "lookup",
          server: "repo",
          toolName: "mcp.call",
        },
        summary: "Consult MCP context before planning.",
        type: "tool",
      }),
    ).resolves.toEqual({
      request: {
        name: "lookup",
        server: "repo",
        toolName: "mcp.call",
      },
      summary: "Consult MCP context before planning.",
      type: "tool",
    });
  });

  it("normalizes legacy wrapped Architect tool requests before validation", async () => {
    await expect(
      validateArchitectControlOutput("plan", {
        request: {
          arguments: {
            path: ".",
          },
          toolName: "file.list",
        },
        summary: "Inspect the repository root.",
        type: "tool",
      }),
    ).resolves.toEqual({
      request: {
        path: ".",
        toolName: "file.list",
      },
      summary: "Inspect the repository root.",
      type: "tool",
    });
  });
});
