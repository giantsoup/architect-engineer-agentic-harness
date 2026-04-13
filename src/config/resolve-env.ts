export interface EnvironmentResolutionIssue {
  path: string;
  variableName: string;
}

export interface EnvironmentResolutionResult<T> {
  value: T;
  issues: EnvironmentResolutionIssue[];
}

const ENV_REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function resolveEnvironmentReferences<T>(
  value: T,
): EnvironmentResolutionResult<T> {
  const issues: EnvironmentResolutionIssue[] = [];

  return {
    value: resolveValue(value, [], issues),
    issues,
  };
}

function resolveValue<T>(
  value: T,
  pathSegments: readonly string[],
  issues: EnvironmentResolutionIssue[],
): T {
  if (typeof value === "string") {
    return value.replace(ENV_REFERENCE_PATTERN, (match, variableName) => {
      const resolvedValue = process.env[variableName];

      if (resolvedValue === undefined) {
        issues.push({
          path: formatPath(pathSegments),
          variableName,
        });

        return match;
      }

      return resolvedValue;
    }) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      resolveValue(item, [...pathSegments, `[${index}]`], issues),
    ) as T;
  }

  if (isPlainObject(value)) {
    const resolvedEntries = Object.entries(value).map(([key, nestedValue]) => [
      key,
      resolveValue(nestedValue, [...pathSegments, key], issues),
    ]);

    return Object.fromEntries(resolvedEntries) as T;
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function formatPath(pathSegments: readonly string[]): string {
  if (pathSegments.length === 0) {
    return "config";
  }

  return pathSegments.reduce((formattedPath, segment) => {
    if (segment.startsWith("[")) {
      return `${formattedPath}${segment}`;
    }

    return formattedPath.length === 0 ? segment : `${formattedPath}.${segment}`;
  }, "");
}
