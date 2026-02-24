import crypto from "crypto";
import { ReviewComment } from "./schemas.js";

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function fingerprintForComment(comment: ReviewComment): string {
  return sha256(`${comment.comment_key}|${comment.path}`);
}

export function matchKeyForComment(comment: ReviewComment, hunkHash: string): string {
  return `${fingerprintForComment(comment)}|${comment.path}|${hunkHash}|${comment.title}`;
}
