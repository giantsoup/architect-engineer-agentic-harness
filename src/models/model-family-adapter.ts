import type { JsonValue } from "../types/run.js";
import type {
  ModelChatMessage,
  ModelChatRequest,
  ModelToolCall,
  ModelToolDefinition,
  ResolvedModelConfig,
} from "./types.js";

export type ModelToolCallMode = "disabled" | "fallback" | "native";

interface OpenAiCompatibleChoiceLike {
  message?: {
    content?: string | Array<{ text?: string; type?: string }> | null;
    tool_calls?: OpenAiCompatibleToolCallLike[] | null;
  } | null;
}

interface OpenAiCompatibleToolCallLike {
  function?: {
    arguments?: string | Record<string, JsonValue> | null;
    name?: string | null;
  } | null;
  id?: string | null;
}

export interface ExtractedToolCallResult {
  assistantContent: string;
  toolCalls: readonly ModelToolCall[];
}

export interface ModelFamilyAdapter {
  readonly id: "default" | "qwen" | "qwen3-coder";

  buildMessages<TStructured>(
    request: ModelChatRequest<TStructured>,
    options: {
      toolCallMode: ModelToolCallMode;
      useNativeStructuredOutput: boolean;
    },
  ): Array<Record<string, unknown>>;

  buildToolPayload(
    tools: readonly ModelToolDefinition[] | undefined,
    toolCallMode: ModelToolCallMode,
  ): readonly Record<string, unknown>[] | undefined;

  extractToolCalls(
    choice: OpenAiCompatibleChoiceLike | undefined,
  ): ExtractedToolCallResult;

  getToolCallFallbackInstruction(
    request: Pick<ModelChatRequest, "toolFallbackInstruction" | "tools">,
  ): string | undefined;

  shouldDisableReasoningParameter(): boolean;
}

export function resolveModelFamilyAdapter(
  config: ResolvedModelConfig,
): ModelFamilyAdapter {
  if (isQwen3CoderModel(config.model)) {
    return new QwenModelFamilyAdapter("qwen3-coder");
  }

  if (isQwenModel(config.model)) {
    return new QwenModelFamilyAdapter("qwen");
  }

  return DEFAULT_MODEL_FAMILY_ADAPTER;
}

const DEFAULT_MODEL_FAMILY_ADAPTER: ModelFamilyAdapter = {
  buildMessages<TStructured>(
    request: ModelChatRequest<TStructured>,
    options: {
      toolCallMode: ModelToolCallMode;
      useNativeStructuredOutput: boolean;
    },
  ): Array<Record<string, unknown>> {
    return buildDefaultMessages(request, options);
  },
  buildToolPayload(
    tools: readonly ModelToolDefinition[] | undefined,
    toolCallMode: ModelToolCallMode,
  ): readonly Record<string, unknown>[] | undefined {
    if (toolCallMode !== "native" || tools === undefined) {
      return undefined;
    }

    return tools.map((tool) => toOpenAiTool(tool));
  },
  extractToolCalls(choice): ExtractedToolCallResult {
    const toolCalls = extractNativeToolCalls(choice);

    return {
      assistantContent: extractAssistantContent(choice, toolCalls),
      toolCalls,
    };
  },
  getToolCallFallbackInstruction(
    request: Pick<ModelChatRequest, "toolFallbackInstruction">,
  ): string | undefined {
    return request.toolFallbackInstruction;
  },
  id: "default",
  shouldDisableReasoningParameter(): boolean {
    return false;
  },
};

class QwenModelFamilyAdapter implements ModelFamilyAdapter {
  readonly id: "qwen" | "qwen3-coder";

  constructor(id: "qwen" | "qwen3-coder") {
    this.id = id;
  }

  buildMessages<TStructured>(
    request: ModelChatRequest<TStructured>,
    options: {
      toolCallMode: ModelToolCallMode;
      useNativeStructuredOutput: boolean;
    },
  ): Array<Record<string, unknown>> {
    const messages = request.messages.map((message) => toQwenMessage(message));

    if (
      !options.useNativeStructuredOutput &&
      request.structuredOutput !== undefined
    ) {
      messages.push({
        content: renderStructuredOutputFallbackInstruction(
          request.structuredOutput,
        ),
        role: "system",
      });
    }

    const toolFallbackInstruction =
      options.toolCallMode === "fallback"
        ? this.getToolCallFallbackInstruction(request)
        : undefined;

    if (toolFallbackInstruction !== undefined) {
      messages.push({
        content: toolFallbackInstruction,
        role: "system",
      });
    }

    return messages;
  }

  buildToolPayload(
    tools: readonly ModelToolDefinition[] | undefined,
    toolCallMode: ModelToolCallMode,
  ): readonly Record<string, unknown>[] | undefined {
    if (toolCallMode !== "native" || tools === undefined) {
      return undefined;
    }

    return tools.map((tool) => toOpenAiTool(tool));
  }

  extractToolCalls(
    choice: OpenAiCompatibleChoiceLike | undefined,
  ): ExtractedToolCallResult {
    const nativeToolCalls = extractNativeToolCalls(choice);
    const assistantContent = extractAssistantContent(choice, nativeToolCalls);
    const contentWithoutToolCalls = stripQwenToolCallMarkup(assistantContent);

    if (nativeToolCalls.length > 0) {
      return {
        assistantContent: contentWithoutToolCalls,
        toolCalls: nativeToolCalls,
      };
    }

    const parsedToolCalls = parseQwenToolCalls(assistantContent, this.id);

    return {
      assistantContent: contentWithoutToolCalls,
      toolCalls: parsedToolCalls,
    };
  }

  getToolCallFallbackInstruction(
    request: Pick<ModelChatRequest, "toolFallbackInstruction" | "tools">,
  ): string | undefined {
    if ((request.tools?.length ?? 0) === 0) {
      return undefined;
    }

    return this.id === "qwen3-coder"
      ? renderQwen3CoderToolFallbackInstruction(request.tools ?? [])
      : renderQwenToolFallbackInstruction(request.tools ?? []);
  }

  shouldDisableReasoningParameter(): boolean {
    return this.id === "qwen";
  }
}

function buildDefaultMessages<TStructured>(
  request: ModelChatRequest<TStructured>,
  options: {
    toolCallMode: ModelToolCallMode;
    useNativeStructuredOutput: boolean;
  },
): Array<Record<string, unknown>> {
  const messages = request.messages.map((message) => toOpenAiMessage(message));

  if (
    !options.useNativeStructuredOutput &&
    request.structuredOutput !== undefined
  ) {
    messages.push({
      content: renderStructuredOutputFallbackInstruction(
        request.structuredOutput,
      ),
      role: "developer",
    });
  }

  if (
    options.toolCallMode !== "native" &&
    request.toolFallbackInstruction !== undefined
  ) {
    messages.push({
      content: request.toolFallbackInstruction,
      role: "developer",
    });
  }

  return messages;
}

function toOpenAiMessage(message: ModelChatMessage): Record<string, unknown> {
  const normalizedRole = normalizeDefaultMessageRole(message.role);
  const normalizedContent =
    message.role === "tool"
      ? renderDefaultToolResultMessage(message)
      : message.content;
  const openAiMessage: Record<string, unknown> = {
    content: normalizedContent,
    role: normalizedRole,
  };

  if (message.name !== undefined && normalizedRole !== "user") {
    openAiMessage.name = message.name;
  }

  if (message.toolCallId !== undefined && normalizedRole === "tool") {
    openAiMessage.tool_call_id = message.toolCallId;
  }

  return openAiMessage;
}

function toQwenMessage(message: ModelChatMessage): Record<string, unknown> {
  const normalizedRole = normalizeQwenMessageRole(message.role);
  const qwenMessage: Record<string, unknown> = {
    content: message.content,
    role: normalizedRole,
  };

  if (message.name !== undefined && normalizedRole !== "user") {
    qwenMessage.name = message.name;
  }

  if (message.toolCallId !== undefined && normalizedRole === "tool") {
    qwenMessage.tool_call_id = message.toolCallId;
  }

  return qwenMessage;
}

function normalizeDefaultMessageRole(role: ModelChatMessage["role"]): string {
  switch (role) {
    case "assistant":
      return "assistant";
    case "developer":
      return "system";
    case "system":
      return "system";
    case "tool":
      return "user";
    case "user":
      return "user";
  }
}

function normalizeQwenMessageRole(role: ModelChatMessage["role"]): string {
  switch (role) {
    case "assistant":
      return "assistant";
    case "developer":
      return "system";
    case "system":
      return "system";
    case "tool":
      return "tool";
    case "user":
      return "user";
  }
}

function renderDefaultToolResultMessage(message: ModelChatMessage): string {
  const toolLabel = message.name === undefined ? "tool" : message.name;

  return [`Tool result for ${toolLabel}:`, message.content].join("\n");
}

function extractAssistantContent(
  choice: OpenAiCompatibleChoiceLike | undefined,
  toolCalls: readonly ModelToolCall[],
): string {
  const content = choice?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textContent = content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("");

    if (textContent.length > 0) {
      return textContent;
    }
  }

  if (toolCalls.length > 0) {
    return "";
  }

  throw new Error(
    "OpenAI-compatible response did not include assistant text content in choices[0].message.content.",
  );
}

function extractNativeToolCalls(
  choice: OpenAiCompatibleChoiceLike | undefined,
): ModelToolCall[] {
  const toolCalls = choice?.message?.tool_calls;

  if (toolCalls === undefined || toolCalls === null) {
    return [];
  }

  return toolCalls.map((toolCall, index) =>
    normalizeNativeToolCall(toolCall, index),
  );
}

function normalizeNativeToolCall(
  toolCall: OpenAiCompatibleToolCallLike,
  index: number,
): ModelToolCall {
  const name = toolCall.function?.name?.trim();

  if (name === undefined || name.length === 0) {
    throw new Error(
      `OpenAI-compatible response tool_calls[${index}] did not include a function name.`,
    );
  }

  const id = toolCall.id?.trim();

  if (id === undefined || id.length === 0) {
    throw new Error(
      `OpenAI-compatible response tool_calls[${index}] did not include an id.`,
    );
  }

  const parsedArguments = parseToolArgumentValue(
    toolCall.function?.arguments ?? {},
    `tool_calls[${index}]`,
  );

  if (!isPlainObject(parsedArguments)) {
    throw new Error(
      `OpenAI-compatible response tool_calls[${index}] arguments must decode to an object.`,
    );
  }

  return {
    arguments: JSON.parse(JSON.stringify(parsedArguments)) as Record<
      string,
      JsonValue
    >,
    id,
    name,
  };
}

function parseQwenToolCalls(
  rawContent: string,
  adapterId: "qwen" | "qwen3-coder",
): ModelToolCall[] {
  const toolCallBlocks = [
    ...rawContent.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/giu),
  ];

  if (toolCallBlocks.length === 0) {
    return [];
  }

  return toolCallBlocks.map((match, index) => {
    const block = (match[1] ?? "").trim();
    const id = `qwen-tool-call-${index + 1}`;

    if (adapterId === "qwen") {
      return parseQwenJsonToolCallBlock(block, id);
    }

    return parseQwen3CoderToolCallBlock(block, id);
  });
}

function parseQwenJsonToolCallBlock(block: string, id: string): ModelToolCall {
  const parsed = parseToolArgumentValue(block, "qwen_tool_call");

  if (!isPlainObject(parsed)) {
    throw new Error(
      "Qwen tool call payload must decode to an object inside <tool_call>.",
    );
  }

  if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
    throw new Error("Qwen tool call payload did not include a function name.");
  }

  const parsedArguments =
    parsed.arguments === undefined || parsed.arguments === null
      ? {}
      : parseToolArgumentValue(parsed.arguments, parsed.name);

  if (!isPlainObject(parsedArguments)) {
    throw new Error(
      "Qwen tool call arguments must decode to an object inside <tool_call>.",
    );
  }

  return {
    arguments: JSON.parse(JSON.stringify(parsedArguments)) as Record<
      string,
      JsonValue
    >,
    id,
    name: parsed.name.trim(),
  };
}

function parseQwen3CoderToolCallBlock(
  block: string,
  id: string,
): ModelToolCall {
  const functionMatch =
    /^<function=([^\n>]+)>\s*([\s\S]*?)\s*<\/function>$/iu.exec(block);

  if (functionMatch === null) {
    throw new Error(
      "Qwen3-Coder tool call payload must wrap parameters in <function=...></function>.",
    );
  }

  const name = functionMatch[1]?.trim();

  if (name === undefined || name.length === 0) {
    throw new Error("Qwen3-Coder tool call payload did not include a name.");
  }

  const argumentsRecord: Record<string, JsonValue> = {};
  const parametersBlock = functionMatch[2] ?? "";
  const parameterPattern = /<parameter=([^\n>]+)>([\s\S]*?)<\/parameter>/giu;

  for (const parameterMatch of parametersBlock.matchAll(parameterPattern)) {
    const parameterName = parameterMatch[1]?.trim();

    if (parameterName === undefined || parameterName.length === 0) {
      continue;
    }

    argumentsRecord[parameterName] = toJsonValue(
      parseLooseParameterValue(
        normalizeQwenParameterBlock(parameterMatch[2] ?? ""),
      ),
    );
  }

  return {
    arguments: argumentsRecord,
    id,
    name,
  };
}

function parseLooseParameterValue(value: string): JsonValue {
  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    return "";
  }

  try {
    return toJsonValue(JSON.parse(trimmedValue));
  } catch {
    return value.includes("\n") || value.includes("\r") ? value : trimmedValue;
  }
}

function normalizeQwenParameterBlock(value: string): string {
  const withoutLeadingNewline = value.startsWith("\r\n")
    ? value.slice(2)
    : value.startsWith("\n")
      ? value.slice(1)
      : value;

  if (withoutLeadingNewline.endsWith("\r\n")) {
    return withoutLeadingNewline.slice(0, -2);
  }

  if (withoutLeadingNewline.endsWith("\n")) {
    return withoutLeadingNewline.slice(0, -1);
  }

  return withoutLeadingNewline;
}

function stripQwenToolCallMarkup(rawContent: string): string {
  return rawContent
    .replace(/\n?<tool_call>\s*[\s\S]*?\s*<\/tool_call>/giu, "")
    .trim();
}

function parseToolArgumentValue(value: unknown, label: string): unknown {
  if (typeof value === "string") {
    const trimmedValue = value.trim();

    if (trimmedValue.length === 0) {
      return {};
    }

    try {
      return JSON.parse(trimmedValue);
    } catch (error) {
      throw new Error(`${label} had invalid JSON arguments.`, {
        cause: error,
      });
    }
  }

  return value;
}

function renderQwen3CoderToolFallbackInstruction(
  tools: readonly ModelToolDefinition[],
): string {
  return [
    "Qwen3-Coder native tool fallback mode.",
    "Use the following tools and emit native Qwen3-Coder tool calls directly in assistant content.",
    renderQwen3CoderToolsBlock(tools),
    "If you call a function, reply with optional brief reasoning before the call and no suffix after the final `</tool_call>` block.",
    "<tool_call>",
    "<function=file.read>",
    "<parameter=path>",
    "README.md",
    "</parameter>",
    "</function>",
    "</tool_call>",
  ].join("\n");
}

function renderQwenToolFallbackInstruction(
  tools: readonly ModelToolDefinition[],
): string {
  return [
    "Qwen native tool fallback mode.",
    "Use the following tools and emit native Qwen tool calls directly in assistant content.",
    "<tools>",
    ...tools.map((tool) => JSON.stringify(toOpenAiTool(tool))),
    "</tools>",
    "For each function call, return a JSON object with the function name and arguments inside `<tool_call></tool_call>` tags.",
    '<tool_call>{"name":"file.read","arguments":{"path":"README.md"}}</tool_call>',
  ].join("\n");
}

function renderQwen3CoderToolsBlock(
  tools: readonly ModelToolDefinition[],
): string {
  return [
    "<tools>",
    ...tools.map((tool) => renderQwen3CoderToolDefinition(tool)),
    "</tools>",
  ].join("\n");
}

function renderQwen3CoderToolDefinition(tool: ModelToolDefinition): string {
  const parameters = isPlainObject(tool.inputSchema.properties)
    ? Object.entries(tool.inputSchema.properties)
    : [];
  const lines = ["<function>", `<name>${tool.name}</name>`];

  if (tool.description !== undefined) {
    lines.push(`<description>${tool.description}</description>`);
  }

  lines.push("<parameters>");

  for (const [parameterName, parameterValue] of parameters) {
    if (!isPlainObject(parameterValue)) {
      continue;
    }

    lines.push("<parameter>");
    lines.push(`<name>${parameterName}</name>`);

    if (parameterValue.type !== undefined) {
      lines.push(`<type>${String(parameterValue.type)}</type>`);
    }

    if (parameterValue.description !== undefined) {
      lines.push(
        `<description>${String(parameterValue.description)}</description>`,
      );
    }

    if (parameterValue.enum !== undefined) {
      lines.push(`<enum>${JSON.stringify(parameterValue.enum)}</enum>`);
    }

    if (parameterValue.minimum !== undefined) {
      lines.push(`<minimum>${String(parameterValue.minimum)}</minimum>`);
    }

    if (parameterValue.maximum !== undefined) {
      lines.push(`<maximum>${String(parameterValue.maximum)}</maximum>`);
    }

    lines.push("</parameter>");
  }

  lines.push("</parameters>");
  lines.push("</function>");
  return lines.join("\n");
}

function renderStructuredOutputFallbackInstruction<TStructured>(
  structuredOutput: NonNullable<
    ModelChatRequest<TStructured>["structuredOutput"]
  >,
): string {
  return [
    `Structured output fallback mode for ${structuredOutput.formatName}.`,
    "Return exactly one JSON object and nothing else.",
    "Do not include markdown fences, comments, prose, or multiple JSON objects.",
    `The JSON must match this schema exactly: ${JSON.stringify(structuredOutput.schema)}`,
  ].join("\n");
}

function toOpenAiTool(tool: ModelToolDefinition): Record<string, unknown> {
  return {
    function: {
      ...(tool.description === undefined
        ? {}
        : { description: tool.description }),
      name: tool.name,
      parameters: tool.inputSchema,
    },
    type: "function",
  };
}

function isQwen3CoderModel(model: string): boolean {
  return /qwen(?:\/|[-_])?qwen3-coder|qwen3-coder/iu.test(model);
}

function isQwenModel(model: string): boolean {
  return /qwen/iu.test(model);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
