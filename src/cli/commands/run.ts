import path from "node:path";
import { readFile } from "node:fs/promises";

import { Command, InvalidArgumentError } from "commander";

import {
  createProjectCommandRunner,
  executeArchitectEngineerRun,
  initializeRunDossier,
  loadHarnessConfig,
} from "../../index.js";

interface RunCommandOptions {
  command?: string;
  cwd?: string;
  env: string[];
  role: "architect" | "engineer";
  task?: string;
  taskFile?: string;
  timeoutMs?: number;
}

export function createRunCommand(): Command {
  return new Command("run")
    .description(
      "Execute a single configured command or an Architect-Engineer task run",
    )
    .option("-c, --command <command>", "Shell command to execute")
    .option("--task <markdown>", "Engineer task brief markdown")
    .option("--task-file <path>", "Read the Engineer task brief from a file")
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
      const runMode = await resolveRunMode(options);
      const loadedConfig = await loadHarnessConfig({
        projectRoot: process.cwd(),
      });

      if (runMode.type === "engineer-task") {
        const execution = await executeArchitectEngineerRun({
          loadedConfig,
          task: runMode.task,
          ...(options.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs }),
        });
        const unavailableMcpServers =
          execution.state.engineerExecution?.toolSummary.mcpServers
            .unavailable ?? [];

        for (const diagnostic of unavailableMcpServers) {
          console.error(`MCP warning: ${diagnostic.message}`);
        }

        console.error(
          `Run ${execution.result.status}: ${execution.result.summary}. Dossier: ${execution.dossier.paths.runDirRelativePath}`,
        );
        process.exitCode = execution.result.status === "success" ? 0 : 1;
        return;
      }

      const dossier = await initializeRunDossier(loadedConfig);
      const runner = createProjectCommandRunner({
        dossierPaths: dossier.paths,
        loadedConfig,
      });

      try {
        const result =
          options.role === "architect"
            ? await runner.executeArchitectCommand({
                command: runMode.command,
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
                command: runMode.command,
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

async function resolveRunMode(
  options: RunCommandOptions,
): Promise<
  | { command: string; type: "single-command" }
  | { task: string; type: "engineer-task" }
> {
  if (options.command !== undefined) {
    if (options.task !== undefined || options.taskFile !== undefined) {
      throw new InvalidArgumentError(
        "Use either `--command` or `--task`/`--task-file`, not both.",
      );
    }

    return {
      command: options.command,
      type: "single-command",
    };
  }

  if (options.task !== undefined && options.taskFile !== undefined) {
    throw new InvalidArgumentError(
      "Use either `--task` or `--task-file`, not both.",
    );
  }

  if (options.task !== undefined) {
    return {
      task: options.task,
      type: "engineer-task",
    };
  }

  if (options.taskFile !== undefined) {
    return {
      task: await readTaskFile(options.taskFile),
      type: "engineer-task",
    };
  }

  throw new InvalidArgumentError(
    "Provide `--command` for single-command mode or `--task`/`--task-file` for Architect-Engineer task mode.",
  );
}

async function readTaskFile(taskFile: string): Promise<string> {
  const absolutePath = path.resolve(process.cwd(), taskFile);

  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new InvalidArgumentError(
      `Could not read task file \`${taskFile}\`: ${message}`,
    );
  }
}
