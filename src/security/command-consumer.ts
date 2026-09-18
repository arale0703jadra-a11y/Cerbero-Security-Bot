import type { Context } from "grammy";
import type { DatabaseClient } from "../database/client.js";
import {
  claimNextCommand,
  completeCommand,
  renewCommandLease,
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
    const leaseTimer = command.processing_token
      ? setInterval(() => {
          void renewCommandLease(
            this.db,
            command.id,
            this.instanceId,
            command.processing_token!,
          ).catch((error) => {
            console.error("[CERBERO] command lease renewal failed:", error);
          });
        }, 30_000)
      : undefined;
    try {
      await this.handleWithLease(command);
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
    }
  }

  private async handleWithLease(command: SecurityCommand): Promise<void> {
    const complete = (
      status: "completed" | "failed",
      errorMessage?: string,
    ): Promise<void> =>
      completeCommand(
        this.db,
        command.id,
        status,
        errorMessage,
        this.instanceId,
        command.processing_token ?? undefined,
      );
    const trace = {
      commandId: command.id,
      groupId: command.group_id,
      targetUserId: command.target_user_id ?? undefined,
      targetMessageId: command.target_message_id ?? undefined,
      processingInstanceId: this.instanceId,
    };
    if (!isSupportedAction(command.action)) {
      await complete("failed", "Unsupported action");
      await publishAudit(this.db, command.action, "unsupported", trace);
      return;
    }
    try {
      if (command.action === "UPDATE_SECURITY_CONFIG") {
        await updateSecurityConfig(this.db, command.group_id, command.payload);
        await complete("completed");
        await publishEvent(this.db, command.group_id, "security_config_updated", {
          commandId: command.id,
          processingInstanceId: this.instanceId,
          action: command.action,
          reason: getReason(command),
          result: "completed",
        });
        await publishAudit(this.db, command.action, "success", {
          ...trace,
          reason: getReason(command),
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
        await complete("completed");
        await publishEvent(this.db, command.group_id, "protected_user_updated", {
          commandId: command.id,
          processingInstanceId: this.instanceId,
          reason: getReason(command),
          action: command.payload.enabled === false ? "removed" : "added",
          result: "completed",
        }, userId);
        await publishAudit(this.db, command.action, "success", {
          ...trace,
          reason: getReason(command),
        });
        return;
      }
      if (
        command.target_user_id !== null &&
        ["WARN_USER", "MUTE_USER", "BAN_USER", "KICK_USER"].includes(command.action) &&
        await isProtectedUser(this.db, command.group_id, command.target_user_id)
      ) {
        throw new Error("PROTECTED_TARGET: Usuario incluido en la lista blanca.");
      }
      const execution = await executeCommand(this.db, this.ctx, command);
      await complete("completed", execution.error);
      await publishEvent(this.db, command.group_id, "moderation_executed", {
        commandId: command.id,
        action: command.action,
        actionPerformed: command.action,
        result: "completed",
        messageId: command.target_message_id ?? undefined,
        processingInstanceId: this.instanceId,
        reason: getReason(command),
        ...execution.details,
      }, command.target_user_id ?? undefined);
      await publishAudit(
        this.db,
        command.action,
        execution.error ? "partial" : "success",
        { ...trace, error: execution.error, reason: getReason(command) },
      );
    } catch (error) {
      const reason = classifyFailure(
        command,
        error instanceof Error ? error.message : String(error),
      );
      if (isAlreadyApplied(command, reason)) {
        await complete("completed");
        await publishEvent(this.db, command.group_id, "moderation_executed", {
          commandId: command.id,
          action: command.action,
          actionPerformed: command.action,
          result: "already_applied",
          reason,
          processingInstanceId: this.instanceId,
          idempotent: true,
        }, command.target_user_id ?? undefined);
        await publishAudit(this.db, command.action, "already_applied", {
          ...trace,
          reason: getReason(command),
        });
        return;
      }
      await complete("failed", reason);
      await publishEvent(this.db, command.group_id, "moderation_failed", {
        commandId: command.id,
        action: command.action,
        result: "failed",
        reasonCode: reason.split(":")[0],
        reason,
        messageId: command.target_message_id ?? undefined,
        actionError: reason,
        processingInstanceId: this.instanceId,
      }, command.target_user_id ?? undefined);
      await publishAudit(this.db, command.action, `failed: ${reason}`, {
        ...trace,
        error: reason,
        reason: getReason(command),
      });
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
    command.action === "UNBAN_USER" &&
    (normalized.includes("not a participant") ||
      normalized.includes("user not found") ||
      normalized.includes("participant_id_invalid"))
  ) {
    return `ALREADY_UNBANNED: ${reason}`;
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

function getReason(command: SecurityCommand): string | undefined {
  return typeof command.payload.reason === "string"
    ? command.payload.reason
    : undefined;
}

function isAlreadyApplied(command: SecurityCommand, reason: string): boolean {
  const normalized = reason.toLowerCase();
  if (command.action === "DELETE_MESSAGE") {
    return normalized.includes("message_already_deleted");
  }
  if (command.action === "UNBAN_USER" || command.action === "UNMUTE_USER") {
    return command.action === "UNBAN_USER" &&
      normalized.includes("already_unbanned");
  }
  return false;
}
