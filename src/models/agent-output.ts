import type { ToolRequest } from "../tools/types.js";
import type { ModelToolCall, ModelToolDefinition } from "./types.js";
import {
  createEngineerToolDefinitions,
  validateEngineerToolRequest,
} from "./engineer-output.js";

export interface AgentToolAction {
  request: ToolRequest;
  summary: string;
  toolCallId: string;
  type: "tool";
}

export interface AgentReplyAction {
  reply: string;
  type: "reply";
}

export type AgentTurn = AgentReplyAction | AgentToolAction;

export class AgentTurnValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      [
        "Agent response did not match the chat tool/reply protocol:",
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );

    this.name = "AgentTurnValidationError";
    this.issues = issues;
  }
}

export function createAgentToolDefinitions(): readonly ModelToolDefinition[] {
  return createEngineerToolDefinitions();
}

export function renderAgentToolFallbackInstruction(): string {
  return [
    "If native tool calling is unavailable, respond with exactly one JSON object.",
    "For a tool turn, use:",
    '{"type":"tool","summary":"<short reason>","request":{"toolName":"file.search","query":"..."}}',
    "For a final user-facing reply, use:",
    '{"type":"reply","reply":"<message for the user>"}',
    "Choose exactly one of those shapes per turn.",
  ].join("\n");
}

export async function resolveAgentTurn(options: {
  rawContent: string;
  toolCalls?: readonly ModelToolCall[] | undefined;
}): Promise<AgentTurn> {
  if ((options.toolCalls?.length ?? 0) > 0) {
    const toolCall = options.toolCalls?.[0];

    if (toolCall === undefined) {
      throw new AgentTurnValidationError([
        "Expected a native tool call but none was present.",
      ]);
    }

    const request = await validateEngineerToolRequest(
      {
        ...toolCall.arguments,
        toolName: toolCall.name,
      },
      `tool_calls[0].${toolCall.name}`,
    );

    return {
      request,
      summary: extractToolSummary(options.rawContent, toolCall.name),
      toolCallId: toolCall.id,
      type: "tool",
    };
  }

  const parsedJsonTurn = await parseJsonAgentTurn(options.rawContent);

  if (parsedJsonTurn !== undefined) {
    return parsedJsonTurn;
  }

  const reply = options.rawContent.trim();

  if (reply.length === 0) {
    throw new AgentTurnValidationError([
      "Expected either a tool request or a final reply.",
    ]);
  }

  return {
    reply,
    type: "reply",
  };
}

async function parseJsonAgentTurn(
  rawContent: string,
): Promise<AgentTurn | undefined> {
  for (const candidate of collectJsonCandidates(rawContent)) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const normalizedType =
        typeof parsed.type === "string" ? parsed.type.trim().toLowerCase() : "";

      if (normalizedType === "tool") {
        const request = await validateEngineerToolRequest(
          parsed.request,
          "agent_turn.request",
        );
        const summary =
          typeof parsed.summary === "string" && parsed.summary.trim().length > 0
            ? parsed.summary.trim()
            : `Use \`${request.toolName}\`.`;

        return {
          request,
          summary,
          toolCallId: "fallback-agent-tool-call",
          type: "tool",
        };
      }

      if (normalizedType === "reply") {
        const reply =
          typeof parsed.reply === "string" ? parsed.reply.trim() : undefined;

        if (reply === undefined || reply.length === 0) {
          throw new AgentTurnValidationError([
            "Fallback reply JSON must include a non-empty `reply` string.",
          ]);
        }

        return {
          reply,
          type: "reply",
        };
      }
    } catch (error) {
      if (error instanceof AgentTurnValidationError) {
        throw error;
      }
    }
  }

  return undefined;
}

function extractToolSummary(rawContent: string, toolName: string): string {
  const firstNonEmptyLine = rawContent
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstNonEmptyLine ?? `Use \`${toolName}\`.`;
}

function collectJsonCandidates(rawContent: string): string[] {
  const trimmed = rawContent.trim();
  const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);

  if (fencedMatch !== null) {
    return [fencedMatch[1]!, trimmed];
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return [trimmed];
  }

  return [];
}
