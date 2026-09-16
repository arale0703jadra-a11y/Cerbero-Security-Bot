import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";

export type DatabaseClient = SupabaseClient;

export function createDatabaseClient(): DatabaseClient {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error("Supabase configuration is missing.");
  }
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
