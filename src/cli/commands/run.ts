import { Command, InvalidArgumentError } from "commander";

import {
  createProjectCommandRunner,
  initializeRunDossier,
  loadHarnessConfig,
} from "../../index.js";

interface RunCommandOptions {
  command: string;
  cwd?: string;
  env: string[];
  role: "architect" | "engineer";
  timeoutMs?: number;
}

export function createRunCommand(): Command {
  return new Command("run")
    .description(
      "Execute a single configured command inside the project container",
    )
    .requiredOption("-c, --command <command>", "Shell command to execute")
    .option(
      "--cwd <directory>",
      "Working directory inside the project container",
    )
    .option(
      "--env <NAME=VALUE>",
      "Inject an environment variable into the container process",
      collectRepeatedOption,
      [],
    )
    .option("--role <role>", "Execution role", parseRole, "engineer")
    .option(
      "--timeout-ms <milliseconds>",
      "Command timeout in milliseconds",
      parsePositiveInteger,
    )
    .action(async (options: RunCommandOptions) => {
      const environment = parseEnvironmentEntries(options.env);
      const loadedConfig = await loadHarnessConfig({
        projectRoot: process.cwd(),
      });
      const dossier = await initializeRunDossier(loadedConfig);
      const runner = createProjectCommandRunner({
        dossierPaths: dossier.paths,
        loadedConfig,
      });

      try {
        const result =
          options.role === "architect"
            ? await runner.executeArchitectCommand({
                command: options.command,
                ...(options.cwd === undefined
                  ? {}
                  : { workingDirectory: options.cwd }),
                ...(options.timeoutMs === undefined
                  ? {}
                  : { timeoutMs: options.timeoutMs }),
                ...(Object.keys(environment).length === 0
                  ? {}
                  : { environment }),
              })
            : await runner.executeEngineerCommand({
                command: options.command,
                ...(options.cwd === undefined
                  ? {}
                  : { workingDirectory: options.cwd }),
                ...(options.timeoutMs === undefined
                  ? {}
                  : { timeoutMs: options.timeoutMs }),
                ...(Object.keys(environment).length === 0
                  ? {}
                  : { environment }),
              });

        if (result.stdout.length > 0) {
          process.stdout.write(result.stdout);
        }

        if (result.stderr.length > 0) {
          process.stderr.write(result.stderr);
        }

        console.error(
          `Command completed with exit code ${result.exitCode}. Dossier: ${dossier.paths.runDirRelativePath}`,
        );
        process.exitCode = result.exitCode;
      } finally {
        runner.close();
      }
    });
}

function collectRepeatedOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseEnvironmentEntries(entries: string[]): Record<string, string> {
  return Object.fromEntries(
    entries.map((entry) => {
      const separatorIndex = entry.indexOf("=");

      if (separatorIndex <= 0) {
        throw new InvalidArgumentError(
          `Invalid environment assignment \`${entry}\`. Use NAME=VALUE.`,
        );
      }

      return [entry.slice(0, separatorIndex), entry.slice(separatorIndex + 1)];
    }),
  );
}

function parsePositiveInteger(value: string): number {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new InvalidArgumentError("Expected a positive integer.");
  }

  return parsedValue;
}

function parseRole(value: string): "architect" | "engineer" {
  if (value === "architect" || value === "engineer") {
    return value;
  }

  throw new InvalidArgumentError(
    "Expected `architect` or `engineer` for --role.",
  );
}
