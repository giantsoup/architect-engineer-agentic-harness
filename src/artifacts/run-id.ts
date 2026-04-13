import { randomBytes } from "node:crypto";

export const RUN_ID_PATTERN = /^\d{8}T\d{6}\.\d{3}Z-[a-f0-9]{6}$/u;

export interface CreateRunIdOptions {
  date?: Date;
  suffix?: string;
}

export function createRunId(options: CreateRunIdOptions = {}): string {
  const timestamp = formatRunTimestamp(options.date ?? new Date());
  const suffix = options.suffix ?? randomBytes(3).toString("hex");

  if (!/^[a-f0-9]{6}$/u.test(suffix)) {
    throw new Error(
      `Invalid run ID suffix "${suffix}". Expected exactly 6 lowercase hexadecimal characters.`,
    );
  }

  return `${timestamp}-${suffix}`;
}

export function formatRunTimestamp(date: Date): string {
  return [
    pad(date.getUTCFullYear(), 4),
    pad(date.getUTCMonth() + 1, 2),
    pad(date.getUTCDate(), 2),
    "T",
    pad(date.getUTCHours(), 2),
    pad(date.getUTCMinutes(), 2),
    pad(date.getUTCSeconds(), 2),
    ".",
    pad(date.getUTCMilliseconds(), 3),
    "Z",
  ].join("");
}

export function isValidRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

export function assertValidRunId(runId: string): void {
  if (isValidRunId(runId)) {
    return;
  }

  throw new Error(
    `Invalid run ID "${runId}". Expected format YYYYMMDDTHHMMSS.mmmZ-abcdef.`,
  );
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}
