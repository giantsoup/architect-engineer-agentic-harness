import type { ArchitectPlanOutput } from "../models/types.js";

export interface AcceptanceCriteriaPolicy {
  additionalGoals: string[];
  requiredTestCommand?: string | undefined;
  requirePassingChecks: boolean;
}

export function resolveAcceptanceCriteriaPolicy(options: {
  architectPlan?: Pick<ArchitectPlanOutput, "acceptanceCriteria"> | undefined;
  requiredTestCommand?: string | undefined;
  requirePassingChecks: boolean;
}): AcceptanceCriteriaPolicy {
  return {
    additionalGoals: [...(options.architectPlan?.acceptanceCriteria ?? [])],
    ...(options.requiredTestCommand === undefined
      ? {}
      : { requiredTestCommand: options.requiredTestCommand }),
    requirePassingChecks: options.requirePassingChecks,
  };
}

export function renderAcceptanceCriteriaLines(
  policy: AcceptanceCriteriaPolicy,
): string[] {
  const lines: string[] = [];

  if (policy.requirePassingChecks && policy.requiredTestCommand !== undefined) {
    lines.push(
      `- Mandatory test gate: \`${policy.requiredTestCommand}\` must pass before completion.`,
    );
  }

  if (policy.additionalGoals.length === 0) {
    lines.push("- Additional Architect goals: none");
    return lines;
  }

  lines.push(
    ...policy.additionalGoals.map(
      (criterion) => `- Additional Architect goal: ${criterion}`,
    ),
  );

  return lines;
}
