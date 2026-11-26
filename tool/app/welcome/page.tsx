// Public landing page the email-confirmation link redirects to: a static
// "you're verified" message with no session logic. The user then signs in normally.

const FONT =
  '-apple-system, "SF Pro Text", "Segoe UI", Inter, system-ui, sans-serif';

export default function WelcomePage() {
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
      <div
        style={{
          width: 440,
          maxWidth: "92vw",
          padding: 44,
          borderRadius: 18,
          textAlign: "center",
          background: "#ffffff",
          border: "1px solid #ECEAE4",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 12px 44px rgba(0,0,0,0.05)",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/leads-logo-full.png"
          alt="LEADS — Lake Ecosystem Agentic Decision Support"
          style={{ height: 72, width: "auto", display: "block", margin: "0 auto 24px" }}
        />

        {/* check badge */}
        <div
          style={{
            width: 60,
            height: 60,
            margin: "0 auto 22px",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(63,125,84,0.10)",
            border: "1px solid rgba(63,125,84,0.40)",
            color: "#3f7d54",
            fontSize: 30,
            fontWeight: 700,
          }}
        >
          ✓
        </div>

        <h1 style={{ fontFamily: "var(--serif)", fontSize: 30, fontWeight: 400, letterSpacing: "-0.015em", color: "#1a1a18", margin: "0 0 8px" }}>
          You&rsquo;re verified
        </h1>
        <p style={{ fontSize: 14.5, color: "#6b6b64", lineHeight: 1.6, margin: "0 0 30px" }}>
          Your email is confirmed and your account is ready. Welcome to{" "}
          <strong style={{ color: "#1a1a18", fontWeight: 600 }}>LEADS</strong> — Lake Ecosystem
          Agentic Decision Support.
        </p>

        <a
          href="/login"
          style={{
            display: "inline-block",
            padding: "12px 28px",
            borderRadius: 10,
            background: "#1a1a18",
            color: "#ffffff",
            fontSize: 15,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Continue to sign in →
        </a>
      </div>
    </div>
  );
}
