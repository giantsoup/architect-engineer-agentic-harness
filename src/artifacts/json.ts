import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";

import type { JsonValue } from "../types/run.js";

export function stringifyJson(value: unknown, indentation: number = 2): string {
  return `${JSON.stringify(sortJsonValue(value), null, indentation)}\n`;
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  await writeFile(temporaryPath, stringifyJson(value), "utf8");
  await rename(temporaryPath, filePath);
}

function sortJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (isPlainObject(value)) {
    const sortedEntries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entryValue]) => [key, sortJsonValue(entryValue)]);

    return Object.fromEntries(sortedEntries);
  }

  throw new Error(
    `Cannot serialize value of type ${value === undefined ? "undefined" : typeof value} as JSON.`,
  );
}

function isPlainObject(
  value: unknown,
): value is Record<string, JsonValue | undefined> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
