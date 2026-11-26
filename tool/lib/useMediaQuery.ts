"use client";
import { useEffect, useState } from "react";

/**
 * SSR-safe media-query hook.
 *
 * Returns `false` on the server and on the first client render (desktop-first),
 * then updates after mount once `matchMedia` can be read. The desktop layout
 * therefore always renders first; the hook flips to `true` only after the client
 * confirms the query matches, so responsive branches are additive to it.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange(); // sync to the real value on mount
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
