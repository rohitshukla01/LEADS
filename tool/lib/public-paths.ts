// Paths reachable without signing in. The single source for the auth gate in proxy.ts and for
// scripts/check-public-paths.ts, which fails `npm run check` if the LEADS tool or any API (other
// than the health probe) ever becomes public. Static files (images, css, js) are excluded from the
// proxy matcher in proxy.ts and are always public. A build made with NEXT_PUBLIC_LEADS_NO_SIGN_IN=1
// has no sign-in at all (see proxy.ts).

export function isPublicPath(pathname: string): boolean {
  // Encoded slashes or backslashes and dot segments are never public: they then need sign-in like
  // everything else, whatever prefix they start with.
  if (/%2f|%5c|\\|%2e|(^|\/)\.\.?(\/|$)/i.test(pathname)) return false;
  return (
    pathname === "/login" ||
    pathname === "/welcome" || // page the email-confirmation link opens
    pathname === "/api/health" // keep-alive probe must stay public
  );
}
