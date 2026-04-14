import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeJsonFile } from "../../src/artifacts/json.js";

const temporaryDirectories: string[] = [];

function createTempDirectory(): string {
  const directoryPath = mkdtempSync(path.join(os.tmpdir(), "aeah-json-"));
  temporaryDirectories.push(directoryPath);
  return directoryPath;
}

afterEach(() => {
  vi.restoreAllMocks();

  while (temporaryDirectories.length > 0) {
    const directoryPath = temporaryDirectories.pop();

    if (directoryPath !== undefined) {
      rmSync(directoryPath, { force: true, recursive: true });
    }
  }
});

describe("writeJsonFile", () => {
  it("does not collide when concurrent writes share the same timestamp", async () => {
    const directoryPath = createTempDirectory();
    const filePath = path.join(directoryPath, "run.json");
    vi.spyOn(Date, "now").mockReturnValue(1776209224090);

    await Promise.all(
      Array.from({ length: 8 }, (_value, index) =>
        writeJsonFile(filePath, {
          index,
          ok: true,
        }),
      ),
    );

    const parsedValue = JSON.parse(readFileSync(filePath, "utf8")) as {
      index: number;
      ok: boolean;
    };

    expect(parsedValue.ok).toBe(true);
    expect(parsedValue.index).toBeGreaterThanOrEqual(0);
    expect(parsedValue.index).toBeLessThan(8);
  });
});
