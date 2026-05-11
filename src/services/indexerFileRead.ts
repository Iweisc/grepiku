import fs from "fs/promises";

export async function readIndexCandidateFile(
  filePath: string,
  maxBytes: number
): Promise<Buffer | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!Number.isFinite(stat.size) || stat.size > maxBytes) {
      return null;
    }
    const buffer = Buffer.alloc(Math.max(0, Number(stat.size)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
