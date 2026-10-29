import assert from "node:assert/strict";
import test from "node:test";
import { executeCommand } from "../dist/moderation/executor.js";

const BOT_ID = 900000101;
const USER_ID = 900000102;
const GROUP_ID = -1001;

function createCtx({ botCanRestrict = true, targetMember, deleteFailsFor, deleteErrorMessage } = {}) {
  const restrictCalls = [];
  const banCalls = [];
  const unbanCalls = [];
  const deleteCalls = [];
  const api = {
    getChatMember: async (_chatId, userId) =>
      userId === BOT_ID
        ? {
            status: "administrator",
            user: { id: BOT_ID, is_bot: true, first_name: "Cerbero" },
            can_restrict_members: botCanRestrict,
            can_delete_messages: true,
          }
        : targetMember ?? {
            status: "member",
            user: { id: userId, is_bot: false, first_name: "Miembro" },
          },
    restrictChatMember: async (chatId, userId, permissions, options) => {
      restrictCalls.push({ chatId, userId, permissions, options });
      return true;
    },
    banChatMember: async (chatId, userId) => {
      banCalls.push({ chatId, userId });
      return true;
    },
    unbanChatMember: async (chatId, userId, options) => {
      unbanCalls.push({ chatId, userId, options });
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      if (deleteFailsFor?.includes(messageId)) {
        throw new Error(deleteErrorMessage ?? "message to delete not found");
      }
      deleteCalls.push({ chatId, messageId });
      return true;
    },
  };
  return {
    ctx: { me: { id: BOT_ID }, api },
    restrictCalls,
    banCalls,
    unbanCalls,
    deleteCalls,
  };
}

function command(action, overrides = {}) {
  return {
    id: "cmd-1",
    group_id: GROUP_ID,
    action,
    target_user_id: USER_ID,
    target_message_id: null,
    payload: {},
    ...overrides,
  };
}

const db = {};

test("UNMUTE_USER retira solo el permiso de silencio sin ampliar otros permisos", async () => {
  const { ctx, restrictCalls } = createCtx();
  await executeCommand(db, ctx, command("UNMUTE_USER"));

  assert.equal(restrictCalls.length, 1);
  assert.deepEqual(restrictCalls[0].permissions, {
    can_send_messages: true,
  });
  assert.equal(restrictCalls[0].options, undefined);
  for (const key of [
    "can_send_audios",
    "can_send_documents",
    "can_send_photos",
    "can_send_videos",
    "can_send_other_messages",
    "can_change_info",
    "can_invite_users",
    "can_edit_tag",
    "can_pin_messages",
    "can_manage_topics",
    "can_add_web_page_previews",
    "can_react_to_messages",
  ]) {
    assert.ok(
      !(key in restrictCalls[0].permissions),
      `el unmute remoto no debe conceder ${key}`,
    );
  }
});

test("UNMUTE_USER sin usuario objetivo se rechaza con USER_NOT_FOUND", async () => {
  const { ctx } = createCtx();
  await assert.rejects(
    executeCommand(db, ctx, command("UNMUTE_USER", { target_user_id: null })),
    /USER_NOT_FOUND/,
  );
});

test("UNMUTE_USER propaga errores de la API de Telegram", async () => {
  const { ctx, restrictCalls } = createCtx();
  ctx.api.restrictChatMember = async () => {
    throw new Error("403: Forbidden: user is an administrator");
  };
  await assert.rejects(executeCommand(db, ctx, command("UNMUTE_USER")), /403/);
  assert.equal(restrictCalls.length, 0);
});

test("MUTE_USER convierte duration_minutes en until_date y silencia al usuario", async () => {
  const before = Math.floor(Date.now() / 1000);
  const { ctx, restrictCalls } = createCtx();
  await executeCommand(
    db,
    ctx,
    command("MUTE_USER", { payload: { duration_minutes: 30 } }),
  );
  const after = Math.floor(Date.now() / 1000);

  assert.equal(restrictCalls.length, 1);
  assert.equal(restrictCalls[0].permissions.can_send_messages, false);
  const until = restrictCalls[0].options?.until_date;
  assert.equal(typeof until, "number");
  assert.ok(until >= before + 30 * 60 - 5 && until <= after + 30 * 60 + 5);
});

test("MUTE_USER sobre administrador se rechaza con PROTECTED_TARGET", async () => {
  const { ctx, restrictCalls } = createCtx({
    targetMember: {
      status: "administrator",
      user: { id: USER_ID, is_bot: false, first_name: "Admin" },
    },
  });
  await assert.rejects(
    executeCommand(db, ctx, command("MUTE_USER")),
    /PROTECTED_TARGET/,
  );
  assert.equal(restrictCalls.length, 0);
});

test("sin permiso de restricción la orden se rechaza con INSUFFICIENT_PERMISSIONS", async () => {
  const { ctx, restrictCalls } = createCtx({ botCanRestrict: false });
  await assert.rejects(
    executeCommand(db, ctx, command("UNMUTE_USER")),
    /INSUFFICIENT_PERMISSIONS/,
  );
  assert.equal(restrictCalls.length, 0);
});

test("UNBAN_USER desbanea solo si el usuario está baneado", async () => {
  const { ctx, unbanCalls } = createCtx();
  await executeCommand(db, ctx, command("UNBAN_USER"));
  assert.deepEqual(unbanCalls, [
    { chatId: GROUP_ID, userId: USER_ID, options: { only_if_banned: true } },
  ]);
});

test("KICK_USER banea y desbanea; un fallo del ban se reporta sin intentar el desbane", async () => {
  const { ctx, banCalls, unbanCalls } = createCtx();
  await executeCommand(db, ctx, command("KICK_USER"));
  assert.equal(banCalls.length, 1);
  assert.equal(unbanCalls.length, 1);

  const failing = createCtx();
  failing.ctx.api.banChatMember = async () => {
    throw new Error("400: Bad Request: user not found");
  };
  await assert.rejects(
    executeCommand(db, failing.ctx, command("KICK_USER")),
    /KICK_BAN_FAILED/,
  );
  assert.equal(failing.unbanCalls.length, 0);
});

test("CLEAN_MESSAGES clasifica como ya aplicado los mensajes borrados antes sin repetir la limpieza", async () => {
  const { ctx, deleteCalls } = createCtx({ deleteFailsFor: [202] });
  const result = await executeCommand(
    db,
    ctx,
    command("CLEAN_MESSAGES", {
      target_user_id: null,
      payload: { message_ids: [201, 202] },
    }),
  );

  assert.deepEqual(result.details, {
    attempted: 2,
    deleted: 2,
    failed: 0,
    alreadyApplied: 1,
    partialErrors: undefined,
  });
  assert.equal(result.error, undefined);
  assert.equal(deleteCalls.length, 1);
});

test("CLEAN_MESSAGES informa de fallos parciales no recuperables sin repetir la limpieza", async () => {
  const { ctx, deleteCalls } = createCtx({
    deleteFailsFor: [202],
    deleteErrorMessage: "403: Forbidden: can't delete messages",
  });
  const result = await executeCommand(
    db,
    ctx,
    command("CLEAN_MESSAGES", {
      target_user_id: null,
      payload: { message_ids: [201, 202] },
    }),
  );

  assert.deepEqual(result.details, {
    attempted: 2,
    deleted: 1,
    failed: 1,
    alreadyApplied: 0,
    partialErrors: ["403: Forbidden: can't delete messages"],
  });
  assert.match(result.error ?? "", /CLEAN_MESSAGES_PARTIAL/);
  assert.equal(deleteCalls.length, 1);

  const allFail = createCtx({
    deleteFailsFor: [201, 202],
    deleteErrorMessage: "403: Forbidden: can't delete messages",
  });
  await assert.rejects(
    executeCommand(
      db,
      allFail.ctx,
      command("CLEAN_MESSAGES", {
        target_user_id: null,
        payload: { message_ids: [201, 202] },
      }),
    ),
    /CLEAN_MESSAGES_FAILED/,
  );
});

test("DELETE_MESSAGE sin mensaje objetivo se rechaza con MESSAGE_NOT_FOUND", async () => {
  const { ctx } = createCtx();
  await assert.rejects(
    executeCommand(
      db,
      ctx,
      command("DELETE_MESSAGE", { target_user_id: null }),
    ),
    /MESSAGE_NOT_FOUND/,
  );
});