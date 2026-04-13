import { createProgram } from "./program.js";

async function main(): Promise<void> {
  const program = createProgram();

  if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    process.stdout.write("\n");
    return;
  }

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
