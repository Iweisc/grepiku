import assert from "node:assert/strict";
import test from "node:test";

test("createReadonlySearchCollector enforces a global line cap across streamed ripgrep output", async () => {
  const { createReadonlySearchCollector } = await import(
    "../docker/codex-runner/tools/readonly_args.js"
  );

  assert.equal(typeof createReadonlySearchCollector, "function");

  const collector = createReadonlySearchCollector({ maxResults: 3 });

  const match = (path: string, line: number, text: string) =>
    JSON.stringify({
      type: "match",
      data: {
        path: { text: path },
        lines: { text: `${text}\n` },
        line_number: line
      }
    });

  assert.equal(
    collector.pushChunk(`${match("a.ts", 1, "needle")}\n${match("b.ts", 1, "needle")}\n`),
    false
  );
  assert.equal(
    collector.pushChunk(`${match("c.ts", 1, "needle")}\n${match("d.ts", 1, "needle")}\n`),
    true
  );
  assert.equal(collector.finish(), "a.ts:1:needle\nb.ts:1:needle\nc.ts:1:needle");
});
