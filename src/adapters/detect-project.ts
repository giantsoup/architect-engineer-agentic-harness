import path from "node:path";
import { readFile, stat } from "node:fs/promises";

import type { HarnessConfig } from "../types/config.js";
import { laravelGenericAdapter } from "./laravel-generic.js";
import { typescriptGenericAdapter } from "./typescript-generic.js";
import type {
  DetectedProjectAdapter,
  ProjectAdapter,
  ProjectInspectionContext,
  ProjectCommandName,
  ProjectCommandResolution,
  ResolvedProjectContext,
} from "./types.js";

const UNKNOWN_PROJECT_ADAPTER: DetectedProjectAdapter = Object.freeze({
  id: "unknown",
  label: "Unknown",
  markers: [],
});

const PROJECT_ADAPTERS: readonly ProjectAdapter[] = Object.freeze([
  laravelGenericAdapter,
  typescriptGenericAdapter,
]);

export async function detectProjectAdapter(
  projectRoot: string,
): Promise<DetectedProjectAdapter> {
  const context = createProjectInspectionContext(projectRoot);

  for (const adapter of PROJECT_ADAPTERS) {
    const detectedAdapter = await adapter.detect(context);

    if (detectedAdapter !== undefined) {
      return detectedAdapter;
    }
  }

  return UNKNOWN_PROJECT_ADAPTER;
}

export async function resolveProjectContext(options: {
  commands: HarnessConfig["commands"];
  projectRoot: string;
}): Promise<ResolvedProjectContext> {
  const adapter = await detectProjectAdapter(options.projectRoot);
  const context = createProjectInspectionContext(options.projectRoot);
  const detectedCommands =
    adapter.id === "unknown"
      ? {}
      : await getAdapterById(adapter.id).resolveCommandDefaults(context);

  return {
    adapter,
    commands: {
      build: resolveCommand(options.commands.build),
      format: resolveCommand(options.commands.format),
      install: resolveCommand(
        options.commands.install,
        options.commands.setup,
        detectedCommands.install,
      ),
      lint: resolveCommand(
        options.commands.lint,
        undefined,
        detectedCommands.lint,
      ),
      test: resolveCommand(
        options.commands.test,
        undefined,
        detectedCommands.test,
      ),
      typecheck: resolveCommand(
        options.commands.typecheck,
        undefined,
        detectedCommands.typecheck,
      ),
    },
  };
}

export function getResolvedProjectCommand(
  project: ResolvedProjectContext,
  commandName: ProjectCommandName,
): string | undefined {
  return project.commands[commandName].command;
}

function createProjectInspectionContext(
  projectRoot: string,
): ProjectInspectionContext {
  const resolvedProjectRoot = path.resolve(projectRoot);

  return {
    async fileExists(relativePath: string): Promise<boolean> {
      try {
        await stat(path.join(resolvedProjectRoot, relativePath));
        return true;
      } catch (error) {
        const maybeNodeError = error as NodeJS.ErrnoException;

        if (maybeNodeError.code === "ENOENT") {
          return false;
        }

        throw error;
      }
    },
    projectRoot: resolvedProjectRoot,
    async readJson<TValue>(relativePath: string): Promise<TValue | undefined> {
      try {
        const contents = await readFile(
          path.join(resolvedProjectRoot, relativePath),
          "utf8",
        );

        return JSON.parse(contents) as TValue;
      } catch (error) {
        const maybeNodeError = error as NodeJS.ErrnoException;

        if (maybeNodeError.code === "ENOENT") {
          return undefined;
        }

        if (error instanceof SyntaxError) {
          return undefined;
        }

        throw error;
      }
    },
  };
}

function getAdapterById(id: DetectedProjectAdapter["id"]): ProjectAdapter {
  const adapter = PROJECT_ADAPTERS.find((candidate) => candidate.id === id);

  if (adapter === undefined) {
    throw new Error(`Unsupported project adapter: ${id}`);
  }

  return adapter;
}

function resolveCommand(
  configCommand: string | undefined,
  legacySetupCommand?: string | undefined,
  detectedCommand?: string | undefined,
): ProjectCommandResolution {
  if (configCommand !== undefined) {
    return {
      command: configCommand,
      source: "config",
    };
  }

  if (legacySetupCommand !== undefined) {
    return {
      command: legacySetupCommand,
      source: "config-legacy-setup",
    };
  }

  if (detectedCommand !== undefined) {
    return {
      command: detectedCommand,
      source: "adapter",
    };
  }

  return {
    source: "unresolved",
  };
}
