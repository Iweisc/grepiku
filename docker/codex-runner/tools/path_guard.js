import fs from "fs/promises";
import path from "path";

function isWithinRoot(candidatePath, root) {
  const relative = path.relative(root, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveAllowedPath(inputPath, params) {
  const baseRoot = path.resolve(params.baseRoot);
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(baseRoot, inputPath);
  const roots = (params.roots || []).map((root) => path.resolve(root));
  const resolvedRealPath = await fs.realpath(resolved).catch(() => null);
  const canonicalPath = resolvedRealPath || resolved;
  const isAllowed = roots.some(
    (root) => isWithinRoot(resolved, root) && isWithinRoot(canonicalPath, root)
  );
  if (!isAllowed) {
    throw new Error("Path escapes allowed roots");
  }
  return canonicalPath;
}
