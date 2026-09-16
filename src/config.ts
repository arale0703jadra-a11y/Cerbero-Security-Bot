import "dotenv/config";

export const config = {
  botToken: process.env.CERBERO_BOT_TOKEN,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  instanceId: process.env.CERBERO_INSTANCE_ID,
  securityMode: process.env.CERBERO_SECURITY_MODE === "automatic" ? "automatic" : "alert",
};

export function validateConfig(): void {
  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing configuration: ${missing.join(", ")}`);
  }
}
