import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client. @supabase/ssr stores the session in cookies
 * (not localStorage), so the server and proxy can read the logged-in user.
 * Uses the public anon key (auth-scoped, not the service-role key).
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
