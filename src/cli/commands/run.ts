import path from "node:path";
import { readFile } from "node:fs/promises";

import { Command, InvalidArgumentError } from "commander";

import {
  buildRunDossierPaths,
  createProjectCommandRunner,
  createRunId,
  executeArchitectEngineerRun,
  initializeRunDossier,
  loadHarnessConfig,
} from "../../index.js";
import { readRunInspection } from "../../runtime/run-history.js";
import { createLiveConsoleRenderer } from "../../ui/live-console.js";
import { renderRunCompletionSummary } from "../../ui/summary-renderer.js";

interface RunCommandOptions {
  command?: string;
  cwd?: string;
  env: string[];
  projectRoot?: string;
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
    .option("--project-root <directory>", "Task-mode repository root")
    .option("--cwd <directory>", "Single-command working directory")
    .option(
      "--env <NAME=VALUE>",
      "Inject an environment variable into the executed command",
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
      const projectRoot = resolveRunProjectRoot(options, runMode);
      const loadedConfig = await loadHarnessConfig({
        projectRoot,
      });

      if (runMode.type === "engineer-task") {
        const runId = createRunId();
        const dossierPaths = buildRunDossierPaths({
          artifactsRootDir: loadedConfig.config.artifacts.rootDir,
          projectRoot: loadedConfig.projectRoot,
          runId,
          runsDir: loadedConfig.config.artifacts.runsDir,
        });
        const liveConsole = createLiveConsoleRenderer({
          paths: dossierPaths,
        });

        liveConsole.start();
        let execution: Awaited<ReturnType<typeof executeArchitectEngineerRun>>;

        try {
          execution = await executeArchitectEngineerRun({
            loadedConfig,
            runId,
            task: runMode.task,
            ...(options.timeoutMs === undefined
              ? {}
              : { timeoutMs: options.timeoutMs }),
          });
        } finally {
          await liveConsole.stop();
        }

        const unavailableMcpServers =
          execution.state.engineerExecution?.toolSummary.mcpServers
            .unavailable ?? [];
        const inspection = await readRunInspection(execution.dossier.paths);

        process.stderr.write(renderRunCompletionSummary(inspection));

        if (unavailableMcpServers.length > 0) {
          process.stderr.write("MCP warnings:\n");

          for (const diagnostic of unavailableMcpServers) {
            process.stderr.write(`- ${diagnostic.message}\n`);
          }
        }

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
    if (options.projectRoot !== undefined) {
      throw new InvalidArgumentError(
        "`--project-root` is only supported with `--task` or `--task-file`.",
      );
    }

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

function resolveRunProjectRoot(
  options: RunCommandOptions,
  runMode:
    | { command: string; type: "single-command" }
    | { task: string; type: "engineer-task" },
): string {
  if (runMode.type === "single-command") {
    return process.cwd();
  }

  return path.resolve(options.projectRoot ?? process.cwd());
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
