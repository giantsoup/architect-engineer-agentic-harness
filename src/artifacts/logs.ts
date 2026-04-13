import path from "node:path";
import { mkdir, open } from "node:fs/promises";

import { stringifyJson } from "./json.js";

export async function appendJsonLine(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const fileHandle = await open(filePath, "a+");

  try {
    const { size } = await fileHandle.stat();
    let prefix = "";

    if (size > 0) {
      const trailingByte = Buffer.alloc(1);

      await fileHandle.read(trailingByte, 0, 1, size - 1);

      if (trailingByte.toString("utf8") !== "\n") {
        prefix = "\n";
      }
    }

    const line = stringifyJson(value, 0).trimEnd();
    await fileHandle.write(`${prefix}${line}\n`);
  } finally {
    await fileHandle.close();
  }
}
