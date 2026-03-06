import fs from "fs/promises";
import { jsonrepair } from "jsonrepair";
import { ZodSchema } from "zod";

function trySchema<T>(
  value: unknown,
  schema: ZodSchema<T>
): { data: T | null; error: unknown } {
  const direct = schema.safeParse(value);
  if (direct.success) {
    return { data: direct.data, error: null };
  }

  const queue: unknown[] = [];
  if (Array.isArray(value)) {
    queue.push(...value);
  } else if (value && typeof value === "object") {
    queue.push(...Object.values(value as Record<string, unknown>));
  }

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const parsed = schema.safeParse(current);
    if (parsed.success) {
      return { data: parsed.data, error: null };
    }
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (current && typeof current === "object") {
      queue.push(...Object.values(current as Record<string, unknown>));
    }
  }

  return { data: null, error: direct.error };
}

function readBalancedJsonBlock(raw: string, start: number): { text: string; end: number } | null {
  const opening = raw[start];
  if (opening !== "{" && opening !== "[") {
    return null;
  }

  const stack = [opening === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }
    if (char !== "}" && char !== "]") {
      continue;
    }
    if (stack[stack.length - 1] !== char) {
      return null;
    }
    stack.pop();
    if (stack.length === 0) {
      return { text: raw.slice(start, index + 1), end: index };
    }
  }

  return null;
}

function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  pushCandidate(raw);

  const fencedBlockPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of raw.matchAll(fencedBlockPattern)) {
    pushCandidate(match[1]);
  }

  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char !== "{" && char !== "[") {
      continue;
    }

    const block = readBalancedJsonBlock(raw, index);
    if (!block) {
      continue;
    }
    pushCandidate(block.text);
    index = block.end;
  }

  return candidates;
}

function parseCandidate(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    const repaired = jsonrepair(candidate);
    return JSON.parse(repaired);
  }
}

export function parseAndValidateJson<T>(raw: string, schema: ZodSchema<T>): T {
  let lastError: unknown;
  for (const candidate of extractJsonCandidates(raw)) {
    try {
      const parsed = parseCandidate(candidate);
      const validated = trySchema(parsed, schema);
      if (validated.data !== null) {
        return validated.data;
      }
      lastError = validated.error;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to parse review JSON output");
}

export async function readAndValidateJson<T>(
  filePath: string,
  schema: ZodSchema<T>
): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return parseAndValidateJson(raw, schema);
}

export async function readAndValidateJsonWithFallback<T>(
  filePath: string,
  fallbackPath: string,
  schema: ZodSchema<T>
): Promise<T> {
  let primaryError: unknown;
  try {
    return await readAndValidateJson(filePath, schema);
  } catch (err) {
    primaryError = err;
  }

  try {
    const raw = await fs.readFile(fallbackPath, "utf8");
    return parseAndValidateJson(raw, schema);
  } catch (fallbackError) {
    if ((fallbackError as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw primaryError;
    }
    throw new AggregateError(
      [primaryError, fallbackError],
      `Unable to read valid JSON from ${filePath} or fallback ${fallbackPath}`
    );
  }
}
