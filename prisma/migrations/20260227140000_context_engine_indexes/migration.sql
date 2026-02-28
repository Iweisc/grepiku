CREATE INDEX IF NOT EXISTS "GraphNode_repoId_type_key_idx"
ON "GraphNode"("repoId", "type", "key");

CREATE INDEX IF NOT EXISTS "GraphNode_repoId_fileId_type_idx"
ON "GraphNode"("repoId", "fileId", "type");

CREATE INDEX IF NOT EXISTS "GraphEdge_repoId_type_fromNodeId_idx"
ON "GraphEdge"("repoId", "type", "fromNodeId");

CREATE INDEX IF NOT EXISTS "GraphEdge_repoId_type_toNodeId_idx"
ON "GraphEdge"("repoId", "type", "toNodeId");

CREATE INDEX IF NOT EXISTS "Embedding_repoId_kind_id_idx"
ON "Embedding"("repoId", "kind", "id");
