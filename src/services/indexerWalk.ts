import fs from "fs/promises";
import path from "path";

export async function* walkIndexableFiles(
  rootDir: string,
  ignoreDirs: Set<string>
): AsyncGenerator<string> {
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));

    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const entry = sorted[index];
      if (!entry?.isDirectory() || ignoreDirs.has(entry.name)) {
        continue;
      }
      stack.push(path.join(currentDir, entry.name));
    }

    for (const entry of sorted) {
      if (!entry?.isFile()) continue;
      yield path.join(currentDir, entry.name);
    }
  }
}
