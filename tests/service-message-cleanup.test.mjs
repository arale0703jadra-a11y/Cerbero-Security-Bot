import assert from "node:assert/strict";
import test from "node:test";
import { isTelegramServiceMessage } from "../dist/service-message-cleanup.js";

test("recognizes Telegram join approval and service-notification fields", () => {
  for (const message of [
    { message_id: 1, new_chat_members: [{ id: 10, is_bot: false, first_name: "Member" }] },
    { message_id: 2, user_shared: { request_id: 1, user_id: 10 } },
    { message_id: 3, users_shared: { request_id: 1, users: [] } },
    { message_id: 4, left_chat_member: { id: 10, is_bot: false, first_name: "Member" } },
    { message_id: 5, connected_website: "example.org" },
  ]) {
    assert.equal(isTelegramServiceMessage(message), true);
  }
});

test("does not classify ordinary text or user media as a service message", () => {
  assert.equal(isTelegramServiceMessage({ message_id: 1, text: "hello" }), false);
  assert.equal(isTelegramServiceMessage({ message_id: 2, photo: [{ file_id: "id" }] }), false);
});
