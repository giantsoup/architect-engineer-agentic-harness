import { describe, expect, it } from "vitest";

import {
  createEngineerToolDefinitions,
  EngineerControlOutputValidationError,
  EngineerTurnValidationError,
  resolveEngineerTurn,
  validateEngineerToolRequest,
  validateEngineerControlOutput,
} from "../../src/index.js";

describe("engineer output validation", () => {
  it("defines native Engineer tools and resolves a native tool-call turn", async () => {
    expect(createEngineerToolDefinitions().map((tool) => tool.name)).toEqual([
      "command.execute",
      "file.list",
      "file.read",
      "file.read_many",
      "file.search",
      "file.write",
      "git.diff",
      "git.status",
      "mcp.call",
    ]);

    await expect(
      resolveEngineerTurn({
        rawContent: "Run the required check.\nSTOP_ON_SUCCESS",
        toolCalls: [
          {
            arguments: {
              accessMode: "mutate",
              command: "npm run test",
            },
            id: "call_1",
            name: "command.execute",
          },
        ],
      }),
    ).resolves.toEqual({
      request: {
        accessMode: "mutate",
        command: "npm run test",
        toolName: "command.execute",
      },
      stopWhenSuccessful: true,
      summary: "Run the required check.",
      toolCallId: "call_1",
      type: "tool",
    });
  });

  it("resolves concise final Engineer responses and low-cost legacy fallback", async () => {
    await expect(
      resolveEngineerTurn({
        rawContent: "COMPLETE: Required check passed and the task is done.",
      }),
    ).resolves.toEqual({
      outcome: "complete",
      summary: "Required check passed and the task is done.",
      type: "final",
    });

    await expect(
      resolveEngineerTurn({
        rawContent: [
          "BLOCKED: Cannot continue until the fixture exists.",
          "- tests/fixtures/input.json is missing",
        ].join("\n"),
      }),
    ).resolves.toEqual({
      blockers: ["tests/fixtures/input.json is missing"],
      outcome: "blocked",
      summary: "Cannot continue until the fixture exists.",
      type: "final",
    });

    await expect(
      resolveEngineerTurn({
        rawContent:
          '```json\n{"type":"tool","summary":"Legacy fallback","request":{"toolName":"file.read","path":"README.md"}}\n```',
      }),
    ).resolves.toEqual({
      request: {
        path: "README.md",
        toolName: "file.read",
      },
      summary: "Legacy fallback",
      toolCallId: "legacy-engineer-action",
      type: "tool",
    });

    await expect(
      resolveEngineerTurn({
        rawContent: [
          "Rewrite the file with the trailing newline.",
          'Tool call: file.write {"path":"SANITY.md","content":"Sanity check completed.\\n"}',
        ].join("\n"),
      }),
    ).resolves.toEqual({
      request: {
        content: "Sanity check completed.\n",
        path: "SANITY.md",
        toolName: "file.write",
      },
      summary: "Rewrite the file with the trailing newline.",
      toolCallId: "textual-engineer-tool-call",
      type: "tool",
    });

    await expect(
      resolveEngineerTurn({
        rawContent: [
          "The required check already passed and the task is satisfied.",
          "COMPLETE: SANITY.md contains the required content and npm test passes.",
        ].join("\n"),
      }),
    ).resolves.toEqual({
      outcome: "complete",
      summary: "SANITY.md contains the required content and npm test passes.",
      type: "final",
    });
  });

  it("rejects malformed native tool turns", async () => {
    await expect(
      validateEngineerToolRequest(
        {
          toolName: "git.status",
          path: "README.md",
        },
        "tool_call.git.status",
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(EngineerTurnValidationError);
      expect((error as Error).message).toContain(
        "tool_call.git.status.path: Unexpected property.",
      );

      return true;
    });

    await expect(
      resolveEngineerTurn({
        rawContent: "I am still thinking about it.",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(EngineerTurnValidationError);
      expect((error as Error).message).toContain(
        "Call exactly one tool through the native tool interface",
      );

      return true;
    });
  });

  it("accepts file.search and file.read_many tool actions", async () => {
    await expect(
      validateEngineerControlOutput({
        request: {
          limit: 5,
          path: "src",
          query: "createToolRouter",
          toolName: "file.search",
        },
        summary: "Search for the router entrypoint.",
        type: "tool",
      }),
    ).resolves.toEqual({
      request: {
        limit: 5,
        path: "src",
        query: "createToolRouter",
        toolName: "file.search",
      },
      summary: "Search for the router entrypoint.",
      type: "tool",
    });

    await expect(
      validateEngineerControlOutput({
        request: {
          paths: ["src/tools.ts", "test/tools.test.ts"],
          toolName: "file.read_many",
        },
        summary: "Read the likely files together.",
        type: "tool",
      }),
    ).resolves.toEqual({
      request: {
        paths: ["src/tools.ts", "test/tools.test.ts"],
        toolName: "file.read_many",
      },
      summary: "Read the likely files together.",
      type: "tool",
    });
  });

  it("rejects malformed file.search and file.read_many requests", async () => {
    await expect(
      validateEngineerControlOutput({
        request: {
          limit: 0,
          query: "",
          toolName: "file.search",
        },
        summary: "Bad search request.",
        type: "tool",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(EngineerControlOutputValidationError);
      expect((error as Error).message).toContain(
        "engineer_action.request.query: Expected at least 1 character.",
      );
      expect((error as Error).message).toContain(
        "engineer_action.request.limit: Expected an integer between 1 and 20.",
      );

      return true;
    });

    await expect(
      validateEngineerControlOutput({
        request: {
          paths: [],
          toolName: "file.read_many",
        },
        summary: "Bad batch read request.",
        type: "tool",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(EngineerControlOutputValidationError);
      expect((error as Error).message).toContain(
        "engineer_action.request.paths: Expected a non-empty array of relative file paths.",
      );

      return true;
    });

    await expect(
      validateEngineerControlOutput({
        request: {
          limit: 21,
          query: "router",
          toolName: "file.search",
        },
        summary: "Too many search results requested.",
        type: "tool",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(EngineerControlOutputValidationError);
      expect((error as Error).message).toContain(
        "engineer_action.request.limit: Expected an integer between 1 and 20.",
      );

      return true;
    });

    await expect(
      validateEngineerControlOutput({
        request: {
          paths: Array.from(
            { length: 9 },
            (_value, index) => `src/${index}.ts`,
          ),
          toolName: "file.read_many",
        },
        summary: "Too many files requested.",
        type: "tool",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(EngineerControlOutputValidationError);
      expect((error as Error).message).toContain(
        "engineer_action.request.paths: Expected at most 8 file paths.",
      );

      return true;
    });
  });
});
