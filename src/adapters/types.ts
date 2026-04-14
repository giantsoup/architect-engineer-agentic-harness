export const PROJECT_COMMAND_NAMES = [
  "build",
  "format",
  "install",
  "lint",
  "test",
  "typecheck",
] as const;

export type ProjectCommandName = (typeof PROJECT_COMMAND_NAMES)[number];

export type ProjectAdapterId =
  | "laravel-generic"
  | "typescript-generic"
  | "unknown";

export type ProjectCommandSource =
  | "adapter"
  | "config"
  | "config-legacy-setup"
  | "unresolved";

export interface ProjectCommandResolution {
  command?: string | undefined;
  source: ProjectCommandSource;
}

export type ResolvedProjectCommands = Record<
  ProjectCommandName,
  ProjectCommandResolution
>;

export interface DetectedProjectAdapter {
  id: ProjectAdapterId;
  label: string;
  markers: string[];
}

export interface ResolvedProjectContext {
  adapter: DetectedProjectAdapter;
  commands: ResolvedProjectCommands;
}

export interface AdapterCommandDefaults {
  install?: string | undefined;
  lint?: string | undefined;
  test?: string | undefined;
  typecheck?: string | undefined;
}

export interface ProjectInspectionContext {
  projectRoot: string;
  fileExists(relativePath: string): Promise<boolean>;
  readJson<TValue>(relativePath: string): Promise<TValue | undefined>;
}

export interface ProjectAdapter {
  detect(
    context: ProjectInspectionContext,
  ): Promise<DetectedProjectAdapter | undefined>;
  id: ProjectAdapterId;
  label: string;
  resolveCommandDefaults(
    context: ProjectInspectionContext,
  ): Promise<AdapterCommandDefaults>;
}
