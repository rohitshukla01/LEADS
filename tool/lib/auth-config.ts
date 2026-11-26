// Email-domain allowlist for LEADS access. Only addresses on these domains may
// sign up or sign in. To change who's allowed, edit this one list.
export const ALLOWED_EMAIL_DOMAINS = ["vt.edu"];

/** True only if the email's domain is in the allowlist. */
export function isAllowedEmail(email: string | null | undefined): boolean {
  const domain = email?.split("@")[1]?.toLowerCase().trim();
  return !!domain && ALLOWED_EMAIL_DOMAINS.includes(domain);
}

/** Human-readable label, e.g. "@vt.edu". */
export const ALLOWED_DOMAINS_LABEL = ALLOWED_EMAIL_DOMAINS.map((d) => "@" + d).join(", ");

// Built with NEXT_PUBLIC_LEADS_NO_SIGN_IN=1, LEADS runs without sign-in and without Supabase (the
// Docker version in the main README). For use on your own computer only. Unset, sign-in is required.
export const NO_SIGN_IN = process.env.NEXT_PUBLIC_LEADS_NO_SIGN_IN === "1";
