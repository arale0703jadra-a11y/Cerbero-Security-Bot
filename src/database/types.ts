export type CommandAction =
  | "DELETE_MESSAGE"
  | "MUTE_USER"
  | "UNMUTE_USER"
  | "BAN_USER"
  | "UNBAN_USER"
  | "KICK_USER"
  | "UPDATE_SECURITY_CONFIG"
  | "UPDATE_PROTECTED_USER"
  | "WARN_USER"
  | "UNWARN_USER"
  | "UNWARN_ALL"
  | "CLEAN_MESSAGES";

export type CommandStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";
export type CommandResultState =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface SecurityCommand {
  id: string;
  group_id: number;
  action: CommandAction;
  target_user_id: number | null;
  target_message_id: number | null;
  payload: Record<string, unknown>;
  status: CommandStatus;
  created_at: string;
  executed_at: string | null;
  processing_instance_id?: string | null;
  processing_token?: string | null;
  lease_expires_at?: string | null;
  processing_at?: string | null;
  attempts?: number;
  last_error?: string | null;
  responsible_bot?: string | null;
  cancelled_at?: string | null;
  operation_key?: string | null;
  result_state?: CommandResultState | null;
}

export interface SecurityCommandPayload {
  requester_id?: number;
  requester_name?: string;
  reason?: string;
  duration_minutes?: number;
  until_date?: number;
  message_ids?: number[];
  warn_limit?: number;
  warn_action?: "mute" | "ban" | "none";
  [key: string]: unknown;
}

export type SecurityMode = "alert" | "automatic";
export type SecurityActionName = "detect" | "delete" | "warn" | "mute" | "kick" | "ban";
export type SecuritySeverity = "low" | "medium" | "high" | "critical";
export interface SecurityRule {
  enabled: boolean;
  severity: SecuritySeverity;
  action: SecurityActionName;
}

export interface SecurityGroupConfig {
  group_id: number;
  enabled: boolean;
  safe_mode: boolean;
  sanctions_enabled: boolean;
  mode: SecurityMode;
  anti_spam: boolean;
  anti_flood: boolean;
  anti_links: boolean;
  anti_content: boolean;
  media_protection: boolean;
  prohibited_words: string[];
  allowed_link_domains: string[];
  warning_two_action: Exclude<SecurityActionName, "warn">;
  warning_three_action: "kick" | "ban";
  warning_four_action: "ban";
  reincidence_enabled: boolean;
  rules: Record<string, SecurityRule>;
  sticker_limit: number;
  media_limit: number;
}
