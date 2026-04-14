import type {
  AdapterCommandDefaults,
  DetectedProjectAdapter,
  ProjectAdapter,
  ProjectInspectionContext,
} from "./types.js";

interface PackageJsonLike {
  dependencies?: Record<string, string> | undefined;
  devDependencies?: Record<string, string> | undefined;
  scripts?: Record<string, string> | undefined;
}

export const typescriptGenericAdapter: ProjectAdapter = {
  async detect(
    context: ProjectInspectionContext,
  ): Promise<DetectedProjectAdapter | undefined> {
    const packageJson = await context.readJson<PackageJsonLike>("package.json");

    if (packageJson === undefined) {
      return undefined;
    }

    const markers = await collectTypeScriptMarkers(context, packageJson);

    if (markers.length === 0) {
      return undefined;
    }

    return {
      id: "typescript-generic",
      label: "Generic TypeScript",
      markers: ["package.json", ...markers],
    };
  },
  id: "typescript-generic",
  label: "Generic TypeScript",
  async resolveCommandDefaults(
    context: ProjectInspectionContext,
  ): Promise<AdapterCommandDefaults> {
    const packageJson = await context.readJson<PackageJsonLike>("package.json");

    if (packageJson === undefined) {
      return {};
    }

    const packageManager = await detectNodePackageManager(context);

    return {
      install: renderNodeInstallCommand(packageManager),
      lint:
        resolveNodeScriptCommand(packageJson, "lint", packageManager) ??
        ((await hasEslintConfig(context))
          ? renderNodeExecCommand(packageManager, "eslint .")
          : undefined),
      test: resolveNodeScriptCommand(packageJson, "test", packageManager),
      typecheck:
        resolveNodeScriptCommand(packageJson, "typecheck", packageManager) ??
        ((await hasTypeScriptConfig(context))
          ? renderNodeExecCommand(packageManager, "tsc --noEmit")
          : undefined),
    };
  },
};

async function collectTypeScriptMarkers(
  context: ProjectInspectionContext,
  packageJson: PackageJsonLike,
): Promise<string[]> {
  const markers: string[] = [];

  if (await hasTypeScriptConfig(context)) {
    markers.push("tsconfig");
  }

  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };

  if (typeof dependencies.typescript === "string") {
    markers.push("dependency:typescript");
  }

  if (typeof packageJson.scripts?.typecheck === "string") {
    markers.push("script:typecheck");
  }

  return markers;
}

function resolveNodeScriptCommand(
  packageJson: PackageJsonLike,
  scriptName: string,
  packageManager: NodePackageManager,
): string | undefined {
  if (typeof packageJson.scripts?.[scriptName] !== "string") {
    return undefined;
  }

  switch (packageManager) {
    case "bun":
      return `bun run ${scriptName}`;
    case "npm":
      return `npm run ${scriptName}`;
    case "pnpm":
      return `pnpm run ${scriptName}`;
    case "yarn":
      return `yarn ${scriptName}`;
  }
}

type NodePackageManager = "bun" | "npm" | "pnpm" | "yarn";

async function detectNodePackageManager(
  context: ProjectInspectionContext,
): Promise<NodePackageManager> {
  if (
    (await context.fileExists("bun.lock")) ||
    (await context.fileExists("bun.lockb"))
  ) {
    return "bun";
  }

  if (await context.fileExists("pnpm-lock.yaml")) {
    return "pnpm";
  }

  if (await context.fileExists("yarn.lock")) {
    return "yarn";
  }

  return "npm";
}

function renderNodeInstallCommand(packageManager: NodePackageManager): string {
  switch (packageManager) {
    case "bun":
      return "bun install";
    case "npm":
      return "npm install";
    case "pnpm":
      return "pnpm install";
    case "yarn":
      return "yarn install";
  }
}

function renderNodeExecCommand(
  packageManager: NodePackageManager,
  command: string,
): string {
  switch (packageManager) {
    case "bun":
      return `bunx ${command}`;
    case "npm":
      return `npm exec ${command}`;
    case "pnpm":
      return `pnpm exec ${command}`;
    case "yarn":
      return `yarn exec ${command}`;
  }
}

async function hasTypeScriptConfig(
  context: ProjectInspectionContext,
): Promise<boolean> {
  const configFiles = [
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.base.json",
    "tsconfig.build.json",
  ];

  for (const relativePath of configFiles) {
    if (await context.fileExists(relativePath)) {
      return true;
    }
  }

  return false;
}

async function hasEslintConfig(
  context: ProjectInspectionContext,
): Promise<boolean> {
  const configFiles = [
    ".eslintrc",
    ".eslintrc.cjs",
    ".eslintrc.js",
    ".eslintrc.json",
    ".eslintrc.mjs",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.ts",
  ];

  for (const relativePath of configFiles) {
    if (await context.fileExists(relativePath)) {
      return true;
    }
  }

  return false;
}
