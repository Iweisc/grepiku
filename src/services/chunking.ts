export type TextChunk = {
  index: number;
  startLine: number;
  endLine: number;
  text: string;
};

export function chunkTextForEmbedding(params: {
  content: string;
  maxChars?: number;
  overlapChars?: number;
  maxChunks?: number;
}): TextChunk[] {
  const maxChars = Math.max(300, params.maxChars ?? 1800);
  const overlapChars = Math.max(0, Math.min(maxChars - 50, params.overlapChars ?? 220));
  const maxChunks = Math.max(1, params.maxChunks ?? 20);
  const normalized = params.content.replace(/\r\n/g, "\n");

  if (!normalized.trim()) {
    return [];
  }

  const lines = normalized.split("\n");
  if (normalized.length <= maxChars) {
    return [{ index: 0, startLine: 1, endLine: lines.length, text: normalized }];
  }

  const chunks: TextChunk[] = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const startLine = lineIndex + 1;
    const buffer: string[] = [];
    let length = 0;

    while (lineIndex < lines.length) {
      const line = lines[lineIndex];
      const lineLen = line.length + 1;
      if (buffer.length === 0 && lineLen > maxChars) {
        const segment = line.slice(0, maxChars);
        buffer.push(segment);
        const remainderStart = Math.max(1, maxChars - overlapChars);
        const remainder = line.slice(remainderStart);
        if (remainder.length > 0) {
          lines[lineIndex] = remainder;
        } else {
          lineIndex += 1;
        }
        break;
      }
      if (buffer.length > 0 && length + lineLen > maxChars) break;
      buffer.push(line);
      length += lineLen;
      lineIndex += 1;
    }

    if (buffer.length === 0) {
      const line = lines[lineIndex] || "";
      const segment = line.slice(0, maxChars);
      buffer.push(segment);
      const remainderStart = Math.max(1, maxChars - overlapChars);
      const remainder = line.slice(remainderStart);
      if (remainder.length > 0) {
        lines[lineIndex] = remainder;
      } else {
        lineIndex += 1;
      }
    }

    const endLine = startLine + buffer.length - 1;
    chunks.push({
      index: chunks.length,
      startLine,
      endLine,
      text: buffer.join("\n")
    });

    if (chunks.length >= maxChunks) {
      if (lineIndex < lines.length) {
        const remaining = lines.slice(lineIndex).join("\n");
        const last = chunks[chunks.length - 1];
        const merged = `${last.text}\n${remaining}`;
        last.text = merged.slice(0, maxChars * 2);
        last.endLine = lines.length;
      }
      break;
    }

    if (lineIndex >= lines.length || overlapChars <= 0 || buffer.length <= 1) continue;

    let overlapLength = 0;
    let overlapLines = 0;
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      overlapLength += buffer[i].length + 1;
      overlapLines += 1;
      if (overlapLength >= overlapChars) break;
    }
    const safeOverlap = Math.min(overlapLines, buffer.length - 1);
    lineIndex = Math.max(startLine - 1, lineIndex - safeOverlap);
  }

  return chunks;
}
