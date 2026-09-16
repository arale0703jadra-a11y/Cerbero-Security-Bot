import type { Context } from "grammy";
import type { DatabaseClient } from "../database/client.js";
import {
  claimNextCommand,
  completeCommand,
} from "../database/repositories/commands-repository.js";
import { publishAudit, publishEvent } from "../events/publisher.js";
import { executeCommand } from "../moderation/executor.js";
import { isSupportedAction } from "./permissions.js";
import type { SecurityCommand } from "../database/types.js";
import { updateSecurityConfig } from "../database/repositories/security-config-repository.js";
import {
  isProtectedUser,
  protectUser,
  unprotectUser,
} from "../database/repositories/security-config-repository.js";

export class CommandConsumer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(
    private readonly db: DatabaseClient,
    private readonly ctx: Context,
    private readonly instanceId: string,
    private readonly pollMs = 2_000,
  ) {}

  start(): void {
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      const command = await claimNextCommand(this.db, this.instanceId);
      if (command) await this.handle(command);
    } catch (error) {
      console.error("[CERBERO] command polling failed:", error);
    } finally {
      if (this.running) this.timer = setTimeout(() => void this.poll(), this.pollMs);
    }
  }

  private async handle(command: SecurityCommand): Promise<void> {
    if (!isSupportedAction(command.action)) {
      await completeCommand(this.db, command.id, "failed", "Unsupported action");
      await publishAudit(this.db, command.action, "unsupported");
      return;
    }
    try {
      if (command.action === "UPDATE_SECURITY_CONFIG") {
        await updateSecurityConfig(this.db, command.group_id, command.payload);
        await completeCommand(this.db, command.id, "completed");
        await publishEvent(this.db, command.group_id, "security_config_updated", {
          commandId: command.id,
          result: "completed",
        });
        return;
      }
      if (command.action === "UPDATE_PROTECTED_USER") {
        const userId = command.target_user_id;
        if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario.");
        if (command.payload.enabled === false) {
          await unprotectUser(this.db, command.group_id, userId);
        } else {
          await protectUser(
            this.db,
            command.group_id,
            userId,
            typeof command.payload.protectionType === "string" ? command.payload.protectionType : "vip",
            typeof command.payload.username === "string" ? command.payload.username : undefined,
          );
        }
        await completeCommand(this.db, command.id, "completed");
        await publishEvent(this.db, command.group_id, "protected_user_updated", {
          action: command.payload.enabled === false ? "removed" : "added",
          result: "completed",
        }, userId);
        return;
      }
      if (
        command.target_user_id !== null &&
        ["MUTE_USER", "BAN_USER", "KICK_USER"].includes(command.action) &&
        await isProtectedUser(this.db, command.group_id, command.target_user_id)
      ) {
        throw new Error("PROTECTED_TARGET: Usuario incluido en la lista blanca.");
      }
      await executeCommand(this.ctx, command);
      await completeCommand(this.db, command.id, "completed");
      await publishEvent(this.db, command.group_id, "moderation_executed", {
        commandId: command.id,
        action: command.action,
        actionPerformed: command.action,
        result: "completed",
        messageId: command.target_message_id ?? undefined,
      }, command.target_user_id ?? undefined);
      await publishAudit(this.db, command.action, "success");
    } catch (error) {
      const reason = classifyFailure(
        command,
        error instanceof Error ? error.message : String(error),
      );
      await completeCommand(this.db, command.id, "failed", reason);
      await publishEvent(this.db, command.group_id, "moderation_failed", {
        commandId: command.id,
        action: command.action,
        result: "failed",
        reasonCode: reason.split(":")[0],
        reason,
        messageId: command.target_message_id ?? undefined,
        actionError: reason,
      }, command.target_user_id ?? undefined);
      await publishAudit(this.db, command.action, `failed: ${reason}`);
    }
  }

}

function classifyFailure(command: SecurityCommand, reason: string): string {
  const normalized = reason.toLowerCase();
  if (normalized.includes("protected_target")) {
    return `PROTECTED_TARGET: ${reason}`;
  }
  if (normalized.includes("not enough rights") || normalized.includes("forbidden")) {
    return `INSUFFICIENT_PERMISSIONS: ${reason}`;
  }
  if (
    command.action !== "DELETE_MESSAGE" &&
    (normalized.includes("user not found") ||
      normalized.includes("user_id_invalid") ||
      normalized.includes("participant_id_invalid"))
  ) {
    return `USER_NOT_FOUND: ${reason}`;
  }
  if (
    command.action === "DELETE_MESSAGE" &&
    (normalized.includes("message to delete not found") ||
      normalized.includes("message_id_invalid") ||
      normalized.includes("message can't be deleted"))
  ) {
    return `MESSAGE_ALREADY_DELETED: ${reason}`;
  }
  return reason;
}
