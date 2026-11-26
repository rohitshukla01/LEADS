import { createClient } from "@supabase/supabase-js";

let _client: ReturnType<typeof createClient<any>> | null = null;

export function getSupabaseAdmin() {
  if (!_client) {
    _client = createClient<any>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _client;
}
