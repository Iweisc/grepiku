import fs from "fs/promises";
import { jsonrepair } from "jsonrepair";
import { ZodSchema } from "zod";

export function parseAndValidateJson<T>(raw: string, schema: ZodSchema<T>): T {
  try {
    const parsed = JSON.parse(raw);
    return schema.parse(parsed);
  } catch {
    const repaired = jsonrepair(raw);
    const parsed = JSON.parse(repaired);
    return schema.parse(parsed);
  }
}

export async function readAndValidateJson<T>(
  filePath: string,
  schema: ZodSchema<T>
): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return parseAndValidateJson(raw, schema);
}
