function slugifyBranchSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "")
    .replace(/-{2,}/gu, "-");
}

export interface CreateRunBranchNameOptions {
  runId: string;
  task: string;
}

export function createRunBranchName(
  options: CreateRunBranchNameOptions,
): string {
  const runIdSegment = options.runId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  const taskSlug = slugifyBranchSegment(options.task).slice(0, 48);
  const taskSegment = taskSlug.length > 0 ? taskSlug : "task";

  return `ae/run-${runIdSegment}-${taskSegment}`;
}
