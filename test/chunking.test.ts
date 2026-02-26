import test from "node:test";
import assert from "node:assert/strict";
import { chunkTextForEmbedding } from "../src/services/chunking.js";

test("chunkTextForEmbedding splits long content with overlap", () => {
  const lines = Array.from({ length: 120 }, (_, idx) => `line ${idx + 1} content`);
  const content = lines.join("\n");

  const chunks = chunkTextForEmbedding({
    content,
    maxChars: 240,
    overlapChars: 48,
    maxChunks: 20
  });

  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].startLine, 1);
  for (let i = 1; i < chunks.length; i += 1) {
    assert.ok(chunks[i].startLine <= chunks[i - 1].endLine);
    assert.ok(chunks[i].endLine >= chunks[i].startLine);
  }

  const last = chunks[chunks.length - 1];
  assert.equal(last.endLine, 120);
});

test("chunkTextForEmbedding returns one chunk for short content", () => {
  const content = "a\nb\nc";
  const chunks = chunkTextForEmbedding({ content, maxChars: 400, overlapChars: 40, maxChunks: 6 });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 3);
  assert.equal(chunks[0].text, content);
});
