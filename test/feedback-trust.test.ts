import test from "node:test";
import assert from "node:assert/strict";
import {
  feedbackAuthorAssociation,
  isTrustedFeedbackMetadata
} from "../src/services/feedbackTrust.js";

test("feedbackAuthorAssociation reads collaborator metadata from camelCase", () => {
  assert.equal(
    feedbackAuthorAssociation({ authorAssociation: "MEMBER" }),
    "MEMBER"
  );
});

test("feedbackAuthorAssociation reads collaborator metadata from snake_case", () => {
  assert.equal(
    feedbackAuthorAssociation({ author_association: "COLLABORATOR" }),
    "COLLABORATOR"
  );
});

test("isTrustedFeedbackMetadata only accepts trusted collaborator associations", () => {
  assert.equal(isTrustedFeedbackMetadata({ authorAssociation: "OWNER" }), true);
  assert.equal(isTrustedFeedbackMetadata({ authorAssociation: "CONTRIBUTOR" }), false);
  assert.equal(isTrustedFeedbackMetadata({ authorAssociation: null }), false);
  assert.equal(isTrustedFeedbackMetadata({}), false);
});
