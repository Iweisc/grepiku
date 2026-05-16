import assert from "node:assert/strict";
import test from "node:test";
import type { RepoConfig } from "../src/review/config.js";
import type { ContextPack } from "../src/review/context.js";
import type { ReviewDiffChunk } from "../src/review/diffChunks.js";
import {
  buildChunkContextConfig,
  chunkHasHighImpactHotspot,
  scopeContextPackToChunk
} from "../src/review/chunkContext.js";

const config = {
  retrieval: {
    topK: 28,
    maxPerPath: 6,
    semanticWeight: 0.62,
    lexicalWeight: 0.22,
    rrfWeight: 0.08,
    changedPathBoost: 0.16,
    sameDirectoryBoost: 0.08,
    patternBoost: 0.03,
    symbolBoost: 0.02,
    chunkBoost: 0.03
  },
  graph: {
    exclude_dirs: [],
    traversal: {
      max_depth: 5,
      min_score: 0.07,
      max_related_files: 28,
      max_graph_links: 110,
      hard_include_files: 8,
      max_nodes_visited: 2600
    }
  }
} as RepoConfig;

const chunk: ReviewDiffChunk = {
  id: "chunk-03",
  ordinal: 2,
  paths: [
    "apps/be-ai-assistant/src/chat/services/conversation_service.go",
    "apps/be-ai-assistant/src/chat/controllers/stream_controller.go"
  ],
  diffPatch: "",
  changedFiles: [
    {
      path: "apps/be-ai-assistant/src/chat/services/conversation_service.go",
      additions: 120,
      deletions: 20
    },
    {
      path: "apps/be-ai-assistant/src/chat/controllers/stream_controller.go",
      additions: 40,
      deletions: 10
    }
  ],
  changedLines: 190,
  additions: 160,
  deletions: 30,
  risk: "medium"
};

const contextPack: ContextPack = {
  query: "whole PR query\n".repeat(100),
  retrieved: [
    {
      kind: "chunk",
      score: 0.8,
      path: "apps/be-ai-assistant/src/chat/services/conversation_repository.go",
      text: "conversation repository context"
    },
    {
      kind: "chunk",
      score: 0.7,
      path: "apps/user-dashboard/src/app/page.tsx",
      text: "dashboard context"
    },
    {
      kind: "chunk",
      score: 0.6,
      path: "apps/be-ai-assistant/src/agent/tools/tool.go",
      text: "assistant module context"
    }
  ],
  relatedFiles: [
    "apps/be-ai-assistant/src/chat/services/conversation_repository.go",
    "apps/user-dashboard/src/app/page.tsx"
  ],
  changedFileStats: [
    {
      path: "apps/be-ai-assistant/src/chat/services/conversation_service.go",
      additions: 120,
      deletions: 20,
      risk: "medium"
    },
    {
      path: "apps/user-dashboard/src/app/page.tsx",
      additions: 200,
      deletions: 0,
      risk: "high"
    }
  ],
  graphLinks: [
    {
      from: "apps/be-ai-assistant/src/chat/services/conversation_service.go",
      to: "apps/be-ai-assistant/src/chat/services/conversation_repository.go",
      type: "file_dep"
    },
    {
      from: "apps/user-dashboard/src/app/page.tsx",
      to: "apps/user-dashboard/src/lib/api.ts",
      type: "file_dep"
    }
  ],
  graphPaths: [
    {
      path: "apps/be-ai-assistant/src/chat/services/conversation_repository.go",
      score: 0.9,
      via: [
        "apps/be-ai-assistant/src/chat/services/conversation_service.go --file_dep--> apps/be-ai-assistant/src/chat/services/conversation_repository.go"
      ]
    },
    {
      path: "apps/user-dashboard/src/lib/api.ts",
      score: 0.8,
      via: ["apps/user-dashboard/src/app/page.tsx --file_dep--> apps/user-dashboard/src/lib/api.ts"]
    }
  ],
  graphDebug: {
    seedNodes: 10,
    touchedSymbolSeeds: 4,
    visitedNodes: 30,
    traversedEdges: 60,
    prunedByBudget: 0,
    maxDepth: 5,
    minScore: 0.07,
    maxNodesVisited: 2600,
    traversalMs: 12
  },
  hotspots: [
    {
      path: "apps/be-ai-assistant/src/chat/services/conversation_service.go",
      openFindings: 1,
      historicalFindings: 3,
      topCategories: ["bug"]
    },
    {
      path: "apps/user-dashboard/src/app/page.tsx",
      openFindings: 1,
      historicalFindings: 2,
      topCategories: ["style"]
    }
  ],
  reviewFocus: ["global focus"]
};

test("buildChunkContextConfig caps retrieval and graph budgets for chunk reviewers", () => {
  const scoped = buildChunkContextConfig(config);

  assert.equal(scoped.retrieval.topK, 16);
  assert.equal(scoped.retrieval.maxPerPath, 3);
  assert.equal(scoped.graph.traversal.max_depth, 4);
  assert.equal(scoped.graph.traversal.max_related_files, 16);
  assert.equal(scoped.graph.traversal.max_graph_links, 48);
  assert.equal(scoped.graph.traversal.max_nodes_visited, 1400);
});

test("scopeContextPackToChunk drops unrelated whole-PR context", () => {
  const scoped = scopeContextPackToChunk(contextPack, chunk);

  assert.match(scoped.query, /Chunk chunk-03 changed lines/);
  assert.doesNotMatch(scoped.query, /whole PR query/);
  assert.deepEqual(scoped.changedFileStats.map((item) => item.path), [
    "apps/be-ai-assistant/src/chat/services/conversation_service.go"
  ]);
  assert.deepEqual(scoped.relatedFiles, [
    "apps/be-ai-assistant/src/chat/services/conversation_repository.go"
  ]);
  assert.deepEqual(scoped.retrieved.map((item) => item.path), [
    "apps/be-ai-assistant/src/chat/services/conversation_repository.go",
    "apps/be-ai-assistant/src/agent/tools/tool.go"
  ]);
  assert.equal(scoped.graphLinks.length, 1);
  assert.match(scoped.reviewFocus[0], /Review chunk-03 only/);
});

test("chunkHasHighImpactHotspot detects bug and security history on changed files", () => {
  assert.equal(chunkHasHighImpactHotspot(contextPack, chunk), true);

  const noHotspot = {
    ...contextPack,
    hotspots: [
      {
        path: "apps/be-ai-assistant/src/chat/services/conversation_service.go",
        openFindings: 1,
        historicalFindings: 2,
        topCategories: ["style"]
      }
    ]
  };
  assert.equal(chunkHasHighImpactHotspot(noHotspot, chunk), false);
});
