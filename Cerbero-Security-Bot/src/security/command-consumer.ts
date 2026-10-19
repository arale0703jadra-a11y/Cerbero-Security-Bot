import type { Context } from "grammy";
import type { DatabaseClient } from "../database/client.js";
import {
  claimNextCommand,
  completeCommand,
  markCommandUnknown,
  renewCommandLease,
} from "../database/repositories/commands-repository.js";
import { publishAudit, publishEvent } from "../events/publisher.js";
import { executeCommand } from "../moderation/executor.js";
import type { CommandExecutionResult } from "../moderation/executor.js";
import { isSupportedAction } from "./permissions.js";
import type { SecurityCommand } from "../database/types.js";
import { updateSecurityConfig } from "../database/repositories/security-config-repository.js";
import {
  isProtectedUser,
  protectUser,
  unprotectUser,
} from "../database/repositories/security-config-repository.js";

type LeaseWorkResult<T> =
  | { started: false; leaseHeld: boolean }
  | { started: true; value: T; leaseHeld: boolean };

export interface CommandConsumerDependencies {
  claimNextCommand: typeof claimNextCommand;
  completeCommand: typeof completeCommand;
  markCommandUnknown: typeof markCommandUnknown;
  renewCommandLease: typeof renewCommandLease;
  publishAudit: typeof publishAudit;
  publishEvent: typeof publishEvent;
  executeCommand: typeof executeCommand;
  isSupportedAction: typeof isSupportedAction;
  updateSecurityConfig: typeof updateSecurityConfig;
  isProtectedUser: typeof isProtectedUser;
  protectUser: typeof protectUser;
  unprotectUser: typeof unprotectUser;
  scheduleLeaseRenewal: (callback: () => void) => () => void;
  logError: (message: string, error?: unknown) => void;
}

const defaultDependencies: CommandConsumerDependencies = {
  claimNextCommand,
  completeCommand,
  markCommandUnknown,
  renewCommandLease,
  publishAudit,
  publishEvent,
  executeCommand,
  isSupportedAction,
  updateSecurityConfig,
  isProtectedUser,
  protectUser,
  unprotectUser,
  scheduleLeaseRenewal: (callback) => {
    const timer = setInterval(callback, 30_000);
    return () => clearInterval(timer);
  },
  logError: (message, error) => {
    if (error === undefined) console.error(message);
    else console.error(message, error);
  },
};

export class CommandLeaseMonitor {
  private cancelSchedule: (() => void) | undefined;
  private renewalInFlight = false;
  private stopped = false;
  private lost = false;

  // Renewal runs every 30 seconds, so local loss detection can lag server-side expiry by one interval.
  // canStartWork/runIfHeld are local guards, not mutual exclusion; an external call already started cannot be cancelled.
  // Renewal's database UPDATE checks owner/token, processing/result state, and an unexpired lease; completion and
  // unknown writes are fenced too. The current claim function selects pending rows only; reclaiming expired
  // processing rows later requires server-side concurrency control and fencing against stale workers.
  constructor(
    private readonly commandId: string,
    private readonly renewLease: () => Promise<boolean>,
    private readonly schedule: (callback: () => void) => () => void =
      defaultDependencies.scheduleLeaseRenewal,
    private readonly reportLeaseLoss: (message: string) => void = (message) => {
      console.error(message);
    },
  ) {}

  start(): void {
    if (this.cancelSchedule || this.stopped || this.lost) return;
    this.cancelSchedule = this.schedule(() => {
      void this.renew();
    });
  }

  get canStartWork(): boolean {
    return !this.stopped && !this.lost;
  }

  get isLost(): boolean {
    return this.lost;
  }

  async runIfHeld<T>(work: () => Promise<T>): Promise<LeaseWorkResult<T>> {
    if (!this.canStartWork) return { started: false, leaseHeld: !this.lost };
    const value = await work();
    return { started: true, value, leaseHeld: this.canStartWork };
  }

  stop(): void {
    this.stopped = true;
    this.cancelSchedule?.();
    this.cancelSchedule = undefined;
  }

  private async renew(): Promise<void> {
    if (!this.canStartWork || this.renewalInFlight) return;
    this.renewalInFlight = true;
    try {
      const renewed = await this.renewLease();
      if (this.stopped || this.lost) return;
      if (!renewed) {
        this.lose(`Lease renewal matched no row for commandId=${this.commandId}.`);
      }
    } catch (error) {
      if (this.stopped || this.lost) return;
      const reason = error instanceof Error ? error.message : String(error);
      this.lose(`Lease renewal failed for commandId=${this.commandId}: ${reason}.`);
    } finally {
      this.renewalInFlight = false;
    }
  }

  private lose(message: string): void {
    if (this.lost || this.stopped) return;
    this.lost = true;
    this.cancelSchedule?.();
    this.cancelSchedule = undefined;
    try {
      this.reportLeaseLoss(`${message} Further command work will not be started.`);
    } catch (error) {
      console.error(
        `[CERBERO] lease-loss logger failed for commandId=${this.commandId}:`,
        error,
      );
    }
  }
}

export class CommandConsumer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private readonly dependencies: CommandConsumerDependencies;

  constructor(
    private readonly db: DatabaseClient,
    private readonly ctx: Context,
    private readonly instanceId: string,
    private readonly pollMs = 2_000,
    dependencies: Partial<CommandConsumerDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

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
      const command = await this.dependencies.claimNextCommand(this.db, this.instanceId);
      if (command) await this.processClaimedCommand(command);
    } catch (error) {
      console.error("[CERBERO] command polling failed:", error);
    } finally {
      if (this.running) this.timer = setTimeout(() => void this.poll(), this.pollMs);
    }
  }

  async processClaimedCommand(command: SecurityCommand): Promise<void> {
    const token = command.processing_token;
    if (
      command.status !== "processing" ||
      typeof token !== "string" ||
      token.trim() === "" ||
      command.processing_instance_id !== this.instanceId ||
      command.result_state !== "processing"
    ) {
      this.dependencies.logError(
        `[CERBERO] Refusing command without valid fenced execution identity commandId=${command.id} ` +
          `status=${command.status} instance=${command.processing_instance_id ?? "missing"} ` +
          `token=${token ? "present" : "missing"} result=${command.result_state ?? "missing"}.`,
      );
      return;
    }

    const lease = new CommandLeaseMonitor(
      command.id,
      () =>
        this.dependencies.renewCommandLease(
          this.db,
          command.id,
          this.instanceId,
          token,
        ),
      this.dependencies.scheduleLeaseRenewal,
      (message) => this.dependencies.logError(`[CERBERO] ${message}`),
    );
    lease.start();
    try {
      await this.handleWithLease(command, lease);
    } catch (error) {
      this.dependencies.logError(
        `[CERBERO] command handling failed commandId=${command.id}; outcome was not confirmed.`,
        error,
      );
    } finally {
      lease?.stop();
    }
  }

  private async handleWithLease(
    command: SecurityCommand,
    lease: CommandLeaseMonitor,
  ): Promise<void> {
    let externalActionStarted = false;
    const trace = {
      commandId: command.id,
      groupId: command.group_id,
      targetUserId: command.target_user_id ?? undefined,
      targetMessageId: command.target_message_id ?? undefined,
      processingInstanceId: this.instanceId,
    };

    const reportUncertainOutcome = async (
      stage: string,
      externalOutcome: "not_started" | "call_in_flight_or_returned" | "call_threw",
      reason: string,
      observedResult?: string,
    ): Promise<void> => {
      const safeReason = sanitizeDiagnosticText(reason);
      const resultDetail = observedResult ? ` observedResult=${observedResult}` : "";
      const message =
        `[CERBERO] command outcome uncertain commandId=${command.id} action=${command.action} ` +
        `stage=${stage} externalOutcome=${externalOutcome} reason=${safeReason}${resultDetail}. ` +
        "No automatic retry was started.";
      this.dependencies.logError(message);
      try {
        const recorded = await this.dependencies.markCommandUnknown(
          this.db,
          command.id,
          `${stage}; externalOutcome=${externalOutcome}; ${safeReason}${resultDetail}`,
          this.instanceId,
          command.processing_token!,
        );
        if (!recorded) {
          this.dependencies.logError(
            `[CERBERO] fenced unknown-state update did not match; command row was not changed ` +
              `commandId=${command.id} action=${command.action} externalOutcome=${externalOutcome}.`,
          );
        }
      } catch (error) {
        this.dependencies.logError(
          `[CERBERO] fenced unknown-state update failed commandId=${command.id}; ` +
            `externalOutcome=${externalOutcome}; no row change is confirmed.`,
          error,
        );
      }
    };

    const publishAfterPersistence = async (
      persistedStatus: "completed" | "failed" | "unknown",
      stage: string,
      publish: () => Promise<unknown>,
    ): Promise<void> => {
      try {
        await publish();
      } catch (error) {
        const failureCode = persistedStatus === "completed"
          ? "post_completion_event_failed"
          : "post_result_publication_failed";
        this.dependencies.logError(
          `[CERBERO] ${failureCode} commandId=${command.id} persistedStatus=${persistedStatus} ` +
            `stage=${stage} publication was not confirmed: ${safeErrorDetail(error)}.`,
        );
      }
    };

    const complete = async (
      status: "completed" | "failed",
      errorMessage?: string,
      externalOutcome: "not_started" | "call_in_flight_or_returned" = "not_started",
    ): Promise<boolean> => {
      if (!lease.canStartWork) {
        await reportUncertainOutcome(
          "finalization_skipped_after_lease_loss",
          externalOutcome,
          errorMessage ?? "Lease was lost before finalization.",
        );
        return false;
      }
      lease.stop();
      try {
        const completed = await this.dependencies.completeCommand(
          this.db,
          command.id,
          status,
          errorMessage,
          this.instanceId,
          command.processing_token ?? undefined,
        );
        if (!completed) {
          await reportUncertainOutcome(
            "finalization_not_confirmed",
            externalOutcome,
            errorMessage ?? "Fenced completion update matched no row.",
          );
          return false;
        }
        return true;
      } catch (error) {
        await reportUncertainOutcome(
          "finalization_write_failed",
          externalOutcome,
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    };
    const markUnknown = async (errorMessage: string): Promise<boolean> => {
      if (!lease.canStartWork) {
        await reportUncertainOutcome(
          "unknown_state_write_skipped_after_lease_loss",
          externalActionStarted ? "call_threw" : "not_started",
          errorMessage,
        );
        return false;
      }
      lease.stop();
      try {
        const recorded = await this.dependencies.markCommandUnknown(
          this.db,
          command.id,
          errorMessage,
          this.instanceId,
          command.processing_token!,
        );
        if (!recorded) {
          this.dependencies.logError(
            `[CERBERO] fenced unknown-state update did not match commandId=${command.id}; ` +
              "outcome remains unconfirmed.",
          );
        }
        return recorded;
      } catch (error) {
        this.dependencies.logError(
          `[CERBERO] failed to record unknown command outcome commandId=${command.id}.`,
          error,
        );
        return false;
      }
    };
    if (!lease.canStartWork) {
      await reportUncertainOutcome(
        "lease_lost_before_processing",
        "not_started",
        "No command action was started.",
      );
      return;
    }
    if (!this.dependencies.isSupportedAction(command.action)) {
      if (!(await complete("failed", "Unsupported action"))) return;
      await publishAfterPersistence("failed", "audit:unsupported", () =>
        this.dependencies.publishAudit(this.db, command.action, "unsupported", trace),
      );
      return;
    }
    try {
      if (command.action === "UPDATE_SECURITY_CONFIG") {
        const update = await lease.runIfHeld(() =>
          this.dependencies.updateSecurityConfig(this.db, command.group_id, command.payload),
        );
        if (!update.started) {
          await reportUncertainOutcome(
            "lease_lost_before_database_action",
            "not_started",
            "Security configuration update was not started.",
          );
          return;
        }
        if (!update.leaseHeld) {
          await reportUncertainOutcome(
            "lease_lost_during_database_action",
            "call_in_flight_or_returned",
            "Security configuration update returned after lease loss.",
          );
          return;
        }
        if (!(await complete("completed", undefined, "call_in_flight_or_returned"))) return;
        await publishAfterPersistence("completed", "event:security_config_updated", () =>
          this.dependencies.publishEvent(this.db, command.group_id, "security_config_updated", {
            commandId: command.id,
            processingInstanceId: this.instanceId,
            action: command.action,
            reason: getReason(command),
            result: "completed",
          }),
        );
        await publishAfterPersistence("completed", "audit:security_config_updated", () =>
          this.dependencies.publishAudit(this.db, command.action, "success", {
            ...trace,
            reason: getReason(command),
          }),
        );
        return;
      }
      if (command.action === "UPDATE_PROTECTED_USER") {
        const userId = command.target_user_id;
        if (userId === null) throw new Error("USER_NOT_FOUND: Falta el usuario.");
        const update = await lease.runIfHeld(async () => {
          if (command.payload.enabled === false) {
            await this.dependencies.unprotectUser(this.db, command.group_id, userId);
          } else {
            await this.dependencies.protectUser(
              this.db,
              command.group_id,
              userId,
              typeof command.payload.protectionType === "string" ? command.payload.protectionType : "vip",
              typeof command.payload.username === "string" ? command.payload.username : undefined,
            );
          }
        });
        if (!update.started) {
          await reportUncertainOutcome(
            "lease_lost_before_database_action",
            "not_started",
            "Protected-user update was not started.",
          );
          return;
        }
        if (!update.leaseHeld) {
          await reportUncertainOutcome(
            "lease_lost_during_database_action",
            "call_in_flight_or_returned",
            "Protected-user update returned after lease loss.",
          );
          return;
        }
        if (!(await complete("completed", undefined, "call_in_flight_or_returned"))) return;
        await publishAfterPersistence("completed", "event:protected_user_updated", () =>
          this.dependencies.publishEvent(this.db, command.group_id, "protected_user_updated", {
            commandId: command.id,
            processingInstanceId: this.instanceId,
            reason: getReason(command),
            action: command.payload.enabled === false ? "removed" : "added",
            result: "completed",
          }, userId),
        );
        await publishAfterPersistence("completed", "audit:protected_user_updated", () =>
          this.dependencies.publishAudit(this.db, command.action, "success", {
            ...trace,
            reason: getReason(command),
          }),
        );
        return;
      }
      if (
        command.target_user_id !== null &&
        ["WARN_USER", "MUTE_USER", "BAN_USER", "KICK_USER"].includes(command.action) &&
        await this.dependencies.isProtectedUser(this.db, command.group_id, command.target_user_id)
      ) {
        throw new Error("PROTECTED_TARGET: Usuario incluido en la lista blanca.");
      }
      const result = await lease.runIfHeld(async () => {
        externalActionStarted = true;
        return this.dependencies.executeCommand(this.db, this.ctx, command);
      });
      if (!result.started) {
        await reportUncertainOutcome(
          "lease_lost_before_external_action",
          "not_started",
          "External moderation action was not started.",
        );
        return;
      }
      if (!result.leaseHeld) {
        const observedResult = summarizeExecutionResult(result.value);
        await reportUncertainOutcome(
          "lease_lost_during_external_action",
          "call_in_flight_or_returned",
          "External executeCommand response was observed; persistence was not confirmed.",
          observedResult,
        );
        return;
      }
      const execution = result.value;
      const safeExecutionError = execution.error
        ? sanitizeDiagnosticText(execution.error)
        : undefined;
      if (!(await complete(
        "completed",
        safeExecutionError,
        "call_in_flight_or_returned",
      ))) return;
      await publishAfterPersistence("completed", "event:moderation_executed", () =>
        this.dependencies.publishEvent(this.db, command.group_id, "moderation_executed", {
          commandId: command.id,
          action: command.action,
          actionPerformed: command.action,
          result: "completed",
          messageId: command.target_message_id ?? undefined,
          processingInstanceId: this.instanceId,
          reason: getReason(command),
          ...(sanitizeExecutionDetails(execution.details) ?? {}),
        }, command.target_user_id ?? undefined),
      );
      await publishAfterPersistence("completed", "audit:moderation_executed", () =>
        this.dependencies.publishAudit(
          this.db,
          command.action,
          execution.error ? "partial" : "success",
          { ...trace, error: safeExecutionError, reason: getReason(command) },
        ),
      );
    } catch (error) {
      if (lease.isLost) {
        await reportUncertainOutcome(
          "action_threw_after_lease_loss",
          externalActionStarted ? "call_threw" : "not_started",
          safeErrorDetail(error),
        );
        return;
      }
      const reason = classifyFailure(
        command,
        error instanceof Error ? error.message : String(error),
      );
      const safeReason = sanitizeDiagnosticText(reason);
      if (isAlreadyApplied(command, reason)) {
        if (!(await complete("completed", undefined, "call_in_flight_or_returned"))) return;
        await publishAfterPersistence("completed", "event:moderation_already_applied", () =>
          this.dependencies.publishEvent(this.db, command.group_id, "moderation_executed", {
            commandId: command.id,
            action: command.action,
            actionPerformed: command.action,
            result: "already_applied",
            reason: safeReason,
            processingInstanceId: this.instanceId,
            idempotent: true,
          }, command.target_user_id ?? undefined),
        );
        await publishAfterPersistence("completed", "audit:moderation_already_applied", () =>
          this.dependencies.publishAudit(this.db, command.action, "already_applied", {
            ...trace,
            reason: getReason(command),
          }),
        );
        return;
      }
      const resultRecorded = isDefinitelyNotExecuted(reason)
        ? await complete("failed", safeReason)
        : await markUnknown(safeReason);
      if (!resultRecorded) return;
      const persistedStatus = isDefinitelyNotExecuted(reason) ? "failed" : "unknown";
      await publishAfterPersistence(persistedStatus, "event:moderation_result", () =>
        this.dependencies.publishEvent(
          this.db,
          command.group_id,
          isDefinitelyNotExecuted(reason) ? "moderation_failed" : "moderation_outcome_unknown",
          {
            commandId: command.id,
            action: command.action,
            result: isDefinitelyNotExecuted(reason) ? "failed" : "unknown",
            reasonCode: safeReason.split(":")[0],
            reason: safeReason,
            messageId: command.target_message_id ?? undefined,
            actionError: safeReason,
            processingInstanceId: this.instanceId,
          },
          command.target_user_id ?? undefined,
        ),
      );
      await publishAfterPersistence(persistedStatus, "audit:moderation_result", () =>
        this.dependencies.publishAudit(
          this.db,
          command.action,
          isDefinitelyNotExecuted(reason) ? `failed: ${safeReason}` : `unknown: ${safeReason}`,
          {
            ...trace,
            error: safeReason,
            reason: getReason(command),
          },
        ),
      );
    }
  }

}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/\b(?:bot)?\d{6,}:[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED_TOKEN]")
    .replace(/\b(bearer|token|password|passwd|secret|api[_-]?key)\s*[:=]\s*[^,\s;]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[REDACTED_VALUE]")
    .slice(0, 240);
}

function safeErrorDetail(error: unknown): string {
  if (!(error instanceof Error)) return `Non-Error rejection (${typeof error})`;
  const detail = sanitizeDiagnosticText(error.message);
  return `${sanitizeDiagnosticText(error.name)}: ${detail || "no safe message available"}`;
}

function sanitizeExecutionDetails(
  details: CommandExecutionResult["details"],
): CommandExecutionResult["details"] {
  if (!details) return undefined;
  const safeDetails = { ...details };
  if (Array.isArray(safeDetails.partialErrors)) {
    safeDetails.partialErrors = safeDetails.partialErrors.map((error) =>
      typeof error === "string" ? sanitizeDiagnosticText(error) : error,
    );
  }
  return safeDetails;
}

function summarizeExecutionResult(result: CommandExecutionResult): string {
  const counts: Record<string, number> = {};
  for (const key of ["attempted", "deleted", "failed", "alreadyApplied"] as const) {
    const value = result.details?.[key];
    if (typeof value === "number" && Number.isFinite(value)) counts[key] = value;
  }
  const errorCode = result.error?.split(":", 1)[0]?.trim();
  const safeErrorCode =
    errorCode && /^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode) ? errorCode : undefined;
  const countSummary = Object.keys(counts).length > 0
    ? ` counts=${JSON.stringify(counts)}`
    : "";
  const errorSummary = safeErrorCode ? ` executionErrorCode=${safeErrorCode}` : "";
  return `externalResponse=returned commandCompletion=unconfirmed${errorSummary}${countSummary}`;
}

function isDefinitelyNotExecuted(reason: string): boolean {
  return [
    "INSUFFICIENT_PERMISSIONS:",
    "PROTECTED_TARGET:",
    "USER_NOT_FOUND:",
    "MESSAGE_NOT_FOUND:",
    "UNSUPPORTED_ACTION:",
    "ALREADY_UNBANNED:",
  ].some((prefix) => reason.startsWith(prefix));
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
