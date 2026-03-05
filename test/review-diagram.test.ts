import test from "node:test";
import assert from "node:assert/strict";
import { generateMermaidDiagram } from "../src/review/diagram.js";

test("generateMermaidDiagram returns empty when no changed files", () => {
  const diagram = generateMermaidDiagram({
    changedFiles: [],
    relatedFiles: ["src/app.ts"],
    graphLinks: [{ from: "src/a.ts", to: "src/b.ts", type: "file_dep" }]
  });

  assert.equal(diagram, "");
});

test("generateMermaidDiagram keeps graph compact and readable", () => {
  const changedFiles = Array.from({ length: 12 }, (_, index) => ({
    path: `internal/features/review/pipeline/changed/file_${index}.ts`
  }));
  const relatedFiles = Array.from(
    { length: 24 },
    (_, index) => `internal/dependencies/subsystem/graph/related/file_${index}.ts`
  );
  const graphLinks = relatedFiles.map((toPath, index) => ({
    from: changedFiles[index % changedFiles.length].path!,
    to: toPath,
    type: "file_dep"
  }));

  const diagram = generateMermaidDiagram({
    changedFiles,
    relatedFiles,
    graphLinks
  });

  assert.ok(diagram.startsWith("flowchart LR\n"));
  const nodeLines = diagram.split("\n").filter((line) => /^p_[a-zA-Z0-9_]+\["/.test(line));
  const edgeLines = diagram.split("\n").filter((line) => /-->/.test(line));

  assert.ok(nodeLines.length <= 18);
  assert.ok(edgeLines.length <= 24);
  assert.ok(diagram.includes('[".../pipeline/changed/file_0.ts"]'));
  assert.equal(diagram.includes("internal/features/review/pipeline/changed/file_0.ts"), false);
});
