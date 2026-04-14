import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadHarnessConfig } from "../../src/index.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDirectory, "..", "..");

describe("shipped example configs", () => {
  it("loads the TypeScript example config", async () => {
    const loadedConfig = await loadHarnessConfig({
      configPath: path.join(
        repoRoot,
        "examples",
        "typescript",
        "agent-harness.toml",
      ),
    });

    expect(loadedConfig.config.commands.test).toBe("npm run test");
    expect(loadedConfig.config.project.executionTarget).toBe("host");
  });

  it("loads the Laravel example config", async () => {
    const loadedConfig = await loadHarnessConfig({
      configPath: path.join(
        repoRoot,
        "examples",
        "laravel",
        "agent-harness.toml",
      ),
    });

    expect(loadedConfig.config.commands.test).toBe("php artisan test");
    expect(loadedConfig.config.mcp.allowlist).toEqual(["laravel-boost"]);
  });
});
