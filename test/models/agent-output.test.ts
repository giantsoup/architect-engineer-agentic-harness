import { describe, expect, it } from "vitest";

import {
  renderAgentToolFallbackInstruction,
  resolveAgentTurn,
} from "../../src/models/agent-output.js";

describe("agent-output", () => {
  it("parses native tool calls into a single tool turn", async () => {
    const turn = await resolveAgentTurn({
      rawContent: "Search for the config loader.",
      toolCalls: [
        {
          arguments: {
            query: "loadHarnessConfig",
          },
          id: "tool-1",
          name: "file.search",
        },
      ],
    });

    expect(turn).toMatchObject({
      request: {
        query: "loadHarnessConfig",
        toolName: "file.search",
      },
      summary: "Search for the config loader.",
      toolCallId: "tool-1",
      type: "tool",
    });
  });

  it("parses fallback JSON replies", async () => {
    const turn = await resolveAgentTurn({
      rawContent: '{"type":"reply","reply":"The lint issue is fixed."}',
    });

    expect(turn).toEqual({
      reply: "The lint issue is fixed.",
      type: "reply",
    });
  });

  it("describes the fallback protocol", () => {
    expect(renderAgentToolFallbackInstruction()).toContain('"type":"tool"');
    expect(renderAgentToolFallbackInstruction()).toContain('"type":"reply"');
  });
});
