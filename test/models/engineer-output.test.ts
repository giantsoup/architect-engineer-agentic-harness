import { describe, expect, it } from "vitest";

import {
  EngineerControlOutputValidationError,
  validateEngineerControlOutput,
} from "../../src/index.js";

describe("engineer output validation", () => {
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
