import type {
  AdapterCommandDefaults,
  DetectedProjectAdapter,
  ProjectAdapter,
  ProjectInspectionContext,
} from "./types.js";
import { typescriptGenericAdapter } from "./typescript-generic.js";

interface ComposerJsonLike {
  require?: Record<string, string> | undefined;
  "require-dev"?: Record<string, string> | undefined;
  scripts?: Record<string, string | string[]> | undefined;
}

export const laravelGenericAdapter: ProjectAdapter = {
  async detect(
    context: ProjectInspectionContext,
  ): Promise<DetectedProjectAdapter | undefined> {
    const composerJson =
      await context.readJson<ComposerJsonLike>("composer.json");

    if (composerJson === undefined) {
      return undefined;
    }

    const markers = await collectLaravelMarkers(context, composerJson);

    if (markers.length === 0) {
      return undefined;
    }

    return {
      id: "laravel-generic",
      label: "Generic Laravel",
      markers,
    };
  },
  id: "laravel-generic",
  label: "Generic Laravel",
  async resolveCommandDefaults(
    context: ProjectInspectionContext,
  ): Promise<AdapterCommandDefaults> {
    const composerJson =
      await context.readJson<ComposerJsonLike>("composer.json");

    if (composerJson === undefined) {
      return {};
    }

    const nodeDefaults =
      await typescriptGenericAdapter.resolveCommandDefaults(context);
    const installCommand =
      nodeDefaults.install === undefined
        ? "composer install"
        : `composer install && ${nodeDefaults.install}`;

    return {
      install: installCommand,
      lint:
        resolveComposerScriptCommand(composerJson, "lint") ??
        resolveComposerLintCommand(composerJson),
      test:
        resolveComposerScriptCommand(composerJson, "test") ??
        ((await context.fileExists("artisan"))
          ? "php artisan test"
          : undefined),
      typecheck:
        resolveComposerScriptCommand(composerJson, "typecheck") ??
        nodeDefaults.typecheck,
    };
  },
};

async function collectLaravelMarkers(
  context: ProjectInspectionContext,
  composerJson: ComposerJsonLike,
): Promise<string[]> {
  const markers: string[] = [];
  const requiredPackages = {
    ...(composerJson.require ?? {}),
    ...(composerJson["require-dev"] ?? {}),
  };

  if (typeof requiredPackages["laravel/framework"] === "string") {
    markers.push("composer:laravel/framework");
  }

  if (typeof requiredPackages["laravel/laravel"] === "string") {
    markers.push("composer:laravel/laravel");
  }

  if (await context.fileExists("artisan")) {
    markers.push("artisan");
  }

  return markers;
}

function resolveComposerScriptCommand(
  composerJson: ComposerJsonLike,
  scriptName: string,
): string | undefined {
  const script = composerJson.scripts?.[scriptName];

  return script === undefined ? undefined : `composer run-script ${scriptName}`;
}

function resolveComposerLintCommand(
  composerJson: ComposerJsonLike,
): string | undefined {
  const requiredPackages = {
    ...(composerJson.require ?? {}),
    ...(composerJson["require-dev"] ?? {}),
  };

  if (typeof requiredPackages["laravel/pint"] === "string") {
    return "./vendor/bin/pint --test";
  }

  return undefined;
}
