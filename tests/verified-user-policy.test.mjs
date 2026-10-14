import assert from "node:assert/strict";
import test from "node:test";
import {
  getVerifiedMessageRestriction,
  shouldSkipAutomaticDeletion,
  shouldSkipIllegalFilter,
  shouldSkipOrdinarySpamViolation,
} from "../dist/security/verified-user-policy.js";

test("posting and media flags independently gate verified messages", () => {
  assert.equal(
    getVerifiedMessageRestriction({ can_post: false, can_send_media: true }, false),
    "posting_disabled",
  );
  assert.equal(
    getVerifiedMessageRestriction({ can_post: true, can_send_media: false }, true),
    "media_disabled",
  );
  assert.equal(
    getVerifiedMessageRestriction({ can_post: true, can_send_media: false }, false),
    undefined,
  );
});

test("ordinary spam bypass leaves prohibited terms and repeat-offender controls active", () => {
  assert.equal(shouldSkipOrdinarySpamViolation(true, "spam_repeated"), true);
  assert.equal(shouldSkipOrdinarySpamViolation(true, "excessive_links"), true);
  assert.equal(shouldSkipOrdinarySpamViolation(true, "prohibited_word"), false);
  assert.equal(shouldSkipOrdinarySpamViolation(true, "repeat_offender"), false);
});

test("illegal-filter and automatic-deletion bypasses preserve critical actions", () => {
  assert.equal(shouldSkipIllegalFilter(true, false), true);
  assert.equal(shouldSkipIllegalFilter(true, true), false);
  assert.equal(shouldSkipAutomaticDeletion(true, false), true);
  assert.equal(shouldSkipAutomaticDeletion(true, true), false);
});
