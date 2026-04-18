import { readFile } from "node:fs/promises";

import { getResolvedProjectCommand } from "../adapters/detect-project.js";
import { OperationCancelledError } from "../cancellation.js";
import {
  createAgentToolDefinitions,
  renderAgentToolFallbackInstruction,
  resolveAgentTurn,
} from "../models/agent-output.js";
import { createRoleModelClient } from "../models/provider-factory.js";
import type { ModelChatMessage } from "../models/types.js";
import { createProjectCommandRunner } from "../sandbox/command-runner.js";
import { createToolRouter } from "../tools/tool-router.js";
import type { ToolRequest, ToolResult } from "../tools/types.js";
import type { LoadedHarnessConfig } from "../types/config.js";
import type {
  ConversationMessageRecord,
  RunCheckResult,
  RunChecksSummary,
  RunResult,
} from "../types/run.js";
import { DEFAULT_PROMPT_VERSION } from "../versioning.js";
import {
  appendConversationMessage,
  appendRunEvent,
  initializeRunDossier,
  writeChecks,
  writeDiff,
  writeFinalReport,
  writeRunLifecycleStatus,
  writeRunResult,
  type RunDossier,
} from "./run-dossier.js";
import {
  createHarnessEventBus,
  type HarnessEventBus,
} from "./harness-events.js";

const MAX_ACTIVITY_ENTRIES = 16;
const MAX_RECENT_VISIBLE_MESSAGES = 12;
const MAX_CONTEXT_CHARS = 28_000;

export interface AgentChatSessionActivityEntry {
  level: "error" | "info" | "warn";
  text: string;
  timestamp: string;
}

export interface AgentChatTranscriptEntry extends ConversationMessageRecord {
  id: string;
}

export interface AgentChatSessionSnapshot {
  activity: {
    currentCommand?: string | undefined;
    currentTool?: string | undefined;
    gitSummary: string;
    latestCheck?: string | undefined;
    recent: readonly AgentChatSessionActivityEntry[];
  };
  busy: boolean;
  closed: boolean;
  lastTurnOutcome?: "cancelled" | "failed" | "replied" | undefined;
  runId: string;
  transcript: readonly AgentChatTranscriptEntry[];
  turnIndex: number;
}

export interface CreateAgentChatSessionOptions {
  eventBus?: HarnessEventBus | undefined;
  loadedConfig: LoadedHarnessConfig;
  now?: (() => Date) | undefined;
}

export interface AgentChatSession {
  readonly dossier: RunDossier;
  readonly eventBus: HarnessEventBus;
  close(status?: RunResult["status"]): Promise<RunResult>;
  getSnapshot(): AgentChatSessionSnapshot;
  start(): Promise<void>;
  submitUserMessage(message: string): Promise<void>;
  cancelActiveTurn(): void;
  subscribe(listener: (snapshot: AgentChatSessionSnapshot) => void): () => void;
}

export async function createAgentChatSession(
  options: CreateAgentChatSessionOptions,
): Promise<AgentChatSession> {
  const now = options.now ?? (() => new Date());
  const eventBus = options.eventBus ?? createHarnessEventBus({ now });
  const prompts = await initializePrompts();
  const dossier = await initializeRunDossier(options.loadedConfig, {
    kind: "agent-chat",
  });
  const commandRunner = createProjectCommandRunner({
    dossierPaths: dossier.paths,
    eventBus,
    loadedConfig: options.loadedConfig,
    now,
  });
  const toolRouter = createToolRouter({
    dossierPaths: dossier.paths,
    eventBus,
    loadedConfig: options.loadedConfig,
    now,
    projectCommandRunner: commandRunner,
  });
  const modelClient = createRoleModelClient({
    dossierPaths: dossier.paths,
    eventBus,
    loadedConfig: options.loadedConfig,
    role: "agent",
  });

  return new DefaultAgentChatSession({
    commandRunner,
    dossier,
    eventBus,
    loadedConfig: options.loadedConfig,
    modelClient,
    now,
    prompts,
    toolRouter,
  });
}

class DefaultAgentChatSession implements AgentChatSession {
  readonly dossier: RunDossier;
  readonly eventBus: HarnessEventBus;

  readonly #commandRunner: ReturnType<typeof createProjectCommandRunner>;
  readonly #loadedConfig: LoadedHarnessConfig;
  readonly #modelClient: ReturnType<typeof createRoleModelClient>;
  readonly #now: () => Date;
  readonly #prompts: Record<"chat" | "summarize" | "system", string>;
  readonly #toolRouter: ReturnType<typeof createToolRouter>;
  readonly #listeners = new Set<(snapshot: AgentChatSessionSnapshot) => void>();
  readonly #transcript: AgentChatTranscriptEntry[] = [];
  readonly #activity: AgentChatSessionSnapshot["activity"] = {
    gitSummary: "Git status not checked yet.",
    recent: [],
  };
  readonly #checks: RunCheckResult[] = [];
  #busy = false;
  #closed = false;
  #contextSummary: string | undefined;
  #lastTurnOutcome: AgentChatSessionSnapshot["lastTurnOutcome"];
  #turnAbortController: AbortController | undefined;
  #turnIndex = 0;

  constructor(options: {
    commandRunner: ReturnType<typeof createProjectCommandRunner>;
    dossier: RunDossier;
    eventBus: HarnessEventBus;
    loadedConfig: LoadedHarnessConfig;
    modelClient: ReturnType<typeof createRoleModelClient>;
    now: () => Date;
    prompts: Record<"chat" | "summarize" | "system", string>;
    toolRouter: ReturnType<typeof createToolRouter>;
  }) {
    this.#commandRunner = options.commandRunner;
    this.dossier = options.dossier;
    this.eventBus = options.eventBus;
    this.#loadedConfig = options.loadedConfig;
    this.#modelClient = options.modelClient;
    this.#now = options.now;
    this.#prompts = options.prompts;
    this.#toolRouter = options.toolRouter;
    this.eventBus.subscribe((event) => {
      switch (event.type) {
        case "command:start":
          if (event.role === "agent") {
            this.#activity.currentCommand = event.command;
          }
          this.#pushActivity(
            "info",
            `Command started: ${event.command}`,
            event.timestamp,
          );
          break;
        case "command:stdout":
          if (event.role === "agent") {
            this.#pushActivity(
              "info",
              `stdout: ${event.chunk.trim().slice(0, 160)}`,
              event.timestamp,
            );
          }
          break;
        case "command:stderr":
          if (event.role === "agent") {
            this.#pushActivity(
              "warn",
              `stderr: ${event.chunk.trim().slice(0, 160)}`,
              event.timestamp,
            );
          }
          break;
        case "command:end":
          if (event.role === "agent") {
            this.#activity.currentCommand = undefined;
          }
          this.#pushActivity(
            event.exitCode === 0 ? "info" : "warn",
            `Command finished (${event.exitCode}): ${event.command}`,
            event.timestamp,
          );
          break;
        case "command:error":
          if (event.role === "agent") {
            this.#activity.currentCommand = undefined;
          }
          this.#pushActivity(
            "error",
            `Command ${event.status}: ${event.command}`,
            event.timestamp,
          );
          break;
        case "check:update":
          this.#activity.latestCheck = formatCheckSummary(event.check);
          this.#pushActivity(
            event.check.status === "passed" ? "info" : "warn",
            this.#activity.latestCheck,
            event.timestamp,
          );
          break;
        case "model:request":
          if (event.role === "agent") {
            this.#pushActivity(
              "info",
              `Model request ${event.attempt}: ${event.provider}/${event.model}`,
              event.timestamp,
            );
          }
          break;
        case "model:retry":
          if (event.role === "agent") {
            this.#pushActivity(
              event.retryable ? "warn" : "error",
              `Model retry: ${event.message}`,
              event.timestamp,
            );
          }
          break;
        case "agent:action":
          this.#activity.currentTool = event.toolName;
          this.#pushActivity("info", event.summary, this.#now().toISOString());
          break;
        case "agent:turn":
          if (event.status === "finished") {
            this.#activity.currentTool = undefined;
          }
          this.#pushActivity("info", event.summary, this.#now().toISOString());
          break;
        case "agent:session":
          this.#pushActivity("info", event.summary, this.#now().toISOString());
          break;
      }

      this.#emitSnapshot();
    });
  }

  getSnapshot(): AgentChatSessionSnapshot {
    return {
      activity: {
        ...this.#activity,
        recent: [...this.#activity.recent],
      },
      busy: this.#busy,
      closed: this.#closed,
      ...(this.#lastTurnOutcome === undefined
        ? {}
        : { lastTurnOutcome: this.#lastTurnOutcome }),
      runId: this.dossier.paths.runId,
      transcript: [...this.#transcript],
      turnIndex: this.#turnIndex,
    };
  }

  subscribe(
    listener: (snapshot: AgentChatSessionSnapshot) => void,
  ): () => void {
    this.#listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    const timestamp = this.#now().toISOString();

    await writeRunLifecycleStatus(this.dossier.paths, "running", timestamp);
    await this.#toolRouter.prepare();
    await appendRunEvent(this.dossier.paths, {
      summary: "Interactive agent chat session started.",
      timestamp,
      type: "agent-session-started",
    });
    this.eventBus.emit({
      phase: "started",
      runId: this.dossier.paths.runId,
      summary: "Interactive agent chat session started.",
      type: "agent:session",
    });
    this.eventBus.emit({
      runId: this.dossier.paths.runId,
      status: "running",
      summary: "Interactive agent chat session started.",
      type: "run:status",
    });
    await this.#appendVisibleMessage({
      content:
        "Interactive chat is ready. Ask for repo changes, investigation, or commands.",
      role: "system",
      timestamp,
    });
    await this.#refreshGitSummary();
  }

  async submitUserMessage(message: string): Promise<void> {
    const trimmedMessage = message.trim();

    if (trimmedMessage.length === 0) {
      return;
    }

    if (this.#closed) {
      throw new Error("Chat session is already closed.");
    }

    if (this.#busy) {
      throw new Error("A turn is already running.");
    }

    this.#busy = true;
    this.#turnIndex += 1;
    const turnIndex = this.#turnIndex;
    const startedAt = this.#now().toISOString();
    this.#turnAbortController = new AbortController();
    await this.#appendVisibleMessage({
      content: trimmedMessage,
      role: "user",
      timestamp: startedAt,
    });
    await appendRunEvent(this.dossier.paths, {
      summary: summarizeText(trimmedMessage),
      timestamp: startedAt,
      turnIndex,
      type: "agent-turn-started",
    });
    this.eventBus.emit({
      runId: this.dossier.paths.runId,
      status: "started",
      summary: `Turn ${turnIndex} started.`,
      turnIndex,
      type: "agent:turn",
    });
    this.#emitSnapshot();

    try {
      const currentTurnMessages: ModelChatMessage[] = [];

      while (true) {
        const response = await this.#modelClient.chat({
          messages: this.#buildModelMessages(currentTurnMessages),
          signal: this.#turnAbortController.signal,
          toolFallbackInstruction: renderAgentToolFallbackInstruction(),
          tools: createAgentToolDefinitions(),
        });
        const turn = await resolveAgentTurn({
          rawContent: response.rawContent,
          toolCalls: response.toolCalls,
        });

        if (turn.type === "reply") {
          const finishedAt = this.#now().toISOString();

          await this.#appendVisibleMessage({
            content: turn.reply,
            role: "agent",
            timestamp: finishedAt,
          });
          await appendRunEvent(this.dossier.paths, {
            outcome: "replied",
            summary: summarizeText(turn.reply),
            timestamp: finishedAt,
            turnIndex,
            type: "agent-turn-finished",
          });
          this.eventBus.emit({
            outcome: "replied",
            runId: this.dossier.paths.runId,
            status: "finished",
            summary: `Turn ${turnIndex} replied.`,
            turnIndex,
            type: "agent:turn",
          });
          this.#lastTurnOutcome = "replied";
          break;
        }

        const toolTimestamp = this.#now().toISOString();
        this.eventBus.emit({
          runId: this.dossier.paths.runId,
          summary: turn.summary,
          toolName: turn.request.toolName,
          type: "agent:action",
        });
        await appendRunEvent(this.dossier.paths, {
          summary: turn.summary,
          timestamp: toolTimestamp,
          toolRequest: turn.request,
          type: "agent-action-selected",
        });

        try {
          const toolResult = await this.#toolRouter.execute(
            {
              role: "agent",
              signal: this.#turnAbortController.signal,
            },
            turn.request,
          );

          currentTurnMessages.push({
            content: renderToolResultMessage(toolResult),
            name: turn.request.toolName,
            role: "tool",
            toolCallId: turn.toolCallId,
          });
          await this.#maybeRecordCheck(turn.request, toolResult);
        } catch (error) {
          if (this.#turnAbortController.signal.aborted) {
            throw new OperationCancelledError("Turn cancelled.");
          }

          throw error;
        }
      }

      await this.#compactContextIfNeeded();
      await this.#refreshGitSummary();
    } catch (error) {
      const finishedAt = this.#now().toISOString();

      if (this.#turnAbortController.signal.aborted) {
        const cancellationMessage = "Turn cancelled.";

        await appendRunEvent(this.dossier.paths, {
          outcome: "cancelled",
          summary: cancellationMessage,
          timestamp: finishedAt,
          turnIndex,
          type: "agent-turn-finished",
        });
        this.eventBus.emit({
          outcome: "cancelled",
          runId: this.dossier.paths.runId,
          status: "finished",
          summary: cancellationMessage,
          turnIndex,
          type: "agent:turn",
        });
        await this.#appendVisibleMessage({
          content: cancellationMessage,
          role: "system",
          timestamp: finishedAt,
        });
        this.#lastTurnOutcome = "cancelled";
      } else {
        const message =
          error instanceof Error ? error.message : "Turn failed unexpectedly.";

        await appendRunEvent(this.dossier.paths, {
          outcome: "failed",
          summary: message,
          timestamp: finishedAt,
          turnIndex,
          type: "agent-turn-finished",
        });
        this.eventBus.emit({
          outcome: "failed",
          runId: this.dossier.paths.runId,
          status: "finished",
          summary: message,
          turnIndex,
          type: "agent:turn",
        });
        await this.#appendVisibleMessage({
          content: `Turn failed: ${message}`,
          role: "system",
          timestamp: finishedAt,
        });
        this.#lastTurnOutcome = "failed";
      }
    } finally {
      this.#busy = false;
      this.#turnAbortController = undefined;
      this.#activity.currentTool = undefined;
      this.#emitSnapshot();
    }
  }

  cancelActiveTurn(): void {
    this.#turnAbortController?.abort();
  }

  async close(status?: RunResult["status"]): Promise<RunResult> {
    if (this.#closed) {
      return {
        status: status ?? "success",
        summary: "Chat session already closed.",
      };
    }

    this.#closed = true;
    const timestamp = this.#now().toISOString();
    const resolvedStatus =
      status ?? (this.#lastTurnOutcome === "cancelled" ? "stopped" : "success");
    const summary =
      resolvedStatus === "success"
        ? "Interactive agent chat session finished cleanly."
        : resolvedStatus === "stopped"
          ? "Interactive agent chat session stopped after a cancelled turn."
          : "Interactive agent chat session failed.";

    try {
      await this.#writeWorkspaceArtifacts(timestamp);
      await appendRunEvent(this.dossier.paths, {
        status: resolvedStatus,
        summary,
        timestamp,
        type: "agent-session-finished",
      });
      this.eventBus.emit({
        phase: "finished",
        runId: this.dossier.paths.runId,
        status: resolvedStatus,
        summary,
        type: "agent:session",
      });
      this.eventBus.emit({
        runId: this.dossier.paths.runId,
        status: resolvedStatus,
        summary,
        type: "run:status",
      });
      await writeFinalReport(
        this.dossier.paths,
        renderFinalReport({
          gitSummary: this.#activity.gitSummary,
          latestCheck: this.#activity.latestCheck,
          summary,
          transcript: this.#transcript,
        }),
        timestamp,
      );
      const result: RunResult = {
        artifacts: [
          this.dossier.paths.files.conversation.relativePath,
          this.dossier.paths.files.events.relativePath,
          this.dossier.paths.files.commandLog.relativePath,
          this.dossier.paths.files.checks.relativePath,
          this.dossier.paths.files.diff.relativePath,
          this.dossier.paths.files.finalReport.relativePath,
          this.dossier.paths.files.result.relativePath,
        ],
        status: resolvedStatus,
        summary,
      };

      await writeRunResult(this.dossier.paths, result, timestamp);
      await writeRunLifecycleStatus(
        this.dossier.paths,
        resolvedStatus,
        timestamp,
      );
      return result;
    } finally {
      await this.#toolRouter.close("chat session closed");
      this.#commandRunner.close("chat session closed");
      this.#emitSnapshot();
    }
  }

  async #appendVisibleMessage(
    message: ConversationMessageRecord,
  ): Promise<void> {
    await appendConversationMessage(this.dossier.paths, message);
    this.#transcript.push({
      ...message,
      id: `${message.timestamp}-${this.#transcript.length + 1}`,
    });
    this.#emitSnapshot();
  }

  #buildModelMessages(
    currentTurnMessages: readonly ModelChatMessage[],
  ): readonly ModelChatMessage[] {
    const visibleMessages = this.#transcript
      .filter((entry) => entry.role === "agent" || entry.role === "user")
      .slice(-MAX_RECENT_VISIBLE_MESSAGES)
      .map<ModelChatMessage>((entry) => ({
        content: entry.content,
        role: entry.role === "agent" ? "assistant" : "user",
      }));

    return [
      {
        content: this.#getPrompt("system"),
        role: "system",
      },
      {
        content: this.#getPrompt("chat"),
        role: "developer",
      },
      ...(this.#contextSummary === undefined
        ? []
        : [
            {
              content: `Conversation summary:\n${this.#contextSummary}`,
              role: "system" as const,
            },
          ]),
      ...visibleMessages,
      ...currentTurnMessages,
    ];
  }

  #getPrompt(kind: "chat" | "summarize" | "system"): string {
    return this.#prompts[kind];
  }

  async #compactContextIfNeeded(): Promise<void> {
    const serializedTranscript = JSON.stringify(
      this.#transcript.map((entry) => ({
        content: entry.content,
        role: entry.role,
      })),
    );

    if (serializedTranscript.length <= MAX_CONTEXT_CHARS) {
      return;
    }

    const summaryResponse = await this.#modelClient.chat({
      messages: [
        {
          content: this.#getPrompt("system"),
          role: "system",
        },
        {
          content: this.#getPrompt("summarize"),
          role: "developer",
        },
        {
          content: renderTranscriptForSummarization(this.#transcript),
          role: "user",
        },
      ],
    });

    this.#contextSummary = summaryResponse.rawContent.trim();
    await appendRunEvent(this.dossier.paths, {
      summary: this.#contextSummary,
      timestamp: this.#now().toISOString(),
      type: "context-summary-updated",
    });
  }

  async #refreshGitSummary(): Promise<void> {
    try {
      const gitStatus = await this.#toolRouter.execute(
        { role: "agent" },
        { toolName: "git.status" },
      );

      if (gitStatus.toolName !== "git.status") {
        return;
      }

      this.#activity.gitSummary = gitStatus.isClean
        ? `Clean on ${gitStatus.branch.head}`
        : `${gitStatus.entries.length} change(s) on ${gitStatus.branch.head}`;
      this.#emitSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#activity.gitSummary = `Git status unavailable: ${message}`;
      this.#emitSnapshot();
    }
  }

  async #writeWorkspaceArtifacts(timestamp: string): Promise<void> {
    try {
      const diffResult = await this.#toolRouter.execute(
        { role: "agent" },
        { toolName: "git.diff" },
      );

      if (diffResult.toolName === "git.diff") {
        await writeDiff(this.dossier.paths, diffResult.diff, timestamp);
      }
    } catch {
      await writeDiff(this.dossier.paths, "", timestamp);
    }
  }

  async #maybeRecordCheck(
    request: ToolRequest,
    result: ToolResult,
  ): Promise<void> {
    if (
      request.toolName !== "command.execute" ||
      result.toolName !== "command.execute"
    ) {
      return;
    }

    const checkName = resolveCheckName(this.#loadedConfig, request.command);

    if (checkName === undefined) {
      return;
    }

    const checkResult: RunCheckResult = {
      command: request.command,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      name: checkName,
      status: result.exitCode === 0 ? "passed" : "failed",
      summary:
        result.exitCode === 0 ? "Completed successfully." : "Command failed.",
    };

    this.#checks.push(checkResult);
    this.#activity.latestCheck = formatCheckSummary(checkResult);
    const recordedAt = this.#now().toISOString();
    const checksSummary: RunChecksSummary = {
      checks: [...this.#checks],
      recordedAt,
    };

    await writeChecks(this.dossier.paths, checksSummary, recordedAt);
    this.eventBus.emit({
      check: checkResult,
      consecutiveFailedChecks:
        checkResult.status === "failed"
          ? this.#checks
              .slice()
              .reverse()
              .findIndex((entry) => entry.status === "passed") + 1 ||
            this.#checks.length
          : 0,
      requiredCheckCommand:
        getResolvedProjectCommand(this.#loadedConfig.resolvedProject, "test") ??
        checkResult.command ??
        checkName,
      runId: this.dossier.paths.runId,
      totalChecks: this.#checks.length,
      type: "check:update",
    });
  }

  #pushActivity(
    level: AgentChatSessionActivityEntry["level"],
    text: string,
    timestamp: string,
  ): void {
    const normalizedText = text.trim();

    if (normalizedText.length === 0) {
      return;
    }

    const recentEntries = [
      ...this.#activity.recent,
      {
        level,
        text: normalizedText,
        timestamp,
      },
    ].slice(-MAX_ACTIVITY_ENTRIES);

    this.#activity.recent = recentEntries;
  }

  #emitSnapshot(): void {
    const snapshot = this.getSnapshot();

    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}

async function loadPromptAsset(relativePath: string): Promise<string> {
  const candidates = [
    new URL(`../../${relativePath}`, import.meta.url),
    new URL(`../${relativePath}`, import.meta.url),
  ];

  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      const maybeNodeError = error as NodeJS.ErrnoException;

      if (maybeNodeError.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Could not load prompt asset ${relativePath}.`);
}

async function initializePrompts(): Promise<
  Record<"chat" | "summarize" | "system", string>
> {
  const [system, chat, summarize] = await Promise.all([
    loadPromptAsset(`prompts/${DEFAULT_PROMPT_VERSION}/agent/system.md`),
    loadPromptAsset(`prompts/${DEFAULT_PROMPT_VERSION}/agent/chat.md`),
    loadPromptAsset(`prompts/${DEFAULT_PROMPT_VERSION}/agent/summarize.md`),
  ]);

  return { chat, summarize, system };
}

function renderToolResultMessage(result: ToolResult): string {
  return JSON.stringify(result);
}

function renderTranscriptForSummarization(
  transcript: readonly ConversationMessageRecord[],
): string {
  return transcript
    .map((entry) => `[${entry.role}] ${entry.content}`)
    .join("\n\n");
}

function summarizeText(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/gu, " ");

  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 119)}…`;
}

function resolveCheckName(
  loadedConfig: LoadedHarnessConfig,
  command: string,
): string | undefined {
  const normalizedCommand = normalizeCommand(command);
  const commandNames = [
    "build",
    "format",
    "install",
    "lint",
    "test",
    "typecheck",
  ] as const;

  for (const commandName of commandNames) {
    const resolvedCommand = getResolvedProjectCommand(
      loadedConfig.resolvedProject,
      commandName,
    );

    if (
      resolvedCommand !== undefined &&
      normalizeCommand(resolvedCommand) === normalizedCommand
    ) {
      return commandName;
    }
  }

  return undefined;
}

function normalizeCommand(command: string): string {
  return command.trim().replaceAll(/\s+/gu, " ");
}

function formatCheckSummary(check: RunCheckResult): string {
  return `${check.name}: ${check.status}${check.exitCode === undefined ? "" : ` (exit ${check.exitCode})`}`;
}

function renderFinalReport(options: {
  gitSummary: string;
  latestCheck?: string | undefined;
  summary: string;
  transcript: readonly ConversationMessageRecord[];
}): string {
  const lastUserMessage = [...options.transcript]
    .reverse()
    .find((entry) => entry.role === "user")?.content;
  const lastAgentMessage = [...options.transcript]
    .reverse()
    .find((entry) => entry.role === "agent")?.content;

  return [
    "# Agent Chat Session",
    "",
    `Summary: ${options.summary}`,
    `Latest user request: ${lastUserMessage ?? "none recorded"}`,
    `Latest agent reply: ${lastAgentMessage ?? "none recorded"}`,
    `Latest check: ${options.latestCheck ?? "none recorded"}`,
    `Git summary: ${options.gitSummary}`,
  ].join("\n");
}
