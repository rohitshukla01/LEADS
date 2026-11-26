"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Toaster } from "sonner";
import PipelinePanel from "@/components/PipelinePanel";
import CitationCard from "@/components/CitationCard";
import UserProfilePanel, { type UserProfile } from "@/components/UserProfilePanel";
import { createClient as createSupabaseBrowserClient } from "@/lib/supabase/client";
import { NO_SIGN_IN } from "@/lib/auth-config";
import {
  listConversations,
  loadConversationMessages,
  saveConversation,
  deleteConversation,
  type ConversationSummary,
} from "@/lib/conversations";
import InsightPanel from "@/components/InsightPanel";
import ReproducePanel from "@/components/ReproducePanel";
import DecisionReportButton from "@/components/DecisionReportButton";
import AnswerText from "@/components/AnswerText";
import { buildCheckScopeLine, literatureExcerptNote, claimCheckMissing, CLAIM_CHECK_MISSING_NOTE } from "@/lib/report-content";
import { numberCitationsForDisplay, type CitationDisplay } from "@/lib/citation-display";
import { tidyAnswerText } from "@/lib/answer-tidy";
import { readerText } from "@/lib/reader-text";
import type { ReproduceParams } from "@/lib/reproduce";
import {
  siteForReservoir,
  fetchSensorSeries,
  fetchForecastSeries,
  fetchClimatology,
  VARIABLE_META,
  type SeriesPoint,
  type ForecastPoint,
  type ClimatologyBand,
} from "@/lib/insights";
import type { LeadsChartSpec } from "@/lib/leads/types";
import { clampChartHorizon } from "@/lib/leads/horizon";
import { useMediaQuery } from "@/lib/useMediaQuery";
import Icon from "@/components/Icon";
import { getGuardrail } from "@/lib/leads/guardrails";
import type { Citation } from "@/lib/citation";

const LEADS_PROFILE_STORAGE_KEY = "leads.userProfile.v1";


/* Colours */
const C = {
  s1:  "rgba(120,113,108,0.10)",
  am:  "#02436e",                         // LEADS logo navy-teal (primary / active)
  amD: "rgba(2,67,110,0.08)",
  tx:  "#1a1a18",                         // dark slate text
  mu:  "#54544e",                         // muted mid-tone
  gr:  "#3f7d54",                         // success green
};

/* Shadow */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const depthShadow = (_color = "transparent") => "0 1px 2px rgba(0,0,0,0.04), 0 4px 14px rgba(0,0,0,0.05)";   // neutral shadow; the colour argument is ignored

/* Types */
interface DocMeta { id: string; name: string; pages: number; chunkCount: number; charCount: number; }
interface Faithfulness { cited: number; total: number; pct: number; }
interface ClaimVerification { text: string; supported: boolean; sourceIndex: number | null; confidence: number; bracketNum?: number | null; checkedBy?: "word-overlap"; }
/** Per-answer "Trust score" object emitted in the SSE `done` event. The
 *  field is named `confidence` to match the LeadsAnswer schema (following
 *  Hu et al., 2025), but the UI labels it "Trust score": the components
 *  audit the answer, they are not model-belief estimates. */
interface Confidence {
  grounding: number;            // G - verifier.pct / 100
  verifierConfidence: number;   // V - mean per-claim verifier confidence
  policyAdherence: number;      // P - Layer-3 adherence (1.0 default)
  channelCoverage: number;      // Y - filled requested channels / total
  overall: number;              // C_LEADS composite
  iterations: number;           // plan-refinement rounds consumed
}
/** Deterministic alignment of the profile and the question (SSE `done`.alignment): flags a mismatch in decision, zone, reservoir or mode. */
interface Alignment {
  aligned: boolean;
  severity: "aligned" | "soft" | "hard";
  dimensions: ("decision" | "zone" | "reservoir" | "mode")[];
  formDecision: string;
  inferredDecision: string | null;
  rationale: string;
  suggestedDecision?: string;
}
/** History list grouping for a conversation's last update (display only). */
function historyGroup(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Earlier";
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

/** Short stamp under each history title: the time for today, otherwise "4 Oct". */
function historyStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (historyGroup(iso) === "Today") return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

interface MessageChart {
  label: string;
  units: string;
  site: string;
  depthM: number | null;
  sensor: SeriesPoint[] | null;
  forecast: ForecastPoint[] | null;
  climatology: ClimatologyBand | null;
  threshold?: { value: number; label: string; direction?: "below" | "above" };
  /** Full-profile decisions (water extraction): one labelled observation series per
   *  depth, so the chart shows which depth fails the floor. Null for other decisions. */
  depthSeries?: { label: string; points: SeriesPoint[] }[] | null;
  /** The horizon the question asked for (plan.chart.forecastHorizon, unclamped). The chart
   *  draws the clamped 7–35-day horizon; the skill card and the PDF use this one, as the
   *  evidence record does, so all three show the same forecast days (days 1–3, not the
   *  chart's 7, for a 3-day question). May be absent on a saved message. */
  questionHorizon?: number | null;
  loading: boolean;
}
/** The profile an answer was generated under, recorded on the message at send time so the
 *  decision record describes that answer - not whatever the dropdown says at download time,
 *  and not a different profile after a saved conversation is reopened. */
type MessageProfile = Pick<UserProfile, "persona" | "reservoir" | "decision">;
interface Message { id: number; role: "user"|"assistant"; content: string; citations?: Citation[]; faithfulness?: Faithfulness; claims?: ClaimVerification[]; confidence?: Confidence; alignment?: Alignment; streaming?: boolean; chart?: MessageChart | null; reproduce?: ReproduceParams | null; pipeline?: Record<string, StepState>; profile?: MessageProfile; }
interface StepState { status: "running"|"done"|"streaming"; data?: Record<string, unknown>; }


// Display numbering for one answer's citations (lib/citation-display.ts). The cited
// sources read 1..n in the order the answer cites them, and the answer text, the
// evidence cards and the claim list all read from this one view, so a chip, its card
// and a claim's source number always agree. Sources the claim verifier matched without
// an inline marker are numbered after the ones the text cites. While the answer
// streams, the citations have not arrived yet, so every marker number is taken as a
// citation and numbered by first appearance: the numbers do not change when the
// answer completes. Display only: the message keeps the pipeline's numbers. Cached
// per message object - messages are replaced on update, never mutated, so an entry
// cannot go stale. The displayed text and rewritten claims are then tidied
// (lib/answer-tidy.ts: citation runs ascending on display numbers, "skilful"); the
// tidy changes no display number, so chips, cards and claims still agree.
const citationViews = new WeakMap<Message, CitationDisplay<Citation>>();
function citationView(m: Message): CitationDisplay<Citation> {
  let view = citationViews.get(m);
  if (!view) {
    const raw = numberCitationsForDisplay(m.content, m.citations, {
      alsoCited: (m.claims ?? []).map((cl) => cl.bracketNum),
      assumeKnown: m.streaming === true && !m.citations?.length,
    });
    view = { ...raw, text: tidyAnswerText(raw.text), rewrite: (s: string) => tidyAnswerText(raw.rewrite(s)) };
    citationViews.set(m, view);
  }
  return view;
}

/* Main component */
export default function Home() {
  const [docs, setDocs]                       = useState<DocMeta[]>([]);
  // LEADS pipeline state
  const [messages, setMessages]               = useState<Message[]>([]);
  const [input, setInput]                     = useState("");
  const [busy, setBusy]                       = useState(false);
  const [pipeSteps, setPipeSteps]             = useState<Record<string, StepState>>({});
  const [showPipe, setShowPipe]               = useState(false);
  const [pipeDrawerOpen, setPipeDrawerOpen]   = useState(false); // right-edge diagnostics drawer; closed by default
  const [openClaims, setOpenClaims]           = useState<Record<number, boolean>>({}); // per-message claim-list expansion
  const [openEvidence, setOpenEvidence]       = useState<Record<number, boolean>>({}); // per-message evidence-cards expansion
  const [openTrust, setOpenTrust]             = useState<Record<number, boolean>>({}); // per-message "how is the trust score calculated" explainer
  const [highlightedCitation, setHighlightedCitation] = useState<{ msgId: number; n: number } | null>(null);
  const endRef     = useRef<HTMLDivElement>(null);
  const msgIdRef   = useRef(0);
  const sessionIdRef = useRef<string>("");   // server-side conversation memory: new per conversation, reused for follow-ups
  const citationRefs   = useRef<Record<string, HTMLDivElement | null>>({});

  // LEADS Step 1 - User Profile (gates query send; persisted across reloads)
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profilePanelOpen, setProfilePanelOpen] = useState(false);
  // Greeting: time of day and first_name from the signed-in user's metadata, shown on the
  // empty page.
  const [firstName, setFirstName] = useState<string | null>(null);
  const [greeting, setGreeting] = useState<string>("");
  // Conversation history: each user's saved chats in Supabase (row-level security).
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string>("");
  const skipSaveRef = useRef(false); // true: the next messages change is a loaded conversation, not a new turn
  // Below 768 px the sidebar becomes an off-canvas drawer. isMobile is false on the server
  // and on the first client render.
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [hoverConv, setHoverConv] = useState<string | null>(null);   // history row under the pointer (shows its delete button)
  useEffect(() => {
    // Restore the saved profile, if any. It pre-fills the profile panel through the
    // `initial={profile ?? undefined}` prop on UserProfilePanel below.
    try {
      const raw = localStorage.getItem(LEADS_PROFILE_STORAGE_KEY);
      if (raw) setProfile(JSON.parse(raw) as UserProfile);
    } catch {
      /* corrupt localStorage value - ignored */
    }
    // Time-of-day greeting (client-only; set on mount to avoid hydration drift).
    const h = new Date().getHours();
    setGreeting(h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
    if (NO_SIGN_IN) return;
    // Greet by name: pull first_name from the signed-in user's metadata.
    createSupabaseBrowserClient()
      .auth.getUser()
      .then(({ data }) => {
        const fn = data.user?.user_metadata?.first_name;
        if (typeof fn === "string" && fn.trim()) setFirstName(fn.trim());
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    try {
      if (profile) localStorage.setItem(LEADS_PROFILE_STORAGE_KEY, JSON.stringify(profile));
      else localStorage.removeItem(LEADS_PROFILE_STORAGE_KEY);
    } catch {}
  }, [profile]);

  // Conversation history
  const refreshConversations = useCallback(async () => {
    if (NO_SIGN_IN) return; // conversations are kept in Supabase
    setConversations(await listConversations());
  }, []);

  // Begin a fresh conversation (new id + cleared transcript + fresh server memory).
  const startNewConversation = useCallback(() => {
    setMessages([]);
    setPipeSteps({});
    setShowPipe(false);
    sessionIdRef.current = "";
    setCurrentConvId(crypto.randomUUID());
  }, []);

  // Load a saved conversation back into the view.
  const openConversation = useCallback(async (id: string) => {
    const msgs = await loadConversationMessages(id);
    if (!msgs) return;
    skipSaveRef.current = true; // loading must not trigger a re-save / reorder
    setPipeSteps({});
    setShowPipe(false);
    // Charts are per-message (Message.chart) and persist with the transcript, so a
    // loaded conversation shows each answer's own chart - nothing to clear here.
    setMessages(msgs as Message[]);
    // New messages must get ids above the loaded ones.
    msgIdRef.current = Math.max(msgIdRef.current, ...(msgs as Message[]).map((m) => Number(m.id) || 0));
    setCurrentConvId(id);
    sessionIdRef.current = ""; // follow-ups start a fresh server session
    setProfilePanelOpen(false);
  }, []);

  const removeConversation = useCallback(async (id: string) => {
    await deleteConversation(id);
    await refreshConversations();
    if (id === currentConvId) startNewConversation();
  }, [currentConvId, refreshConversations, startNewConversation]);

  // On mount: open a fresh conversation id and load the user's history list.
  useEffect(() => {
    setCurrentConvId(crypto.randomUUID());
    void refreshConversations();
  }, [refreshConversations]);

  // Auto-save the current conversation once a turn fully completes (no message
  // is still streaming, and there's a real assistant answer). Token streaming
  // is skipped via the `streaming` guard, so this fires once per finished turn.
  useEffect(() => {
    if (!currentConvId) return;
    if (messages.length === 0) return;
    if (messages.some((m) => m.streaming)) return;
    if (!messages.some((m) => m.role === "assistant" && m.content && !m.content.startsWith("Error:"))) return;
    if (skipSaveRef.current) { skipSaveRef.current = false; return; }
    if (NO_SIGN_IN) return;
    const firstUser = messages.find((m) => m.role === "user");
    const title = (firstUser?.content ?? "Conversation").trim().slice(0, 80) || "Conversation";
    void saveConversation(currentConvId, title, messages).then(refreshConversations);
  }, [messages, currentConvId, refreshConversations]);

  // Data-aware charts: render exactly what the pipeline planner decided to chart.
  // Driven by the "chart" SSE event (see send()), whose spec carries the planner's
  // variable hints, site, channels, depth zone and window: the same plan the pipeline
  // retrieved and reasoned over. Fail-soft: a non-chartable variable or empty series
  // shows no panel and leaves the answer unaffected. The series come from the
  // deterministic /api/sensors and /api/forecast endpoints.
  const loadChartForMessage = useCallback((spec: LeadsChartSpec, msgId: number) => {
    // The first planner variable hint the chart can render (VARIABLE_META); for a hypoxia
    // decision, fall back to DO. Otherwise this answer has no chart.
    const chartable =
      spec.variableHints.find((v) => VARIABLE_META[v]) ??
      (profile?.decision === "hypoxia_management" ? "DO_mgL_mean" : null);
    const meta = chartable ? VARIABLE_META[chartable] : undefined;
    if (!spec.plot || !chartable || !meta) return;
    const site = spec.siteId ?? siteForReservoir(profile?.reservoir);
    const depthZone = spec.depthZone ?? profile?.depth ?? null;
    const wantSensor = spec.channels.includes("sensor");
    // Forecast layer follows the agent's intent gate (forward-looking question),
    // not merely channel presence.
    const wantForecast = spec.showForecast && !!meta.flare;
    // Threshold line from the active decision's guardrail rule, set server-side only where
    // the rule applies (buildChartSpec, lib/leads/router.ts), so the line, the operating-rule
    // check and the forecast member share use the same number. It is drawn only when the rule
    // constrains the charted variable: some researcher rules use DOsat_percent_mean or
    // FluoroProbe chl-a, which the chart does not draw. A threshold without a variable tag is
    // drawn.
    const specThreshold = spec.threshold ?? undefined;
    const threshold =
      specThreshold && specThreshold.variable && specThreshold.variable !== chartable
        ? undefined
        : specThreshold;
    // Reproduce params for the "R & Python code" panel: the data the chart shows (site,
    // variable, depth of the charted zone, window and the clamped horizon). The snippet
    // reproduces the public VERA/FLARE data, never the pipeline.
    const ZONE_M: Record<string, Record<string, number>> = {
      fcre: { epilimnion: 1.6, metalimnion: 5, hypolimnion: 9 },
      bvre: { epilimnion: 1.5, metalimnion: 6, hypolimnion: 8 },
    };
    // Forecast horizon the answer reasoned over, clamped to the chart's readable
    // [7,35] window (falls back to 7 if the spec lacks the field). Used for both
    // the chart fetch and the reproduce snippet so they always agree.
    const chartHorizon = clampChartHorizon(spec.forecastHorizon ?? 7);
    const reproduce: ReproduceParams = {
      site,
      variable: chartable,
      depthM: depthZone ? (ZONE_M[site]?.[depthZone] ?? null) : null,
      days: spec.windowDays,
      horizon: chartHorizon,
      climatology: wantSensor,
      forecast: wantForecast,
      threshold: threshold ? { value: threshold.value, direction: threshold.direction ?? "below" } : null,
    };
    // Full-profile decisions (water extraction) chart every candidate depth against the
    // intake floor, so the depth that decides the answer is visible. Each zone reuses the
    // same depth-matched fetch the single-series path uses, so the traces match the depths
    // the answer cites.
    const profileZones = wantSensor ? spec.profileZones ?? null : null;
    const multiZones = profileZones?.length ? profileZones : null;

    // Attach a loading chart to this message, then fill it when the series resolve.
    setMessages((prev) => prev.map((m) => (m.id === msgId
      ? { ...m, chart: { label: meta.label, units: meta.units, site, depthM: null, sensor: null, forecast: null, climatology: null, threshold, depthSeries: null, questionHorizon: spec.forecastHorizon ?? null, loading: true }, reproduce }
      : m)));
    Promise.all([
      wantSensor && !multiZones ? fetchSensorSeries(site, chartable, spec.windowDays, depthZone) : Promise.resolve(null),
      wantForecast && !multiZones ? fetchForecastSeries(site, chartable, chartHorizon, depthZone) : Promise.resolve(null),
      wantSensor && !multiZones ? fetchClimatology(site, chartable, depthZone) : Promise.resolve(null),
      multiZones
        ? Promise.all(multiZones.map((z) => fetchSensorSeries(site, chartable, spec.windowDays, z)))
        : Promise.resolve(null),
    ])
      .then(([s, f, c, profile]) => {
        // Label each trace by its actual depth (from the fetch), never by the canonical
        // zone number - if the feed moves a sonde the legend must follow the data.
        const depthSeries = profile
          ? profile
              .map((r, i) => (r && r.points.length
                ? { label: r.depthM != null ? `${r.depthM} m` : (multiZones as string[])[i], points: r.points }
                : null))
              .filter((r): r is { label: string; points: SeriesPoint[] } => r !== null)
          : null;
        setMessages((prev) => prev.map((m) => (m.id === msgId && m.chart
          ? { ...m, chart: { ...m.chart, sensor: s?.points ?? null, forecast: f?.points ?? null, climatology: c ?? null, depthSeries: depthSeries?.length ? depthSeries : null, depthM: s?.depthM ?? f?.depthM ?? null, loading: false } }
          : m)));
      })
      .catch(() => {
        setMessages((prev) => prev.map((m) => (m.id === msgId && m.chart ? { ...m, chart: { ...m.chart, loading: false } } : m)));
      });
  }, [profile]);

  const loadDocuments = useCallback(async () => {
    if (NO_SIGN_IN) return; // the paper list is kept in Supabase; questions are accepted without it
    try {
      const r = await fetch("/api/documents");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Corpus lookup failed");
      const nextDocs = (d.documents ?? []).map((doc: {
        id: string;
        name: string;
        pages: number;
        chunk_count: number;
        char_count: number;
      }) => ({
        id: doc.id,
        name: doc.name,
        pages: doc.pages,
        chunkCount: doc.chunk_count,
        charCount: doc.char_count,
      }));
      setDocs(nextDocs);
    } catch {
      setDocs([]);
    }
  }, []);

  useEffect(() => { void loadDocuments(); }, [loadDocuments]);

  useEffect(() => { if (messages.length > 0) endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const handleCitationClick = (msgId: number, n: number) => {
    setOpenEvidence((o) => ({ ...o, [msgId]: true })); // expand sources so the cited card is visible
    setHighlightedCitation({ msgId, n });
    setTimeout(() => citationRefs.current[`${msgId}-${n}`]?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    setTimeout(() => setHighlightedCitation(null), 2500);
  };

  /* Query */
  const send = async () => {
    if (!input.trim() || (docs.length === 0 && !NO_SIGN_IN) || busy || !profile) return;
    const q = input.trim(); setInput(""); setBusy(true); setShowPipe(true); setPipeSteps({});
    // Multi-turn memory: a new session id for each new conversation, reused for follow-ups,
    // so the orchestrator can load and save history (lib/leads/session-memory.ts). "+ NEW"
    // and opening a saved conversation start a new session. A request without a sessionId,
    // as in the evaluation, is single-shot and reproducible.
    if (messages.length === 0 || !sessionIdRef.current) {
      sessionIdRef.current =
        globalThis.crypto?.randomUUID?.() ?? `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    const userMsgId = ++msgIdRef.current; const msgId = ++msgIdRef.current;
    setMessages((prev) => [...prev, { id: userMsgId, role: "user", content: q }]);
    setMessages((prev) => [...prev, { id: msgId, role: "assistant", content: "", citations: [], streaming: true, profile: { persona: profile.persona, reservoir: profile.reservoir, decision: profile.decision } }]);
    let resp = ""; let finalCitations: Citation[] = []; let finalFaithfulness: Faithfulness | undefined; let finalClaims: ClaimVerification[] | undefined; let finalConfidence: Confidence | undefined; let finalAlignment: Alignment | undefined; let finalPipe: Record<string, StepState> = {};
    try {
      const res = await fetch("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q, leadsProfile: profile, sessionId: sessionIdRef.current }) });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "step") { const stepState = { status: event.status, data: event.data }; finalPipe = { ...finalPipe, [event.step]: stepState }; setPipeSteps((prev) => ({ ...prev, [event.step]: stepState })); }
            else if (event.type === "chart") { loadChartForMessage(event.chart as LeadsChartSpec, msgId); }
            else if (event.type === "token") { resp += event.token; setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, content: resp } : m)); }
            else if (event.type === "faithfulness") { finalClaims = event.claims; }
            else if (event.type === "done") { finalCitations = event.citations ?? []; finalFaithfulness = event.faithfulness; finalConfidence = event.confidence; finalAlignment = event.alignment; }
            else if (event.type === "error") { resp = `Error: ${event.message}`; setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, content: resp } : m)); }
          } catch (_) {}
        }
      }
    } catch (err) { resp = `Error: ${err instanceof Error ? err.message : "Query failed"}`; }
    // Silent-close guard: the serverless function can be terminated mid-pipeline (e.g. at
    // the route's time limit) after early SSE events but before any answer token or the `done`
    // event - the stream then just ends with no error. Surface that instead of leaving a
    // blank bubble with no answer, no trust score, and no evidence.
    if (resp === "") {
      resp = "The response didn't finish in time — this can happen on a slow multi-step query. Please try again.";
    }
    setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, content: resp, citations: finalCitations, faithfulness: finalFaithfulness, claims: finalClaims, confidence: finalConfidence, alignment: finalAlignment, pipeline: finalPipe, streaming: false } : m));
    setBusy(false);
  };

  // Render-state aliases used by the JSX below.
  const curMessages            = messages;
  const curBusy                = busy;
  const curInput               = input;
  const curSetInput            = setInput;
  const curSend                = send;
  const curHighlightedCitation = highlightedCitation;
  const curHandleCitationClick = handleCitationClick;
  const curCitationRefs        = citationRefs;
  const curEndRef              = endRef;

  /* Render */
  return (
    <div suppressHydrationWarning style={{ position: "relative", height: "100vh", display: "flex", flexDirection: "column", color: C.tx, fontFamily: "var(--sans)", overflow: "hidden", zIndex: 1 }}>
      {/* Empty-state greeting - time-of-day + name, centred in the viewport above the
          composer. The hint is profile-aware: with no profile the Step-1 bar above the
          composer is the way in; with one, the user can simply type. */}
      {curMessages.length === 0 && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0,
          display: "flex", flexDirection: "column", alignItems: "center",
          paddingTop: "32vh", zIndex: isMobile ? 0 : 5, pointerEvents: "none", textAlign: "center",   // phone: under the drawer; desktop: above the sidebar
        }}>
          <h1 suppressHydrationWarning style={{
            fontFamily: "var(--serif)", fontSize: 42, fontWeight: 400, letterSpacing: "-0.015em",
            color: C.tx, margin: 0, lineHeight: 1.1,
          }}>
            {greeting || "Welcome"}{firstName ? `, ${firstName}` : ""}
          </h1>
          <p style={{ fontSize: 14, color: C.mu, marginTop: 12, letterSpacing: "0.005em" }}>
            {profile ? (
              <>Ask your question below to start.</>
            ) : (
              <>Set your <strong style={{ fontWeight: 600, color: C.tx }}>profile</strong> below to start.</>
            )}
          </p>
        </div>
      )}

      <Toaster theme="light" position="top-right" toastOptions={{
        style: { background: "#fff", border: "1px solid var(--rule)", color: C.tx, boxShadow: depthShadow(), fontFamily: "var(--sans)" },
      }} />

      {/* Header */}
      <header style={{
        position: "relative", zIndex: 10, padding: isMobile ? "10px 14px" : "10px 24px", flexShrink: 0,
        background: "#fff",
        borderBottom: "1px solid var(--rule)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {/* Hamburger - opens the conversations drawer on mobile only (desktop: not rendered) */}
          {isMobile && (
            <button
              type="button"
              onClick={() => setSidebarOpen((o) => !o)}
              aria-label="Toggle conversations menu"
              style={{ background: "none", border: "none", cursor: "pointer", color: C.tx, fontSize: 24, lineHeight: 1, padding: "2px 4px", display: "flex", alignItems: "center" }}
            ><Icon name="menu" size={22} /></button>
          )}
          {/* Brand logo - the lake-and-network mark with the LEADS wordmark (the
              paper's logo; its tagline is too small to read at header size, so the
              full lockup appears on the login and welcome cards). File lives at
              public/leads-logo-header.png, drawn at 3x for sharp rendering. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/leads-logo-header.png"
            alt="LEADS — Lake Ecosystem Agentic Decision Support"
            style={{ height: 44, width: "auto", display: "block" }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {busy && (
            <div style={{ padding: "4px 11px", borderRadius: 20, background: C.amD, border: "none", fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: C.am, fontFamily: "var(--sans)", animation: "glowPulse 1.6s ease-in-out infinite" }}>
              ● PROCESSING
            </div>
          )}
          {!NO_SIGN_IN && (
          <button
            type="button"
            onClick={async () => { await createSupabaseBrowserClient().auth.signOut(); window.location.href = "/login"; }}
            title="Sign out of LEADS"
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "6px 12px", borderRadius: 8,
              background: "transparent", border: "1px solid var(--rule-strong)",
              color: C.mu, fontSize: 13, fontWeight: 500, cursor: "pointer",
              fontFamily: "var(--sans)", transition: "all 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.s1; e.currentTarget.style.color = C.tx; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.mu; }}
          >
            <Icon name="logout" size={14} /> Sign out
          </button>
          )}
        </div>
      </header>

      {/* Body */}
      <div style={{ position: "relative", zIndex: 1, flex: 1, display: "flex", overflow: "hidden" }}>

        {/* Mobile drawer backdrop - tap to close (desktop: never rendered) */}
        {isMobile && sidebarOpen && (
          <div onClick={() => setSidebarOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 45, background: "rgba(0,0,0,0.34)" }} />
        )}

        {/* Sidebar */}
        {/* Desktop: fixed 260px column, in-flow. Mobile (isMobile): off-canvas drawer
            (position:fixed, slides in via translateX) toggled by the header hamburger. */}
        <aside style={isMobile ? {
          position: "fixed", top: 0, left: 0, bottom: 0, zIndex: 46, width: 260, maxWidth: "82vw",
          paddingTop: 65,   // starts below the app bar, which stays on top
          transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.28s ease",
          display: "flex", flexDirection: "column", overflow: "hidden",
          borderRight: "1px solid var(--rule)",
          background: "var(--paper)",
          boxShadow: sidebarOpen ? "2px 0 22px rgba(0,0,0,0.12)" : "none",   // no shadow sliver while closed
        } : {
          width: 260, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden",
          borderRight: "1px solid var(--rule)",
          background: "var(--paper)",
        }}>
          {/* Conversation history - the user's saved chats (Supabase, per-user, RLS). */}
          <div style={{ flex: 1, overflow: "auto", padding: "8px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 6px 8px" }}>
              <div style={{ fontSize: 12, color: C.mu, letterSpacing: "0.08em", fontFamily: "var(--sans)", fontWeight: 600 }}>CONVERSATIONS</div>
              {/* Matches the composer's "+ NEW": starts a fresh conversation and keeps the
                  profile. The profile is edited from the composer's Edit profile button. */}
              <button onClick={() => { startNewConversation(); setSidebarOpen(false); }} title="New question — clears this conversation (your profile stays)" style={{ fontSize: 13, fontWeight: 600, color: C.am, background: "none", border: "none", cursor: "pointer", fontFamily: "var(--sans)", opacity: 0.85, padding: "2px 4px", transition: "opacity 0.15s" }} onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")} onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.85")}>+ new</button>
            </div>

            {conversations.length === 0 ? (
              <div style={{ padding: "34px 14px", textAlign: "center", color: C.mu, fontSize: 13, lineHeight: 1.7 }}>
                <div style={{ marginBottom: 8, opacity: 0.45 }}><Icon name="chat" size={20} /></div>
                {NO_SIGN_IN ? <>Conversations are not saved<br />in this version.</> : <>No conversations yet.<br />Ask a question to start one.</>}
              </div>
            ) : (
              conversations.map((c, idx) => {
                const active = c.id === currentConvId;
                // Date groups (Today, Yesterday, ...) and two-line titles keep questions that start alike apart.
                const group = historyGroup(c.updated_at);
                const firstInGroup = idx === 0 || historyGroup(conversations[idx - 1].updated_at) !== group;
                const showDelete = isMobile || active || hoverConv === c.id;
                return (
                  <div key={c.id}>
                    {firstInGroup && (
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#54544e", fontFamily: "var(--sans)", padding: idx === 0 ? "4px 4px 7px" : "16px 4px 7px" }}>{group}</div>
                    )}
                  <div
                    onClick={() => { setSidebarOpen(false); void openConversation(c.id); }}
                    style={{
                      // One card per conversation; the open one uses the question card's tint.
                      position: "relative", borderRadius: 10, cursor: "pointer", marginBottom: 6,
                      padding: "10px 30px 10px 12px",
                      background: active ? "#edf3f8" : "#fff",
                      border: `1px solid ${active ? "#c5d6e4" : hoverConv === c.id ? "var(--rule-strong)" : "var(--rule)"}`,
                      boxShadow: hoverConv === c.id && !active ? "0 1px 3px rgba(0,0,0,0.05)" : "0 1px 1px rgba(0,0,0,0.02)",
                      transition: "border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease",
                    }}
                    onMouseEnter={() => setHoverConv(c.id)}
                    onMouseLeave={() => setHoverConv((h) => (h === c.id ? null : h))}
                  >
                    <div style={{
                      fontSize: 13.5, fontWeight: active ? 600 : 500, color: active ? C.am : C.tx, lineHeight: 1.38,
                      display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "break-word",
                    }}>{c.title || "Untitled"}</div>
                    <div style={{ fontSize: 12, color: C.mu, marginTop: 3, fontFamily: "var(--sans)", fontVariantNumeric: "tabular-nums" }}>{historyStamp(c.updated_at)}</div>
                    <button
                      onClick={(e) => { e.stopPropagation(); void removeConversation(c.id); }}
                      title="Delete conversation"
                      aria-label="Delete conversation"
                      onFocus={() => setHoverConv(c.id)}
                      onBlur={() => setHoverConv((h) => (h === c.id ? null : h))}
                      style={{ position: "absolute", top: 10, right: 7, background: "transparent", border: "none", borderRadius: 5, color: C.mu, cursor: "pointer", padding: 2, lineHeight: 0, opacity: showDelete ? 0.6 : 0, transition: "opacity 0.15s, color 0.15s" }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.color = "#b4453a"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.6"; e.currentTarget.style.color = C.mu; }}
                    ><Icon name="close" size={13} /></button>
                  </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        <div style={{ flex: 1, display: "flex", minWidth: 0, overflow: "hidden" }}>
        {/* Chat */}
        <main style={{
          flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0,
          background: "transparent",
          transition: "background 0.4s ease",
        }}>
          {/* Empty state: the greeting renders as a viewport-centered overlay
              (see the empty-state greeting block), so this stays a transparent spacer. */}
          {curMessages.length === 0 && (
            <div style={{ flex: 1 }} />
          )}

          {/* Messages scroll container */}
          {curMessages.length > 0 && (
          <div suppressHydrationWarning style={{ flex: 1, overflow: "auto", padding: isMobile ? "18px 13px" : "32px 28px" }}>
            <div style={{ maxWidth: 880, margin: "0 auto" }}>
            {curMessages.map((m) => (
              <div key={m.id} style={{ marginBottom: m.role === "user" ? 12 : 34, display: "flex", flexDirection: "column", alignItems: "stretch", animation: "msgIn 0.3s ease-out" }}>
                {/* Role marker - LEADS logo mark for responses, a person icon for user queries. */}
                <div style={{
                  display: "flex", alignItems: "center", gap: 7, marginBottom: 8,
                  flexDirection: "row",
                  fontFamily: "var(--sans)", fontSize: 12, letterSpacing: "0.08em", fontWeight: 600,
                  textTransform: "uppercase", color: C.mu,
                }}>
                  {m.role === "assistant"
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src="/leads-mark.png" alt="" aria-hidden width={20} height={20} style={{ display: "block", borderRadius: "50%" }} />
                    : <Icon name="user" size={15} />}
                  <span>{m.role === "assistant" ? "LEADS" : "You"}</span>
                </div>
                {m.role === "user" ? (
                  <div style={{
                    // The question card: a light blue tint with a hairline edge, distinct from
                    // the white answer and its sand "Operational check" box.
                    maxWidth: "100%",
                    background: "#edf3f8", border: "1px solid #d3e0eb", borderRadius: 14,
                    padding: isMobile ? "14px 16px" : "18px 24px 19px",
                    fontFamily: "var(--serif)", fontSize: isMobile ? 21 : 25, lineHeight: 1.32, fontWeight: 500,
                    letterSpacing: "-0.01em", color: "#13263a",
                  }}>{m.content}</div>
                ) : (
                  <div style={{
                    width: "100%", background: "var(--surface)", border: "1px solid var(--rule)", borderRadius: 14,
                    padding: isMobile ? "18px 16px" : "24px 28px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                  }}>
                    {/* Response text (report body) */}
                    <div style={{
                      padding: 0,
                      // The answer sits directly on the white report sheet.
                      background: "transparent",
                      fontSize: 16.5, lineHeight: 1.7, fontWeight: 450, color: C.tx,
                      position: "relative",
                    }}>

                      {m.streaming && !m.content && (
                        <div style={{ display: "flex", gap: 6, padding: "6px 0", alignItems: "center" }}>
                          {[0,1,2].map((j) => <div key={j} style={{ width: 7, height: 7, borderRadius: "50%", background: C.am, animation: `pulse 1s ${j * 0.25}s infinite` }} />)}
                        </div>
                      )}
                      <AnswerText text={citationView(m).text} streaming={m.streaming} scopeNote={buildCheckScopeLine(m.pipeline)} onCitationClick={(n) => curHandleCitationClick(m.id, n)} />
                      {m.streaming && m.content && (
                        <span style={{ display: "inline-block", width: 9, height: 15, background: C.am, marginLeft: 3, verticalAlign: "middle", animation: "pulse 0.7s infinite", borderRadius: 1 }} />
                      )}
                    </div>

                    {/* This answer's chart; nothing renders without chart data. */}
                    {!m.streaming && m.chart && (m.chart.loading || (m.chart.sensor?.length ?? 0) > 0 || (m.chart.forecast?.length ?? 0) > 0 || (m.chart.depthSeries?.length ?? 0) > 0) && (
                      <InsightPanel
                        captureId={m.id}
                        variableLabel={m.chart.label}
                        units={m.chart.units}
                        site={m.chart.site}
                        variableKey={m.reproduce?.variable}
                        forecastHorizon={m.reproduce?.horizon}
                        skillHorizon={m.chart.questionHorizon ?? m.reproduce?.horizon}
                        loading={m.chart.loading}
                        sensor={m.chart.sensor}
                        forecast={m.chart.forecast}
                        climatology={m.chart.climatology}
                        depthM={m.chart.depthM}
                        threshold={m.chart.threshold}
                        depthSeries={m.chart.depthSeries}
                        windowDays={m.reproduce?.days}
                      />
                    )}

                    {/* Banner when the profile and the question disagree. The profile still governs the answer; the button opens the profile. */}
                    {!m.streaming && m.alignment && !m.alignment.aligned && (() => {
                      const a = m.alignment;
                      const hard = a.severity === "hard";
                      const amber = hard ? "#B45309" : "#92700A";
                      const amberBg = hard ? "rgba(217,119,6,0.10)" : "rgba(202,138,4,0.08)";
                      const amberBd = hard ? "rgba(217,119,6,0.35)" : "rgba(202,138,4,0.30)";
                      return (
                        <div style={{
                          marginTop: 16, padding: "10px 13px", borderRadius: 10,
                          background: amberBg, border: `1px solid ${amberBd}`,
                          display: "flex", alignItems: "flex-start", gap: 9,
                          fontFamily: "var(--sans)", fontSize: 13.5, lineHeight: 1.5, color: amber,
                        }}>
                          <Icon name="alert" size={16} style={{ marginTop: 1 }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 12, marginBottom: 2 }}>
                              {a.dimensions.includes("mode") ? "No guardrail enforced" : `Profile mismatch · ${a.severity}`}
                            </div>
                            <div>{a.rationale}</div>
                          </div>
                          <button
                            onClick={() => setProfilePanelOpen(true)}
                            style={{
                              flexShrink: 0, alignSelf: "center", cursor: "pointer",
                              fontFamily: "var(--sans)", fontSize: 12, fontWeight: 600, letterSpacing: "0.04em",
                              color: amber, background: "transparent", border: `1px solid ${amberBd}`,
                              borderRadius: 7, padding: "5px 10px",
                            }}
                          >
                            {a.suggestedDecision ? "RE-ROUTE →" : "EDIT PROFILE →"}
                          </button>
                        </div>
                      );
                    })()}

                    {/* Trust Score badge - per-answer C_LEADS composite (G+V+P+Y)/4 − 0.05·iter.
                        The headline number is `overall`. The field is named `confidence`
                        in code (following Hu et al., 2025) but labelled "Trust score"
                        here because it audits the answer rather than estimating model belief. */}
                    {!m.streaming && m.confidence && (() => {
                      const c = m.confidence;
                      const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
                      // No claim-checker result: B and F would come from the word-overlap
                      // fallback, so no score is shown (empty ring, "Not given").
                      const unchecked = claimCheckMissing(m.claims);
                      // Color the overall ring by trust band.
                      const overall = unchecked ? 0 : c.overall;
                      const ringColor =
                        overall >= 0.85 ? "#3f7d54" :
                        overall >= 0.70 ? "#a86b12" :
                                          "#b4453a";
                      return (
                        <>
                        <div style={{
                          marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--rule)", marginBottom: 2,
                          display: "flex", alignItems: "center", gap: 14,
                        }}>
                          {/* Headline */}
                          <div title="Answer quality" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{
                              width: 36, height: 36, borderRadius: "50%",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              background: `conic-gradient(${ringColor} ${overall * 360}deg, #ECEAE4 0)`,
                            }}>
                              <div style={{
                                width: 28, height: 28, borderRadius: "50%",
                                background: "white",
                                display: "flex", alignItems: "center", justifyContent: "center",
                                fontFamily: "var(--sans)", fontSize: 12, fontWeight: 600,
                                color: "#1a1a18", fontVariantNumeric: "tabular-nums",
                              }}>
                                {unchecked ? "–" : (overall * 100).toFixed(0)}
                              </div>
                            </div>
                            <div>
                              <div style={{
                                fontSize: 12, letterSpacing: "0.08em", color: "var(--muted)", fontFamily: "var(--sans)", fontWeight: 600, marginBottom: 3,
                              }}>
                                TRUST SCORE
                              </div>
                              <div style={{
                                fontFamily: "var(--serif)", fontSize: 22, fontWeight: 500,
                                color: "#1a1a18", lineHeight: 1, fontVariantNumeric: "tabular-nums",
                              }}>
                                {unchecked ? "Not given" : pct(overall)}
                              </div>
                            </div>
                          </div>
                          {/* Alignment chip: whether the profile and the question agree; not part of the trust score. */}
                          {m.alignment && (
                            <span
                              title={`Question fit — ${m.alignment.rationale}`}
                              style={{
                                display: "inline-flex", alignItems: "center", gap: 4,
                                padding: "4px 9px", borderRadius: 20, marginLeft: 4,
                                fontFamily: "var(--sans)", fontSize: 12, fontWeight: 600, letterSpacing: "0.06em",
                                color: m.alignment.aligned ? "#3f7d54" : "#a86b12",
                                background: m.alignment.aligned ? "rgba(63,125,84,0.09)" : "rgba(168,107,18,0.10)",
                                border: "none",
                                cursor: "default",
                              }}
                            >
                              <Icon name={m.alignment.aligned ? "check" : "alert"} size={12} stroke={2} /> {m.alignment.aligned ? "ALIGNED" : `MISMATCH·${m.alignment.severity.toUpperCase()}`}
                            </span>
                          )}
                          {/* "How is this calculated?" toggle: the formula and the four checks. */}
                          <button
                            type="button"
                            onClick={() => setOpenTrust((o) => ({ ...o, [m.id]: !o[m.id] }))}
                            aria-expanded={!!openTrust[m.id]}
                            aria-label="How the trust score is calculated"
                            title="How is this calculated?"
                            style={{
                              marginLeft: "auto", alignSelf: "center", flex: "none",
                              width: 26, height: 26, borderRadius: "50%",
                              border: "none", background: openTrust[m.id] ? "var(--brand-soft)" : "transparent",
                              color: openTrust[m.id] ? C.am : "#54544e",
                              lineHeight: 0, padding: 0, cursor: "pointer",
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}
                          >
                            <Icon name="info" size={18} />
                          </button>
                        </div>
                        {unchecked && (
                          <div style={{ marginTop: 8, fontSize: 12.5, color: "#54544e", lineHeight: 1.5 }}>
                            {CLAIM_CHECK_MISSING_NOTE}
                          </div>
                        )}
                        {openTrust[m.id] && (
                          <div style={{ marginTop: 12, marginBottom: 2, padding: "14px 16px", background: "var(--paper)", border: "none", borderRadius: 10 }}>
                            <div style={{ fontSize: 12, letterSpacing: "0.08em", color: "var(--muted)", fontFamily: "var(--sans)", fontWeight: 600, textTransform: "uppercase", marginBottom: 8 }}>
                              How the trust score is calculated
                            </div>
                            <div style={{ fontSize: 13, color: "#44443e", lineHeight: 1.6, marginBottom: 11 }}>
                              The average of four checks on this answer, minus a small penalty if the answer needed extra refinement. It measures how well-grounded and self-consistent the answer is — <b>not</b> whether the real-world outcome will happen.
                            </div>
                            {/* The equation in symbols, not per-metric values; the letters map
                                to the plain-English checks listed below. */}
                            <div style={{
                              fontFamily: "var(--mono)", fontSize: 13.5, color: "#1a1a18",
                              background: "#fff", border: "1px solid var(--rule)", borderRadius: 8,
                              padding: "10px 12px", marginBottom: 12, overflowX: "auto", whiteSpace: "nowrap",
                            }}>
                              (B + F + R + D) ÷ 4{c.iterations > 0 ? ` − 0.05 × ${c.iterations}` : ""}
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                              {([
                                ["B", "Backed by evidence", "Is every statement backed by the evidence shown?"],
                                ["F", "Fact-check strength", "How sure was the fact-checker about each statement?"],
                                ["R", "Follows your rules", "Did the answer follow your reservoir's decision rules?"],
                                ["D", "Data sources complete", "Did every data source actually report in?"],
                              ] as [string, string, string][]).map(([letter, lab, why]) => (
                                <div key={letter} style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                                  <span style={{ width: 14, flexShrink: 0, fontSize: 13.5, fontWeight: 600, fontFamily: "var(--mono)", color: "#3f7d54" }}>{letter}</span>
                                  <span style={{ width: 148, flexShrink: 0, fontSize: 12.5, color: "#1a1a18", fontWeight: 600 }}>{lab}</span>
                                  <span style={{ flex: 1, minWidth: 180, fontSize: 12.5, color: "#46463f", lineHeight: 1.45 }}>{why}</span>
                                </div>
                              ))}
                            </div>
                            {/* The penalty term; shown only after an extra attempt. */}
                            {c.iterations > 0 && (
                              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginTop: 11, paddingTop: 10, borderTop: "1px solid var(--rule)" }}>
                                <span style={{ width: 14, flexShrink: 0, fontSize: 13.5, fontWeight: 600, fontFamily: "var(--mono)", color: "#a86b12" }}>{c.iterations}</span>
                                <span style={{ width: 148, flexShrink: 0, fontSize: 12.5, color: "#1a1a18", fontWeight: 600 }}>{c.iterations === 1 ? "Search reworked once" : `Search reworked ${c.iterations}×`}</span>
                                <span style={{ flex: 1, minWidth: 180, fontSize: 12.5, color: "#46463f", lineHeight: 1.45 }}>
                                  The first attempt found too little evidence, or the claim check could not support some statements, so LEADS searched again and rewrote the answer. Each rework subtracts 0.05, so an answer that needed a second look scores slightly lower than one that didn&apos;t.
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                        </>
                      );
                    })()}

                    {/* Evidence panel */}
                    {!m.streaming && m.citations && m.citations.length > 0 && (() => {
                      // m.citations is the full fused evidence packet: every item carries
                      // the pipeline's bracketNum and a citedInAnswer flag. A card is shown
                      // for every source the answer cites, which is the union of
                      //   (a) the answer's [N] markers, single or comma-grouped;
                      //   (b) the citedInAnswer flag set by the generator;
                      //   (c) the brackets the per-claim verifier matched to evidence -
                      //       the model does not always write inline markers (bullet
                      //       sections often omit them), and without these the panel
                      //       would be empty although claims were attributed.
                      // citationView(m) computes that set and numbers it 1..n in the order
                      // the answer cites it, so every chip in the answer scrolls to the
                      // card with the same number. Cards are listed in that order.
                      // The message keeps the two signals separately (citedInAnswer and claim.bracketNum).
                      const visible = citationView(m).cited.map(({ citation: c, n }) => ({ c, n }));
                      if (!visible.length) return null;
                      // The list follows the citation order, so the best relevance is the
                      // maximum rather than the first card's score.
                      const scores = visible.map(({ c }) => c.rerankScore).filter((v): v is number => typeof v === "number");
                      const topScore = scores.length ? Math.max(...scores) : null;
                      // Same note the PDF prints under its literature list: shown only when
                      // every literature card's excerpt is a verbatim quotation.
                      const excerptNote = literatureExcerptNote(visible.map(({ c }) => c as Citation & { verbatim?: boolean }));
                      return (
                        <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--rule)" }}>
                          {/* Summary bar */}
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: openEvidence[m.id] ? 12 : 0 }}>
                            <div style={{ fontSize: 12, letterSpacing: "0.08em", color: "var(--muted)", fontFamily: "var(--sans)", fontWeight: 600 }}>
                              EVIDENCE · {visible.length} sources
                            </div>
                            {topScore != null && (
                              <span style={{ fontSize: 12, fontWeight: 500, color: "#2c6a41", fontFamily: "var(--sans)", background: "rgba(63,125,84,0.09)", padding: "3px 9px", borderRadius: 20, border: "none", fontVariantNumeric: "tabular-nums" }}>
                                top {Math.min(100, Math.round(topScore * 100))}% relevance
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => setOpenEvidence((o) => ({ ...o, [m.id]: !o[m.id] }))}
                              style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontSize: 13.5, fontWeight: 500, fontFamily: "var(--sans)", color: C.am, display: "inline-flex", alignItems: "center", gap: 4 }}
                            >
                              {openEvidence[m.id] ? <>Hide <Icon name="chevronUp" size={14} /></> : <>Show sources <Icon name="chevronDown" size={14} /></>}
                            </button>
                          </div>
                          {/* Cards */}
                          {openEvidence[m.id] && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {visible.map(({ c, n }) => {
                              const key = `${m.id}-${n}`;
                              return (
                                <div key={n} ref={(el) => { curCitationRefs.current[key] = el; }}>
                                  <CitationCard n={n} text={readerText(c.text)} docName={c.docName} chunkIndex={c.chunkIndex}
                                    pageNum={(c as Citation).pageNum} rerankScore={(c as Citation).rerankScore}
                                    method={(c as Citation).method}
                                    sourceType={(c as Citation & { sourceType?: "literature" | "sensor" | "forecast" }).sourceType}
                                    highlighted={curHighlightedCitation?.msgId === m.id && curHighlightedCitation?.n === n}
                                  />
                                </div>
                              );
                            })}
                            {excerptNote && (
                              <div style={{ fontSize: 12.5, color: "#54544e", lineHeight: 1.5, marginTop: 2 }}>
                                {excerptNote}
                              </div>
                            )}
                          </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Per-Claim Faithfulness Verification */}
                    {m.claims && m.claims.length > 0 && (() => {
                      const supported = m.claims.filter((c) => c.supported).length;
                      const total = m.claims.length;
                      const pct = Math.round((supported / total) * 100);
                      // Word-overlap fallback claims (claim checker gave no result): "not checked".
                      const unchecked = claimCheckMissing(m.claims);
                      const color = unchecked ? "#54544e" : pct >= 80 ? C.gr : pct >= 50 ? "#a86b12" : "#b4453a";
                      // Same display numbering as the answer and the evidence cards.
                      const view = citationView(m);
                      return (
                        <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--rule)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: openClaims[m.id] ? 12 : 0 }}>
                            <span style={{ fontSize: 12, letterSpacing: "0.08em", color: "var(--muted)", fontFamily: "var(--sans)", fontWeight: 600 }}>CLAIM VERIFICATION</span>
                            <span style={{ fontSize: 12, fontWeight: 500, fontFamily: "var(--sans)", color, background: `${color}17`, border: "none", padding: "3px 9px", borderRadius: 20, fontVariantNumeric: "tabular-nums" }}>
                              {unchecked ? "not checked" : `${supported}/${total} verified · ${pct}%`}
                            </span>
                            <button
                              type="button"
                              onClick={() => setOpenClaims((o) => ({ ...o, [m.id]: !o[m.id] }))}
                              style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontSize: 13.5, fontWeight: 500, fontFamily: "var(--sans)", color: C.am, display: "inline-flex", alignItems: "center", gap: 4 }}
                            >
                              {openClaims[m.id] ? <>Hide details <Icon name="chevronUp" size={14} /></> : <>Show details <Icon name="chevronDown" size={14} /></>}
                            </button>
                          </div>
                          {openClaims[m.id] && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                            {unchecked && (
                              <div style={{ fontSize: 12.5, color: "#54544e", lineHeight: 1.5, marginBottom: 4 }}>
                                {CLAIM_CHECK_MISSING_NOTE} Each sentence below was only matched to the evidence by shared words.
                              </div>
                            )}
                            {m.claims.map((claim, ci) => (
                              <div key={ci} style={{
                                display: "flex", alignItems: "flex-start", gap: 9, padding: "7px 10px", borderRadius: 8,
                                background: claim.supported ? "transparent" : "rgba(180,69,58,0.06)",
                                border: "none",
                              }}>
                                <span style={{ flexShrink: 0, marginTop: 2, lineHeight: 0, color: claim.supported ? "#3f7d54" : "#b4453a" }}>
                                  <Icon name={claim.supported ? "check" : "x"} size={15} stroke={2} />
                                </span>
                                <span style={{ fontSize: 14, color: C.tx, lineHeight: 1.6 }}>
                                  {view.rewrite(claim.text)}
                                  {/* Prefer the global bracketNum (aligned
                                      with the answer's [N] markers and the
                                      evidence cards), shown as its display
                                      number. Fall back to the verifier-local
                                      sourceIndex+1 only if bracketNum is
                                      absent. */}
                                  {(claim.bracketNum != null || claim.sourceIndex != null) && (
                                    <span style={{ fontSize: 12, color: C.am, fontFamily: "var(--sans)", fontWeight: 600, marginLeft: 5 }}>
                                      [{claim.bracketNum != null ? (view.displayNumber(claim.bracketNum) ?? claim.bracketNum) : claim.sourceIndex! + 1}]
                                    </span>
                                  )}
                                </span>
                              </div>
                            ))}
                          </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* R and Python code that fetches the public VERA/FLARE data behind this answer; shown only when the chart has data. */}
                    {!m.streaming && m.reproduce && m.chart && !m.chart.loading &&
                      (((m.chart.sensor?.length ?? 0) > 0) || ((m.chart.forecast?.length ?? 0) > 0)) && (
                      <ReproducePanel params={m.reproduce} />
                    )}

                    {/* Download decision report (PDF), built client-side from this answer's
                        existing data; it does not call the pipeline. */}
                    {!m.streaming && m.role === "assistant" && m.content && (() => {
                      const prevUser = curMessages.find((x) => x.id === m.id - 1 && x.role === "user");
                      return (
                        <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--rule)" }}>
                          <div style={{ fontSize: 12, letterSpacing: "0.08em", color: "var(--muted)", fontFamily: "var(--sans)", fontWeight: 600, marginBottom: 10 }}>
                            DECISION RECORD
                          </div>
                          {/* The report header is built from the message (its stored profile,
                              its chart's site and depth). The live profile below is only the
                              fallback when a message carries no stored profile. */}
                          <DecisionReportButton
                            message={m}
                            question={prevUser?.content ?? ""}
                            profile={profile ? { persona: profile.persona, reservoir: profile.reservoir, decision: profile.decision } : null}
                          />
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            ))}
            <div ref={curEndRef} />
            </div>
          </div>
          )}

          {/* Question box */}
          {(() => {
            // One accent palette for the query console.
            const accentColor = C.am;
            const borderIdle  = "var(--rule-strong)";
            const hasCorpus   = docs.length > 0 || NO_SIGN_IN;
            const isReady     = hasCorpus && !!profile;
            const canSend     = isReady && !curBusy && !!curInput.trim();
            const decisionLabel = profile
              ? (profile.decision === "none" ? "Informational" : getGuardrail(profile.reservoir, profile.decision).label)
              : null;
            // In informational mode depth is not pinned - it's read from the
            // question (numeric "at 9 m" or zone words like "hypolimnion"),
            // defaulting to surface only if the question is depth-silent.
            const depthLabel = profile
              ? (profile.decision === "none" ? "depth from question" : profile.depth)
              : null;


            return (
              <div style={{
                flexShrink: 0, position: "relative",
                backgroundColor: "var(--paper)",
              }}>
                <div style={{ padding: isMobile ? "8px 12px 10px" : "12px 28px 14px", position: "relative", zIndex: 1, maxWidth: 936, margin: "0 auto", width: "100%" }}>
                  {/* Profile bar (Step 1), shown until a profile is set. After that the profile appears in the question box placeholder ("Query as manager · Algal management · FCR / epilimnion") and the Edit profile button reopens this panel. */}
                  {!profile && (
                  <div style={{ marginBottom: 8 }} suppressHydrationWarning>
                    <button
                      type="button"
                      onClick={() => setProfilePanelOpen(true)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "10px 14px",
                        background: "rgba(168,107,18,0.07)",
                        border: "1px solid rgba(168,107,18,0.30)",
                        borderRadius: 12,
                        cursor: "pointer",
                        fontFamily: "var(--sans)",
                        color: C.tx,
                        textAlign: "left",
                      }}
                      title="Click to set your LEADS profile (required to query)"
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        {/* Status light - always "awaiting setup" here, since this bar
                            only renders before a profile exists. */}
                        <span title="Awaiting setup" style={{ position: "relative", width: 8, height: 8, flexShrink: 0, display: "inline-block" }}>
                          <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: C.mu, opacity: 0.3, transform: "scale(2)" }} />
                          <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: C.mu }} />
                        </span>
                        <span style={{ fontSize: 12, color: "#a86b12", letterSpacing: "0.08em", fontWeight: 600 }}>
                          LEADS PROFILE · STEP 1 — required
                        </span>
                        <span style={{ fontSize: 14, color: "#8a5a10", fontWeight: 500 }}>
                          Click to set Persona / Reservoir / Decision before querying →
                        </span>
                      </span>
                      <span style={{ fontSize: 13, color: C.mu }}>open ↗</span>
                    </button>
                  </div>
                  )}

                  {/* Input row */}
                  <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                    <div style={{
                      flex: 1, position: "relative", borderRadius: 14,
                      background: "#fff",
                      border: `1px solid ${borderIdle}`,
                      boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                      transition: "border-color 0.15s ease, box-shadow 0.15s ease",
                    }}>
                      <textarea
                        value={curInput}
                        onChange={(e) => curSetInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); curSend(); } }}
                        placeholder={
                          !hasCorpus ? "Corpus not loaded — check ingestion pipeline"
                          : !profile ? "Set your LEADS profile above to query…"
                          : `Query as ${profile.persona} · ${decisionLabel} · ${profile.reservoir.toUpperCase()} / ${depthLabel}  ⏎`
                        }
                        disabled={!isReady || curBusy}
                        rows={1}
                        style={{
                          width: "100%", background: "transparent", border: "none", outline: "none",
                          borderRadius: 14, padding: "13px 16px",
                          color: "#1a1a18", fontSize: isMobile ? 16 : 14.5, lineHeight: 1.5,
                          resize: "none", fontFamily: "inherit",
                          opacity: !isReady ? 0.35 : 1,
                          caretColor: accentColor,
                        }}
                        onFocus={(e) => {
                          const wrap = e.target.parentElement as HTMLDivElement;
                          wrap.style.borderColor = accentColor;
                          wrap.style.boxShadow = `0 0 0 3px ${accentColor}1f`;
                        }}
                        onBlur={(e) => {
                          const wrap = e.target.parentElement as HTMLDivElement;
                          wrap.style.borderColor = borderIdle;
                          wrap.style.boxShadow = "0 1px 2px rgba(0,0,0,0.04)";
                        }}
                      />
                    </div>

                    {/* Edit profile - re-opens the same Step-1 panel without touching the
                        transcript (unlike "+ NEW", which starts a fresh conversation). Shown
                        on mobile too: it is the only non-destructive way back into the profile. */}
                    {profile && (
                    <button
                      onClick={() => setProfilePanelOpen(true)}
                      aria-label="Edit LEADS profile"
                      title={`Edit profile — ${profile.persona === "manager" ? "Manager" : profile.persona === "researcher" ? "Researcher" : "Public"} · ${profile.reservoir.toUpperCase()} / ${depthLabel} · ${decisionLabel}`}
                      style={{
                        position: "relative", flexShrink: 0, height: 48,
                        ...(isMobile ? { width: 48 } : { padding: "0 14px" }),
                        borderRadius: 14,
                        background: "#fff",
                        border: "1px solid var(--rule-strong)", cursor: "pointer",
                        color: "#1a1a18", fontSize: isMobile ? 17 : 12.5, fontWeight: isMobile ? 400 : 600,
                        fontFamily: "var(--sans)", letterSpacing: isMobile ? "normal" : "0.06em",
                        whiteSpace: "nowrap",
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 6, transition: "all 0.15s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.am; e.currentTarget.style.boxShadow = "none"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--rule-strong)"; e.currentTarget.style.boxShadow = "none"; }}
                    >
                      {/* Desktop shows the words; mobile shows the icon only (at a larger
                          size, full 48px touch target) because the composer row has no width
                          to spare there. The aria-label carries the meaning for screen readers. */}
                      {isMobile ? <Icon name="edit" size={19} /> : <><Icon name="edit" size={15} /> EDIT PROFILE</>}
                    </button>
                    )}

                    {/* New question - clears the transcript and keeps the current profile;
                        the profile is changed with the Edit profile button beside it. Hidden
                        on mobile (redundant with the drawer's "+ new") to free up input width. */}
                    {!isMobile && (
                    <button
                      onClick={() => startNewConversation()}
                      title="New question — clears this conversation (your profile stays; use Edit profile to change it)"
                      style={{
                        position: "relative", flexShrink: 0, height: 48, borderRadius: 14, padding: "0 14px",
                        background: "#fff",
                        border: "1px solid var(--rule-strong)", cursor: "pointer",
                        color: "#1a1a18", fontSize: 12.5, fontWeight: 600, fontFamily: "var(--sans)",
                        letterSpacing: "0.06em", whiteSpace: "nowrap", transition: "all 0.15s",
                        display: "flex", alignItems: "center", gap: 5,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.am; e.currentTarget.style.boxShadow = "none"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--rule-strong)"; e.currentTarget.style.boxShadow = "none"; }}
                    ><Icon name="plus" size={15} /> NEW</button>
                    )}

                    {/* Send button */}
                    <button
                      onClick={curSend}
                      disabled={!canSend}
                      aria-label="Send"
                      style={{
                        position: "relative", flexShrink: 0, width: 48, height: 48, borderRadius: 14,
                        background: canSend ? C.am : "rgba(120,113,108,0.10)",
                        border: `1px solid ${canSend ? C.am : "transparent"}`,
                        cursor: !canSend ? "not-allowed" : "pointer",
                        color: canSend ? "#fff" : C.mu,
                        fontSize: 18, fontWeight: 700,
                        transition: "all 0.15s ease",
                        boxShadow: "none",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                      onMouseEnter={(e) => { if (canSend) e.currentTarget.style.background = "#013456"; }}
                      onMouseLeave={(e) => { if (canSend) e.currentTarget.style.background = C.am; }}
                    >
                      {curBusy ? (
                        <div style={{ display: "flex", gap: 2 }}>
                          {[0,1,2].map(j => <div key={j} style={{ width: 4, height: 4, borderRadius: "50%", background: C.mu, animation: `pulse 0.8s ${j*0.15}s infinite` }} />)}
                        </div>
                      ) : <Icon name="arrowUp" size={19} stroke={2} />}
                    </button>
                  </div>

                  {/* AI-content disclaimer - persistent footer beneath the composer */}
                  <div style={{
                    margin: "10px auto 0", maxWidth: 640, textAlign: "center",
                    fontSize: 12, lineHeight: 1.5, color: "#6b6b64",
                    fontFamily: "var(--sans)", letterSpacing: "0",
                  }}>
                    This is an experimental AI research tool for decision support, provided “as is” without warranty. Its forecasts and recommendations are inherently uncertain and may be inaccurate; evaluate them and apply your own expert judgment before acting.
                  </div>

                </div>
              </div>
            );
          })()}
        </main>

        </div>
      </div>


      {/* Pipeline drawer: after a question, a round button on the right edge opens the pipeline steps; a dot on it pulses while the question runs. Hidden again on a new conversation. */}
      {showPipe && (
        <button
          type="button"
          onClick={() => setPipeDrawerOpen((v) => !v)}
          title="RAG pipeline — see how this answer was built"
          aria-label="Toggle pipeline diagnostics"
          style={{
            position: "fixed", top: "50%", right: pipeDrawerOpen ? 336 : 16,
            transform: "translateY(-50%)", zIndex: 60,
            width: 44, height: 44, borderRadius: "50%",
            background: C.am, color: "#fff", border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 14px rgba(2,67,110,0.22)", transition: "right 0.28s ease",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
            <line x1="5" y1="7" x2="19" y2="7" />
            <line x1="5" y1="12" x2="15" y2="12" />
            <line x1="5" y1="17" x2="11" y2="17" />
          </svg>
          {busy && (
            <span style={{ position: "absolute", top: 5, right: 5, width: 9, height: 9, borderRadius: "50%", background: C.gr, border: `2px solid ${C.am}`, animation: "pulse 1.2s ease-in-out infinite" }} />
          )}
        </button>
      )}
      {showPipe && pipeDrawerOpen && (
        <div
          style={{
            position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 55,
            width: 320, maxWidth: "88vw",
            background: "#fff",
            borderLeft: "1px solid var(--rule)",
            boxShadow: "-8px 0 30px rgba(0,0,0,0.08)",
            display: "flex", flexDirection: "column",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid var(--rule)" }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 500, color: C.tx, fontFamily: "var(--serif)" }}>RAG pipeline</div>
              <div style={{ fontSize: 12, color: C.mu, fontFamily: "var(--sans)", fontWeight: 500, letterSpacing: "0.06em", marginTop: 2 }}>UNDER THE HOOD · RETRIEVAL &amp; GUARDRAILS</div>
            </div>
            <button onClick={() => setPipeDrawerOpen(false)} title="Close" aria-label="Close" style={{ background: "none", border: "none", color: C.mu, cursor: "pointer", lineHeight: 0, padding: 4 }}><Icon name="close" size={16} /></button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            <PipelinePanel steps={pipeSteps} />
          </div>
        </div>
      )}

      {/* LEADS profile modal overlay - sits above the pinned console layout so the
          panel always has room to scroll, and Confirm is reachable on any viewport */}
      {profilePanelOpen && (
        <div
          suppressHydrationWarning
          onClick={() => { if (profile) setProfilePanelOpen(false); }}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(26,26,24,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxHeight: "90vh", overflowY: "auto",
              background: "white", borderRadius: 14,
              boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
              width: "100%", maxWidth: 760,
            }}
          >
            {profile && (
              <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 14px 0" }}>
                <button
                  type="button"
                  onClick={() => setProfilePanelOpen(false)}
                  style={{ background: "none", border: "none", color: "#54544e", cursor: "pointer", fontSize: 13.5, fontFamily: "var(--sans)", display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  <Icon name="close" size={14} /> close
                </button>
              </div>
            )}
            <div style={{ padding: 14 }}>
              <UserProfilePanel
                initial={profile ?? undefined}
                onConfirm={(p) => {
                  setProfile(p);
                  setProfilePanelOpen(false);
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
