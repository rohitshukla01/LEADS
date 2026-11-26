"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { isAllowedEmail, ALLOWED_DOMAINS_LABEL } from "@/lib/auth-config";

type Mode = "signin" | "signup";

const FONT =
  '-apple-system, "SF Pro Text", "Segoe UI", Inter, system-ui, sans-serif';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sign out a session whose email domain is not on the allowlist.
  useEffect(() => {
    const supabase = createClient();
    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (data.user && !isAllowedEmail(data.user.email)) {
          supabase.auth.signOut();
          setError(`Only ${ALLOWED_DOMAINS_LABEL} email addresses are allowed.`);
        }
      })
      .catch(() => {});
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    if (!isAllowedEmail(email)) {
      setBusy(false);
      setError(`Only ${ALLOWED_DOMAINS_LABEL} email addresses are allowed.`);
      return;
    }
    const supabase = createClient();

    if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/welcome`,
          data: { first_name: firstName.trim(), last_name: lastName.trim() },
        },
      });
      setBusy(false);
      if (error) {
        setError(error.message);
        return;
      }
      if (data.session) {
        // Email confirmation off: signed in at once.
        router.push("/");
        router.refresh();
      } else {
        // Email confirmation on: a confirmation email was sent.
        setMessage("Almost there — check your email and click the link to verify your account.");
        setMode("signin");
      }
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #e3e1da",
    background: "#ffffff",
    color: "#1a1a18",
    fontSize: 14,
    fontFamily: FONT,
    boxSizing: "border-box",
    outline: "none",
  };

  const tab = (m: Mode): React.CSSProperties => ({
    flex: 1,
    padding: "8px 0",
    textAlign: "center",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    color: mode === m ? "#1a1a18" : "#a3a39b",
    borderBottom: `2px solid ${mode === m ? "#1a1a18" : "transparent"}`,
  });

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#faf9f6",
        fontFamily: FONT,
        padding: 24,
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: 380,
          maxWidth: "92vw",
          padding: 36,
          borderRadius: 16,
          background: "#ffffff",
          border: "1px solid #ECEAE4",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 12px 40px rgba(0,0,0,0.05)",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/leads-logo-full.png"
          alt="LEADS — Lake Ecosystem Agentic Decision Support"
          style={{ height: 72, width: "auto", display: "block", marginBottom: 18 }}
        />
        <h1
          style={{
            fontFamily: "var(--serif)",
            fontSize: 30,
            fontWeight: 400,
            letterSpacing: "-0.015em",
            color: "#1a1a18",
            margin: "0 0 22px",
          }}
        >
          {mode === "signin" ? "Sign in" : "Create your account"}
        </h1>

        {/* Sign in / Create account tabs */}
        <div style={{ display: "flex", marginBottom: 22, borderBottom: "1px solid #ECEAE4" }}>
          <div style={tab("signin")} onClick={() => { setMode("signin"); setError(null); setMessage(null); }}>
            Sign in
          </div>
          <div style={tab("signup")} onClick={() => { setMode("signup"); setError(null); setMessage(null); }}>
            Create account
          </div>
        </div>

        {mode === "signup" && (
          <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: "block", fontSize: 12, color: "#6b6b64", marginBottom: 6 }}>
                First name
              </label>
              <input
                type="text"
                required
                autoComplete="given-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: "block", fontSize: 12, color: "#6b6b64", marginBottom: 6 }}>
                Last name
              </label>
              <input
                type="text"
                required
                autoComplete="family-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                style={inputStyle}
              />
            </div>
          </div>
        )}

        <label style={{ display: "block", fontSize: 12, color: "#6b6b64", marginBottom: 6 }}>
          Email
        </label>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ ...inputStyle, marginBottom: 14 }}
        />

        <label style={{ display: "block", fontSize: 12, color: "#6b6b64", marginBottom: 6 }}>
          Password
        </label>
        <input
          type="password"
          required
          minLength={6}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ ...inputStyle, marginBottom: 18 }}
        />

        {error && <div style={{ color: "#b4453a", fontSize: 13, marginBottom: 14 }}>{error}</div>}
        {message && <div style={{ color: "#3f7d54", fontSize: 13, marginBottom: 14 }}>{message}</div>}

        <button
          type="submit"
          disabled={busy}
          style={{
            width: "100%",
            padding: "11px 0",
            borderRadius: 8,
            border: "none",
            background: busy ? "#a3a39b" : "#1a1a18",
            color: "#ffffff",
            fontSize: 15,
            fontWeight: 600,
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>

        <p style={{ fontSize: 11.5, color: "#9a9a93", marginTop: 16, lineHeight: 1.55 }}>
          Access is restricted to {ALLOWED_DOMAINS_LABEL} email addresses.{" "}
          {mode === "signin"
            ? "New here? Switch to “Create account” to register."
            : "Create your account to get started."}
        </p>
      </form>
    </div>
  );
}
