export class OperationCancelledError extends Error {
  constructor(message = "Operation cancelled.") {
    super(message);
    this.name = "OperationCancelledError";
  }
}

export function isCancellationRequested(
  signal: AbortSignal | undefined,
): boolean {
  return signal?.aborted === true;
}

export function throwIfCancellationRequested(
  signal: AbortSignal | undefined,
  message = "Operation cancelled.",
): void {
  if (isCancellationRequested(signal)) {
    throw new OperationCancelledError(message);
  }
}
