export interface PlaceholderCommandOptions {
  commandName: string;
  followUp: string;
  milestone: string;
}

export function createPlaceholderAction(options: PlaceholderCommandOptions) {
  return (): void => {
    console.error(
      [
        `The \`${options.commandName}\` command is not implemented yet.`,
        `Planned milestone: ${options.milestone}.`,
        options.followUp,
      ].join("\n"),
    );

    process.exitCode = 1;
  };
}
