import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  detectProjectAdapter,
  resolveProjectContext,
} from "../../src/index.js";

function createTempProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "aeah-adapter-"));
}

function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  contents: string,
): void {
  writeFileSync(path.join(projectRoot, relativePath), contents, "utf8");
}

describe("project adapter detection", () => {
  const projectRoots: string[] = [];

  afterEach(() => {
    for (const projectRoot of projectRoots.splice(0)) {
      rmSync(projectRoot, { force: true, recursive: true });
    }
  });

  it("detects generic TypeScript repos and resolves fallback commands", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);

    writeProjectFile(
      projectRoot,
      "package.json",
      JSON.stringify(
        {
          devDependencies: {
            typescript: "^5.8.3",
          },
          scripts: {
            lint: "eslint .",
            test: "vitest run",
          },
        },
        null,
        2,
      ),
    );
    writeProjectFile(projectRoot, "tsconfig.json", "{}\n");
    writeProjectFile(projectRoot, "eslint.config.mjs", "export default [];\n");
    writeProjectFile(projectRoot, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");

    const detectedAdapter = await detectProjectAdapter(projectRoot);
    const resolvedProject = await resolveProjectContext({
      commands: {},
      projectRoot,
    });

    expect(detectedAdapter).toMatchObject({
      id: "typescript-generic",
      label: "Generic TypeScript",
    });
    expect(resolvedProject.commands.install).toEqual({
      command: "pnpm install",
      source: "adapter",
    });
    expect(resolvedProject.commands.lint).toEqual({
      command: "pnpm run lint",
      source: "adapter",
    });
    expect(resolvedProject.commands.test).toEqual({
      command: "pnpm run test",
      source: "adapter",
    });
    expect(resolvedProject.commands.typecheck).toEqual({
      command: "pnpm exec tsc --noEmit",
      source: "adapter",
    });
  });

  it("detects generic Laravel repos and resolves Laravel-aware fallback commands", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);

    writeProjectFile(
      projectRoot,
      "composer.json",
      JSON.stringify(
        {
          require: {
            "laravel/framework": "^12.0",
          },
          "require-dev": {
            "laravel/pint": "^1.0",
          },
        },
        null,
        2,
      ),
    );
    writeProjectFile(projectRoot, "artisan", "#!/usr/bin/env php\n");
    writeProjectFile(
      projectRoot,
      "package.json",
      JSON.stringify(
        {
          scripts: {
            typecheck: "tsc --noEmit",
          },
        },
        null,
        2,
      ),
    );
    writeProjectFile(projectRoot, "yarn.lock", "# yarn lockfile v1\n");

    const detectedAdapter = await detectProjectAdapter(projectRoot);
    const resolvedProject = await resolveProjectContext({
      commands: {},
      projectRoot,
    });

    expect(detectedAdapter).toMatchObject({
      id: "laravel-generic",
      label: "Generic Laravel",
    });
    expect(resolvedProject.commands.install).toEqual({
      command: "composer install && yarn install",
      source: "adapter",
    });
    expect(resolvedProject.commands.lint).toEqual({
      command: "./vendor/bin/pint --test",
      source: "adapter",
    });
    expect(resolvedProject.commands.test).toEqual({
      command: "php artisan test",
      source: "adapter",
    });
    expect(resolvedProject.commands.typecheck).toEqual({
      command: "yarn typecheck",
      source: "adapter",
    });
  });

  it("keeps explicit config command overrides authoritative over detection", async () => {
    const projectRoot = createTempProject();
    projectRoots.push(projectRoot);

    writeProjectFile(
      projectRoot,
      "package.json",
      JSON.stringify(
        {
          devDependencies: {
            typescript: "^5.8.3",
          },
          scripts: {
            lint: "eslint .",
            test: "vitest run",
            typecheck: "tsc --noEmit",
          },
        },
        null,
        2,
      ),
    );
    writeProjectFile(projectRoot, "tsconfig.json", "{}\n");
    writeProjectFile(projectRoot, "package-lock.json", "{}\n");

    const resolvedProject = await resolveProjectContext({
      commands: {
        install: "npm ci",
        lint: "npm run lint:ci",
        test: "npm run test:ci",
        typecheck: "npm run typecheck:ci",
      },
      projectRoot,
    });

    expect(resolvedProject.commands.install).toEqual({
      command: "npm ci",
      source: "config",
    });
    expect(resolvedProject.commands.lint).toEqual({
      command: "npm run lint:ci",
      source: "config",
    });
    expect(resolvedProject.commands.test).toEqual({
      command: "npm run test:ci",
      source: "config",
    });
    expect(resolvedProject.commands.typecheck).toEqual({
      command: "npm run typecheck:ci",
      source: "config",
    });
  });
});
