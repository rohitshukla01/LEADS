"""Figs 7 and 8: LEADS's response to the algal-bloom question of 3 May 2026 and to the hypoxia question of 4 April 2026,
drawn from leads_response.json in the case folder.

(a) The question with the user's profile, and the answer as the LEADS interface displays it: the sources renumbered and
    the text tidied as tool/app/page.tsx does (citationView: tool/lib/citation-display.ts, then tool/lib/answer-tidy.ts),
    and the markdown laid out as tool/components/AnswerText.tsx lays it out.
(b) The chart data: the observations of the 7 days before the case date, the 7-day FLARE forecast (mean and 10th-90th
    percentile band), the threshold and the seasonal mean; the day-7 outlook; the forecast-skill card.
(c) The cited sources as the evidence list of the interface shows them (tool/app/page.tsx and
    tool/components/CitationCard.tsx): number, title and evidence group, named and coloured as in Fig. 5b.

Before drawing, the script stops with an error unless the files in inputs/ are the ones the response read (SHA-256),
the observations are the sensor file's readings, the seasonal mean is recomputed from the sensor file, the forecast mean,
band and member counts are recomputed from the 221 members, the skill card is the skill record in inputs/, and the
banner's numbers are the chart data's.

Text is set by fixed rules: lines break at spaces only; characters advance in whole units of 1/576 inch,
without kerning; a line is the line spacing rounded to whole points high, with its baseline 0.8 of that height below
its top; baselines lie on a 300 dpi pixel grid. Needs Arial; without it the figure is drawn in DejaVu Sans.

Written in the code are only the layout (positions, sizes, colours, fonts and the user pictogram) and generic labels:
the panel letters, 'User', 'LEADS', the variable names and units, and the labels of the chart, outlook, skill card
and evidence list.

Reads only files in the case folder, images/leads_mark.png next to this file and the evidence groups of Fig. 5b
(../benchmark/common.py). Run make_figure7.py or make_figure8.py
in the case folder.
"""
import csv
import gzip
import hashlib
import json
import math
import re
import sys
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
matplotlib.rcdefaults()   # ignore any personal matplotlibrc, so local matplotlib settings cannot change the figure
import matplotlib.image as mpimg
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager
from matplotlib.font_manager import FontProperties
from matplotlib.ft2font import FT2Font, Kerning, LoadFlags
from matplotlib.lines import Line2D
from matplotlib.patches import Ellipse, FancyBboxPatch, PathPatch, Polygon, Rectangle
from matplotlib.path import Path as MPath
from matplotlib.textpath import TextPath
from matplotlib.transforms import Affine2D
from PIL import ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "benchmark"))
from common import channel  # noqa: E402  (the evidence groups of Fig. 5b)

HERE = Path(__file__).resolve().parent

try:   # the figures use Arial; without it the text is drawn in DejaVu Sans
    font_manager.findfont(FontProperties(family="Arial"), fallback_to_default=False)
    FAMILY = "Arial"
except ValueError:
    FAMILY = "DejaVu Sans"
plt.rcParams.update({
    "font.family": FAMILY,
    "pdf.fonttype": 42, "ps.fonttype": 42, "svg.fonttype": "none", "svg.hashsalt": "leads",
})

# ---------------- layout constants (millimetres and points)
DPI = 300                                # 300 dpi PNG
PX = 25.4 / DPI                          # one pixel (mm)
UNIT = 25.4 / 576                        # characters advance in whole units of 1/576 inch
PT_MM = 25.4 / 72                        # one point (mm)
PT = dict(letter=8, meta=7, question=7, answer=7, small=6, eyebrow=6, value=9)   # text sizes (points)
PLOT_H, SKILL_H, GAP = 42.0, 24.0, 5.0   # chart and skill-plot heights, gap between panels
XR = 183.0                               # figure width (double column)
LE, AVC, AVV, PAD = 4.5, 10.5, 7.6, 2.5  # left edge, avatar column, avatar width, frame padding
CX0, CX1 = LE + PAD, XR - PAD            # column edges of every panel
LS_RENDER = 0.96                         # box heights allow 0.96 of the nominal line spacing per line
PAGE_X, PAGE_Y = 0.2154, 0.7497          # the drawing's top-left corner on the page
GRID_TOP = 13.7                          # offset of the 300 dpi grid that holds the baselines
PAGE_W = 2140                            # page width (pixels at 300 dpi)
PAGE_BOTTOM = 1.88                       # page bottom below the centre of the last source line
PX_PT = 1 / 3                            # the interface's margins (px) in points: a 12 px paragraph gap is 4 pt
INDENT = 22 / 16.5 * PT["answer"] * PT_MM   # list indent: 22 px for 16.5 px text in the interface
BULLET = 2.2                             # list bullet: its left edge this far (mm) before the item's text

INK, MUTED, RULE, WHITE = "#1A1A1A", "#5A5A5A", "#C8C8C8", "#FFFFFF"
CASE_FILL, CASE_LINE = "#F6F1E7", "#D6C8AB"   # question card
BAN_FILL, BAN_LINE = "#F2F2F2", "#C4C4C4"     # operational-check banner
FRAME = "#C4C4C4"                             # answer frame
BLUE, BAND, VERMILLION = "#0072B2", "#DDE0E3", "#D55E00"
SEAS, DIVIDER = "#4E8B5A", "#33332F"          # seasonal mean; latest-observation line
RISK, SAFE = "#B4453A", "#2F6EB5"             # outlook value on the risky or the safe side of the threshold
TABLE_RULE = "#464642"
SK_INK, SK_MUTED, SK_CI, SK_LESS, SK_TICK, SK_ZERO = "#1A1A18", "#54544E", "#8F8B81", "#77736C", "#33332F", "#8D8D8C"
GROUP = {"sensor": ("Sensor", "#009E73"), "forecast": ("Ensemble forecast (FLARE)", "#E69F00"),
         "tool_output": ("Tool outputs", "#CC79A7"), "literature": ("Literature", "#0072B2")}   # names and colours of Fig. 5b
CATEGORY = {g: colour for g, (_, colour) in GROUP.items()}   # a source's badge and markers, by its evidence group

# the user pictogram in panel a, in a 410 x 431 box: a head ring (centre, outer and inner radius), shoulders (an outer and
# an inner curve |u/rx|^n + |v/ry|^n = 1 centred at (205, cy), each cut by a bottom line) and a tie (a bar)
USER_BOX = (410, 431)
USER_HEAD = (205.0, 113.4, 112.6, 92.4)
USER_BODY = ((205.9, 241.0, 472.6, 2.14, 430.9), (184.2, 213.4, 465.2, 2.13, 410.4))   # rx, ry, cy, n, bottom
USER_TIE = (194.8, 267.0, 215.2, 369.4)
USER_INK, USER_FILL = "#7A6A4C", "#E3D7BC"

VARIABLES = {"Chla_ugL_mean": ("Chlorophyll-a", "µg/L"), "DO_mgL_mean": ("Dissolved oxygen", "mg/L")}
MONTHS = "January February March April May June July August September October November December".split()
SPACES = " \u00a0\u202f"


def need(ok, reason):
    """Stop with a one-line reason (exit code 1) when the response and the data in inputs/ do not agree."""
    if not ok:
        sys.exit(f"{CASE}: {reason}")


CASE = ""


# ---------------- the answer and its sources as the interface displays them
MARKER = re.compile(r"\[\s*([0-9]+(?:\s*,\s*[0-9]+)*)\s*\]")   # JavaScript's \d is 0-9


def marker_numbers(group):
    return [int(p) for p in re.split(r"\s*,\s*", group)]


def is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def number_citations(text, citations, also_cited):
    """tool/lib/citation-display.ts, numberCitationsForDisplay: the sources numbered 1..n in the order the text first
    cites them, then those flagged citedInAnswer, then those the claim checker matched, then the rest; markers rewritten
    to match. Returns the text and the cited sources as (display number, source)."""
    originals = [c["bracketNum"] if is_number(c.get("bracketNum")) else i + 1 for i, c in enumerate(citations)]
    known, number = set(originals), {}

    def assign(n):
        if n in known and n not in number:
            number[n] = len(number) + 1
    for m in MARKER.finditer(text):
        for n in marker_numbers(m.group(1)):
            assign(n)
    for n in sorted({o for o, c in zip(originals, citations) if c.get("citedInAnswer") is True}):
        assign(n)
    for n in sorted({n for n in also_cited if is_number(n)}):
        assign(n)
    cited_count = len(number)
    for n in sorted(set(originals)):
        assign(n)

    def rewrite(m):   # rewriteCitationMarkers
        nums = marker_numbers(m.group(1))
        if not any(n in number for n in nums):
            return m.group(0)
        return "[" + ", ".join(str(number.get(n, n)) for n in nums) + "]"
    shown = MARKER.sub(rewrite, text) if text and number else text
    cited = sorted(((number[o], c) for o, c in zip(originals, citations) if number[o] <= cited_count), key=lambda x: x[0])
    return shown, cited


# tool/lib/answer-tidy.ts, tidyAnswerText
RUN = re.compile(r"\[\s*[0-9]+(?:\s*,\s*[0-9]+)*\s*\](?:[ \t]*\[\s*[0-9]+(?:\s*,\s*[0-9]+)*\s*\])*")
QUOTED = "\"[^\"\\n]*\"|\u201c[^\u201d\\n]*\u201d"
VERBATIM = r"(?:https?://|www\.|doi:|DOI:)\S+|`[^`\n]*`"
EDGE_SHARE = re.compile(r"(?<![0-9.,])(0|100)(?:\.0+)?\s?%(?:\s+of\s+(?:the\s+)?((?:ensemble\s+)?members))?\s*"
                        r"\(([0-9]+)\s+of\s+([0-9]+)(\s+(?:ensemble\s+)?members)?\)")


def outside(line, keep, fix):
    """fix applied to the parts of line outside the spans keep matches."""
    out, last = "", 0
    for m in re.finditer(keep, line):
        out += fix(line[last:m.start()]) + m.group(0)
        last = m.end()
    return out + fix(line[last:])


def tidy_runs(line):
    """Runs of markers in ascending order, without repeats."""
    def sort_run(m):
        raw = m.group(0)
        nums = [int(d) for d in re.findall(r"[0-9]+", raw)]
        ordered = sorted(set(nums))
        if len(nums) < 2 or ordered == nums:
            return raw
        if re.search(r"\[[^\]]*,", raw):
            return "[" + ", ".join(map(str, ordered)) + "]"
        sep = re.search(r"\]([ \t]*)\[", raw)
        return (sep.group(1) if sep else "").join(f"[{n}]" for n in ordered)
    return outside(line, VERBATIM, lambda part: RUN.sub(sort_run, part)) if "[" in line else line


def tidy_spelling(line):
    """'skillful' -> 'skilful', outside quotations, web addresses and code."""
    fix = lambda s: re.sub(r"\b([Uu]n)?([Ss])killful(ly|ness)?\b", r"\1\2kilful\3", s, flags=re.ASCII)
    return outside(line, f"{QUOTED}|{VERBATIM}", fix) if "killful" in line else line


def tidy_counts(line):
    """'0% (0 of 221)' -> '0 of 221' and '100% (221 of 221)' -> '221 of 221'."""
    def fix(m):
        pct, before, k, n, after = m.groups()
        if not (int(k) == 0 if pct == "0" else int(k) == int(n) > 0):
            return m.group(0)
        noun = " " + re.sub(r"\s+", " ", before) if before else re.sub(r"\s+", " ", after) if after else ""
        return f"{k} of {n}{noun}"
    return outside(line, VERBATIM, lambda part: EDGE_SHARE.sub(fix, part)) if "%" in line else line


def tidy_answer(text):
    """Line by line; the banner lines ('>') are left as they are."""
    return "\n".join(line if re.match(r"\s*>", line) else tidy_counts(tidy_spelling(tidy_runs(line)))
                     for line in text.split("\n"))


def interface_view(rec):
    """tool/app/page.tsx, citationView: the answer as displayed and its cited sources."""
    text, cited = number_citations(rec["displayText"], rec["citations"], [cl.get("bracketNum") for cl in rec["claims"]])
    return tidy_answer(text), cited


# tool/components/AnswerText.tsx
BOLD_ONLY = re.compile(r"\*\*[^*]+\*\*")
INLINE = re.compile(r"(\*\*[^*]+\*\*|\[[0-9]+(?:\s*,\s*[0-9]+)*\])")
CHIP = re.compile(r"\[([0-9]+(?:\s*,\s*[0-9]+)*)\]")


def answer_blocks(text):
    """parseBlocks: the banner (lines starting with '>'), lists (lines starting with '- ' or '* ', at any indent: one
    level), and paragraphs, whose leading line, when it is bold only, is a heading of its own. A paragraph that is one
    bold-only line is a heading."""
    is_quote = lambda s: re.match(r"\s*>", s)
    is_bullet = lambda s: re.match(r"\s*[-*]\s+", s)
    lines, out, i = text.split("\n"), [], 0
    while i < len(lines):
        buf = []
        if not lines[i].strip():
            i += 1
        elif is_quote(lines[i]):
            while i < len(lines) and is_quote(lines[i]):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            out.append(("quote", buf))
        elif is_bullet(lines[i]):
            while i < len(lines) and is_bullet(lines[i]):
                buf.append(re.sub(r"^\s*[-*]\s+", "", lines[i]))
                i += 1
            out.append(("list", buf))
        else:
            while i < len(lines) and lines[i].strip() and not is_quote(lines[i]) and not is_bullet(lines[i]):
                buf.append(lines[i])
                i += 1
            out += [("para", buf[:1]), ("para", buf[1:])] if len(buf) > 1 and BOLD_ONLY.fullmatch(buf[0].strip()) \
                else [("para", buf)]
    return [("heading" if k == "para" and len(b) == 1 and BOLD_ONLY.fullmatch(b[0].strip()) else k, b) for k, b in out]


def inline_runs(text, marks, depth=0, bold=False):
    """renderInline: **bold** spans (one level deep) and markers, each number its own marker '[n]' ('[4, 6]' becomes
    '[4][6]'), set bold in the colour of its source. Returns runs (text, bold, colour)."""
    out = []
    for part in INLINE.split(text):
        chip = CHIP.fullmatch(part)
        if chip:
            out += [(f"[{n}]", True, marks.get(n, INK)) for n in marker_numbers(chip.group(1))]
        elif part and depth == 0 and BOLD_ONLY.fullmatch(part):
            out += inline_runs(part[2:-2], marks, 1, True)
        elif part:
            out.append((part, bold, INK))
    return out


def collapse(runs):
    """White space as a browser shows it: spaces, tabs and line ends as one space, none at the ends of a line."""
    out = []
    for text, bold, colour in runs:
        text = re.sub(r"[ \t\r\n\f]+", " ", text)
        if text.startswith(" ") and (not out or out[-1][0].endswith(" ")):
            text = text[1:]
        if text:
            out.append((text, bold, colour))
    if out and out[-1][0].endswith(" "):
        out[-1] = (out[-1][0].rstrip(" "),) + out[-1][1:]
    return [r for r in out if r[0]]


def keep_together(t):
    """No-break spaces (the words are unchanged): numbers stay with their units, 'day 7' stays whole, and the last two
    words of a line stay together."""
    t = re.sub(r"(\d) +(mg/L|µg/L|μg/L|m\b|days?\b|members\b)", "\\1\u00a0\\2", t)
    t = re.sub(r"\b([Dd]ays?) +(\d)", "\\1\u00a0\\2", t)
    return re.sub(r" (\S+)$", "\u00a0\\1", t)


def keep_banner(t):
    """In the banner, also its verdict phrases and a short last clause each on one line."""
    for phrase in ("threshold exceeded", "above threshold", "below threshold", "rule not met", "rule met"):
        t = t.replace(phrase, phrase.replace(" ", "\u00a0"))
    return re.sub(r"; ([^;]{1,45})$", lambda m: "; " + m.group(1).replace(" ", "\u00a0"), t)


def shown(text):
    """The words of an answer as the interface shows them: without '>' or list marks at the start of a line, '**', or
    the commas of a marker group."""
    out = []
    for line in text.split("\n"):
        line = re.sub(r"^\s*>\s?", "", line) if re.match(r"\s*>", line) else re.sub(r"^\s*[-*]\s+", "", line)
        line = CHIP.sub(lambda m: "".join(f"[{n}]" for n in marker_numbers(m.group(1))), line)
        out.append(re.sub(r"\*\*([^*]+)\*\*", r"\1", line))
    return spaced("\n".join(out))


def spaced(t):
    """White space as one space; a no-break space counts as a space, a narrow no-break space is kept as it is."""
    return re.sub(r"[ \t\r\n\f\u00a0]+", " ", t).strip()


# tool/components/CitationCard.tsx
SITE_NAMES = {"FCRE": "Falling Creek", "FCR": "Falling Creek", "BVRE": "Beaverdam", "BVR": "Beaverdam"}
VAR_NAMES = {"DO_mgL_mean": "dissolved oxygen", "Temp_C_mean": "water temperature", "Chla_ugL_mean": "chlorophyll-a",
             "fDOM_QSU_mean": "fDOM", "Turbidity_FNU_mean": "turbidity", "Bloom_binary_mean": "bloom likelihood"}


def humanize(name):
    """humanizeSource: 'FLARE FCRE DO_mgL_mean' -> 'FLARE forecast · Falling Creek · dissolved oxygen'."""
    tokens = name.split() if name else []
    kind = tokens[0].upper() if tokens else ""
    if kind in ("FLARE", "VERA"):
        site = v = ""
        for t in tokens[1:]:
            if t.upper() in SITE_NAMES:
                site = SITE_NAMES[t.upper()]
            elif t in VAR_NAMES:
                v = VAR_NAMES[t]
        if v:
            return " \u00b7 ".join(s for s in ("FLARE forecast" if kind == "FLARE" else "Sensor", site, v) if s)
    return name


def card(n, c):
    """A source's card, closed: its title, its evidence group (channel() of ../benchmark/common.py, as in Fig. 5b) and
    the group's name."""
    doc, kind, page, text = c.get("docName"), c.get("sourceType"), c.get("pageNum"), c.get("text")
    clean = re.sub(r"\.[^/.]+$", "", doc).strip() if doc else ""
    literature = kind == "literature" or (bool(doc) and doc != f"Source {n}")
    title = humanize((clean or doc or f"Source {n}") if literature else (doc if doc is not None else f"Source {n}"))
    need(kind == "literature" or bool(text), f"source {n} has no text to take its evidence group from")
    group = "literature" if kind == "literature" else channel(text)
    label = (f"Indexed paper \u00b7 p.{page:g}" if group == "literature" and is_number(page) and page > 0
             else GROUP[group][0])
    return {"n": n, "title": title, "kind": label, "category": group}



# ---------------- checks
def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def day_of_year(d):
    return max(1, (d - date(d.year - 1, 12, 31)).days)


def depth_bucket(depth):   # tool/lib/leads/sensor-public.ts
    return "surface" if depth < 2 else "mid" if depth < 6 else "deep"


def check_data(folder, rec):
    """The inputs, observations, seasonal mean, forecast and skill card; returns the chart data and the skill record's
    meta."""
    cd, pv = rec["chartData"], rec["provenance"]
    as_of = pv["pins"]["LEADS_AS_OF"]
    need(folder.name.endswith(as_of), "the case folder's date is not the response's date")
    vera = folder / "inputs" / f"vera_through_{pv['vera_last_day']}.csv.gz"
    pooled_file = folder / "inputs" / pv["skill_source"]
    need(sorted(p.name for p in (folder / "inputs").iterdir() if not p.name.startswith("."))
         == sorted([vera.name, pooled_file.name]), "inputs/ does not hold just the two files the response read")
    need(sha256(vera) == pv["vera_sha256"] and pv["pins"]["LEADS_PUBLIC_VERA_URL"].endswith("/" + vera.name),
         f"{vera.name} is not the sensor file the response read")
    need(sha256(pooled_file) == pv["skill_sha256"], f"{pooled_file.name} is not the skill record the response read")

    # the observations and the seasonal mean, from the sensor file
    site, variable, depth = cd["site"], cd["variable"], cd["depths"][0]
    with gzip.open(vera, "rt", newline="") as fh:
        rows = [r for r in csv.DictReader(fh) if r["site_id"].lower() == site and r["variable"] == variable
                and r["observation"] not in ("", "NA")]
    sensor = cd["sensorSeries"]
    need(sensor[-1]["t"] == pv["vera_last_day"] == str(date.fromisoformat(as_of) - timedelta(days=1)),
         "the latest observation is not from the day before the case date")
    for p in sensor:
        hits = [float(r["observation"]) for r in rows if r["datetime"][:10] == p["t"] and r["duration"] == "P1D"
                and abs(float(r["depth_m"]) - p["depthM"]) <= 0.05]
        need(hits == [p["v"]] and p["depthM"] == depth, f"the observation of {p['t']} is not the sensor file's")
    clim, values = cd["climatology"], []
    for r in rows:   # every reading in the same depth band within 14 days of the latest reading's day of the year
        if depth_bucket(float(r["depth_m"])) != clim["depthBucket"]:
            continue
        doy = day_of_year(date.fromisoformat(r["datetime"][:10]))
        if any((doy + off - 1) % 366 + 1 == clim["dayOfYear"] for off in range(-14, 15)):
            values.append(float(r["observation"]))
    need(clim["dayOfYear"] == day_of_year(date.fromisoformat(sensor[-1]["t"])) and clim["count"] == len(values)
         and clim["min"] == min(values) and clim["max"] == max(values) and abs(clim["mean"] - np.mean(values)) < 1e-9,
         "the seasonal mean, minimum, maximum or count is not recomputed from the sensor file")

    # the forecast from its members
    thr, above = cd["threshold"]["value"], cd["threshold"]["direction"] == "above"
    for i, p in enumerate(cd["perDay"]):
        x = np.array(p["members_raw"], dtype=float)
        k = int((x > thr).sum()) if above else int((x < thr).sum())
        q = np.quantile(x, [0.025, 0.1, 0.9, 0.975])   # linear interpolation, as the tool computes them
        need(p["day"] == i + 1 and p["target"] == str(date.fromisoformat(as_of) + timedelta(days=i))
             and len(x) == p["members"] and abs(x.mean() - p["mean"]) < 1e-9
             and np.allclose(q, [p["lo95"], p["q10"], p["q90"], p["hi95"]], rtol=0, atol=1e-9)
             and k == p["membersAbove"] and round(k / len(x), 3) == p["p"],
             f"forecast day {i + 1}: the mean, band or member count is not recomputed from the members")
    last = cd["perDay"][-1]
    need(cd["endOfHorizon"] == {"p10": last["q10"], "mean": last["mean"], "p90": last["q90"]},
         "the day-7 outlook is not the last forecast day")
    need(len(cd["perDay"]) == cd["horizon"] and len(sensor) == cd["windowDays"], "the chart has other days")

    # the skill card, from the pooled skill record
    card_, pooled = cd["skillCard"], json.loads(pooled_file.read_text(encoding="utf-8"))
    through = date.fromisoformat(pooled["meta"]["record_through"])
    need(pv["skill_meta"] == pooled["meta"] and card_["horizon"] == cd["horizon"]
         and card_["recordThrough"] == f"{through.day} {MONTHS[through.month - 1][:3]} {through.year}",
         "the skill card's record date or horizon differs from the skill record")
    if card_["record"] is None:   # FLARE skill is scored at 1.6 m only
        need(card_["depthM"] != pooled["meta"]["depth_m"] and card_["gap"] == f"at {card_['depthM']:g} m",
             "the skill card has no record although the depth is the one FLARE is scored at")
    else:
        need(card_["depthM"] == pooled["meta"]["depth_m"] and card_["record"]["variable"] == variable
             and card_["record"]["days"] == pooled[site][variable]["days"][:card_["horizon"]],
             "the skill card's days differ from the skill record in inputs/")
    return cd, pooled["meta"]


def check_banner(rec, chart, unit):
    """The banner opens the displayed text, and its numbers are the chart data's."""
    banner = rec["banner"]
    need(rec["displayText"].startswith(banner + "\n\n"), "the displayed text does not open with the banner")
    latest, per, thr = chart["sensorSeries"][-1], chart["perDay"], chart["threshold"]
    m = re.search(r"latest ([\d.]+) m \S+ ([\d.]+) (\S+) \((\d{4}-\d\d-\d\d)\)", banner)
    need(m is not None and float(m.group(1)) == chart["depths"][0] and m.group(2) == f"{latest['v']:.2f}"
         and m.group(3) == unit and m.group(4) == latest["t"], "the banner's latest reading is not the chart data's")
    need(re.search(rf"threshold {thr['value']:g} {re.escape(unit)}", banner) is not None,
         "the banner's threshold is not the chart data's")
    met = latest["v"] > thr["value"] if thr["direction"] == "above" else latest["v"] <= thr["value"]
    need(("rule met" if met else "rule not met") in banner, "the banner's verdict does not follow from the reading")
    k = [p["membersAbove"] for p in per]
    peak = k.index(max(k))
    m = re.search(r"peaks at (\d+)% \((\d+) of (\d+) members\) on day (\d+) of (\d+)", banner)
    want = [round(100 * k[peak] / per[peak]["members"]), k[peak], per[peak]["members"], peak + 1, chart["horizon"]]
    need(m is not None and [int(g) for g in m.groups()] == want, "the banner's peak share of members is not the chart data's")
    for pct, kk, n, day in re.findall(r"; (\d+)% \((\d+) of (\d+) members\) on day (\d+)\.", banner):
        p = per[int(day) - 1]
        need([int(pct), int(kk), int(n)] == [round(100 * p["membersAbove"] / p["members"]), p["membersAbove"],
                                             p["members"]], f"the banner's day-{day} share is not the chart data's")


def load(folder, name):
    return json.loads((folder / name).read_text(encoding="utf-8"))


# ---------------- text
@lru_cache(maxsize=None)
def font(bold, italic):
    """Matplotlib's font file for the style, read in font units (hinting_factor 1 keeps kerning in font units)."""
    prop = FontProperties(family=FAMILY, weight="bold" if bold else "normal", style="italic" if italic else "normal")
    return FT2Font(font_manager.findfont(prop, fallback_to_default=False), hinting_factor=1)


@lru_cache(maxsize=None)
def glyph(bold, italic, ch):
    f = font(bold, italic)
    gi = f.get_char_index(ord(ch))
    return gi, f.load_glyph(gi, flags=LoadFlags.NO_SCALE).horiAdvance / f.units_per_EM


@lru_cache(maxsize=None)
def kerned(bold, italic, a, b):
    """Whether the font's kerning table has the pair; the text is set without kerning, so the PDF and SVG text is
    split where Matplotlib would kern."""
    f = font(bold, italic)
    return f.get_kerning(glyph(bold, italic, a)[0], glyph(bold, italic, b)[0], Kerning.UNSCALED) != 0


def advance(ch, run):
    """Advance (mm) of a character of a run (text, bold, colour, size, italic), in whole units of 1/576 inch. Arial has
    no narrow no-break space (U+202F); it takes the width of a thin space (U+2009)."""
    ch = "\u2009" if ch == "\u202f" else ch
    return math.floor(glyph(run[1], run[4], ch)[1] * run[3] * 8 + 0.5) * UNIT


@lru_cache(maxsize=None)
def layout_font(bold, size):
    prop = FontProperties(family=FAMILY, weight="bold" if bold else "normal")
    return ImageFont.truetype(font_manager.findfont(prop, fallback_to_default=False), size)


def measure(text, pt, bold=False):
    """Width (mm) of text, used to place boxes next to text (Pillow, at 20 times the size); the text itself is set
    with the advances above."""
    return layout_font(bold, int(pt * 20)).getlength(text) / 20 * PT_MM


def line_metrics(spacing_pt):
    """Height of a line and depth of its baseline below the line's top (mm), for an exact line spacing (points)."""
    height = math.floor(spacing_pt + 0.5)
    return height * PT_MM, math.floor(0.8 * height + 0.5) * PT_MM


def line_h(pt, leading=1.2):
    return pt * leading * PT_MM


def paragraph_lines(para, width, pt, color=INK, italic=False, spacing=0.0):
    """One paragraph (a string with **bold** spans, or a list of (text, bold[, colour[, size]])) as lines of characters,
    each character with its run (text, bold, colour, size, italic); lines break at spaces only, so that each fits the
    width. Also returns the function that measures a line."""
    if isinstance(para, str):
        para = [(s, j % 2 == 1) for j, s in enumerate(para.split("**"))]
    runs = [(r[0], bool(r[1]), r[2] if len(r) > 2 else color, r[3] if len(r) > 3 else pt, italic) for r in para if r[0]]
    chars = [(ch, run) for run in runs for ch in run[0]]

    def width_of(cs):
        return sum(advance(ch, run) + spacing * PT_MM for ch, run in cs)
    words, cur = [], []   # each word keeps the spaces before it
    for c in chars:
        if c[0] == " " and cur and cur[-1][0] != " ":
            words.append(cur)
            cur = []
        cur.append(c)
    words.append(cur)
    lines, line = [], []
    for word in words:
        if line and width_of(line + word) > width:
            lines.append(line)
            line = word[next((i for i, c in enumerate(word) if c[0] != " "), len(word)):]   # without its spaces
        else:
            line = line + word
    lines.append(line)
    return lines, width_of


class Page:
    """The figure's elements in drawing order, in millimetres with y pointing down, drawn with Matplotlib at the end."""

    def __init__(self):
        self.ops = []

    def rect(self, x, y, w, h, fill=None, line=None, lw=0.5, radius=None):
        self.ops.append(("rect", dict(x=x, y=y, w=w, h=h, fill=fill, line=line, lw=lw, radius=radius)))

    def dot(self, x, y, d, fill, line=None, lw=0.5, dotted=False):
        self.ops.append(("dot", dict(x=x, y=y, d=d, fill=fill, line=line, lw=lw, dotted=dotted)))

    def polyline(self, pts, color, lw=0.75, dash=None, closed=False, fill=None):
        self.ops.append(("poly", dict(pts=pts, color=color, lw=lw, dash=dash, closed=closed, fill=fill)))

    def picture(self, name, x, y, w):
        img = mpimg.imread(HERE / "images" / name)
        self.ops.append(("image", dict(img=img, x=x, y=y, w=w, h=w * img.shape[0] / img.shape[1])))
        return w * img.shape[0] / img.shape[1]

    def user_icon(self, x, y, w):
        """The user pictogram (USER_* above) in a box with its top-left corner at x, y and width w; returns its height."""
        s = w / USER_BOX[0]
        at = lambda u, v: (x + float(u) * s, y + float(v) * s)
        cx, cy, r_out, r_in = USER_HEAD
        self.dot(*at(cx, cy), 2 * r_out * s, USER_INK)
        self.dot(*at(cx, cy), 2 * r_in * s, USER_FILL)
        for (rx, ry, yc, n, bottom), color in zip(USER_BODY, (USER_INK, USER_FILL)):
            t0 = math.asin(((yc - bottom) / ry) ** (n / 2))   # where the curve meets the bottom line
            t = np.linspace(math.pi - t0, t0, 200)
            u = cx + rx * np.sign(np.cos(t)) * np.abs(np.cos(t)) ** (2 / n)
            v = yc - ry * np.abs(np.sin(t)) ** (2 / n)
            self.polyline([at(a, b) for a, b in zip(u, v)], None, closed=True, fill=color)
        x0, y0, x1, y1 = USER_TIE
        self.polyline([at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)], None, closed=True, fill=USER_INK)
        return USER_BOX[1] * s

    def textbox(self, x, y, w, h, paras, pt, color=INK, align="l", leading=1.2, anchor="t", italic=False, spacing=0.0,
                gaps=None):
        """A text box without margins: paragraphs (strings with **bold** spans, or lists of (text, bold[, colour[, size]])),
        wrapped at the box width, with gaps (points) before them; spacing adds letter spacing (points)."""
        lines, gap_of = [], []
        for i, para in enumerate(paras):
            wrapped, width_of = paragraph_lines(para, w, pt, color, italic, spacing)
            for j, ln in enumerate(wrapped):
                lines.append((ln, width_of))
                gap_of.append((gaps[i] if gaps else 0.0) * PT_MM if j == 0 and i else 0.0)
        height, base = line_metrics(pt * leading)
        total = height * len(lines) + sum(gap_of)
        top = y + (h - total) / 2 if anchor == "ctr" else y
        b = top + base
        for (ln, width_of), g in zip(lines, gap_of):
            b += g
            while ln and ln[-1][0] in SPACES:
                ln = ln[:-1]
            lw = width_of(ln)
            x0 = x if align == "l" else x + w - lw if align == "r" else x + (w - lw) / 2
            self.ops.append(("text", dict(words=words(ln, spacing), x=x0, y=b, turned=False)))
            b += height
        return len(lines)

    def rot_text(self, cx, cy, length, text, pt, color=INK, bold=True):
        """Text turned 90 degrees anticlockwise (reads bottom to top), centred on (cx, cy) in a box one line high."""
        (ln,), width_of = paragraph_lines([(text, bold, color)], length, pt)
        height, base = line_metrics(pt * 1.2)
        self.ops.append(("text", dict(words=words(ln, 0.0), x=cx - height / 2 + base, y=cy + width_of(ln) / 2, turned=True)))

    # ---- drawing
    def render(self, stem, page_h):
        """Draw every element and save stem.pdf, stem.svg and stem.png (page_h pixels high at 300 dpi). The PDF and SVG
        keep the text as text, the lines exact and the pictures' own pixels. The PNG draws each character as its outline
        at its exact place (turned text on whole pixels), straight horizontal and vertical lines and boxes with their
        edges on the pixel grid, and each picture averaged over the pixels it covers."""
        fw, fh = PAGE_W / DPI, page_h / DPI
        fig = plt.figure(figsize=(fw, fh))
        ax = fig.add_axes((0, 0, 1, 1))
        ax.set_axis_off()
        vector, raster = [], []
        X = lambda v: PAGE_X + v
        Y = lambda v: PAGE_Y + v
        for z, (kind, k) in enumerate(self.ops):
            crisp = pixel_boxes(kind, k)
            if crisp is not None:
                for (x0, y0, x1, y1), color in crisp:
                    raster.append(ax.add_patch(Rectangle((X(x0), Y(y0)), x1 - x0, y1 - y0, facecolor=color, edgecolor="none",
                                                         linewidth=0, zorder=z, snap=False)))
            if kind == "rect":
                fill, line = k["fill"] or "none", k["line"] or "none"
                lw = k["lw"] if k["line"] else 0.0
                if k["radius"]:
                    p = FancyBboxPatch((X(k["x"]), Y(k["y"])), k["w"], k["h"], boxstyle=f"round,pad=0,rounding_size={k['radius']}",
                                       facecolor=fill, edgecolor=line, linewidth=lw)
                else:
                    p = Rectangle((X(k["x"]), Y(k["y"])), k["w"], k["h"], facecolor=fill, edgecolor=line, linewidth=lw,
                                  joinstyle="miter")
                p.set(zorder=z, snap=False)
                ax.add_patch(p)
                if crisp is not None:
                    vector.append(p)
            elif kind == "dot":
                p = Ellipse((X(k["x"]), Y(k["y"])), k["d"], k["d"], facecolor=k["fill"], edgecolor=k["line"] or "none",
                            linewidth=k["lw"] if k["line"] else 0.0, linestyle=(0, (1, 1)) if k["dotted"] else "solid",
                            angle=270)   # the outline starts at the left (this sets where the dots fall)
                p.set(capstyle="butt", zorder=z, snap=False)
                ax.add_patch(p)
            elif kind == "poly":
                xs, ys = [X(p[0]) for p in k["pts"]], [Y(p[1]) for p in k["pts"]]
                if k["fill"]:
                    p = Polygon(list(zip(xs, ys)), closed=True, facecolor=k["fill"], edgecolor="none", linewidth=0)
                    p.set(zorder=z, snap=False)
                    ax.add_patch(p)
                else:
                    style = {"dash": (0, (4, 3)), "dot": (0, (1, 1)), None: "solid"}[k["dash"]]
                    line = ax.add_line(Line2D(xs, ys, color=k["color"], linewidth=k["lw"], linestyle=style,
                                              solid_capstyle="butt", dash_capstyle="butt", solid_joinstyle="miter", zorder=z,
                                              snap=False))
                    if crisp is not None:
                        vector.append(line)
            elif kind == "image":
                vector.append(ax.imshow(k["img"], extent=(X(k["x"]), X(k["x"] + k["w"]), Y(k["y"] + k["h"]), Y(k["y"])),
                                        origin="upper", aspect="auto", interpolation="none", zorder=z))
                pixels, extent = on_grid(k["img"], X(k["x"]), Y(k["y"]), k["w"], k["h"])
                raster.append(ax.imshow(pixels, extent=extent, origin="upper", aspect="auto", interpolation="nearest",
                                        zorder=z))
            elif kind == "text":
                turned = k["turned"]
                y0 = Y(k["y"]) if turned else Y(round((GRID_TOP + k["y"]) / PX) * PX - GRID_TOP)   # baselines on the grid
                x0 = round(X(k["x"]) / PX) * PX if turned else X(k["x"])   # turned text: its baseline and characters
                for text, run, offs, _ in k["words"]:
                    x, y = (x0, y0 - offs[0]) if turned else (x0 + offs[0], y0)
                    prop = FontProperties(family=FAMILY, size=run[3], weight="bold" if run[1] else "normal",
                                          style="italic" if run[4] else "normal")
                    vector.append(ax.text(x, y, text, fontproperties=prop, color=run[2], ha="left", va="baseline",
                                          rotation=90 if turned else 0, rotation_mode="anchor", zorder=z, parse_math=False))
                    glyphs = []
                    for ch, off in zip(text, offs):   # each character at its place on the line
                        m = ([[0, -PT_MM, x0], [-PT_MM, 0, math.floor((y0 - off) / PX) * PX]] if turned   # on whole pixels
                             else [[PT_MM, 0, x0 + off], [0, -PT_MM, y0]])
                        glyphs.append(Affine2D(np.array(m + [[0, 0, 1]])).transform_path(outline(ch, run[1], run[4], run[3])))
                    raster.append(ax.add_patch(PathPatch(MPath.make_compound_path(*glyphs), facecolor=run[2],
                                                         edgecolor="none", linewidth=0, zorder=z)))
        ax.set_xlim(0, fw * 25.4)
        ax.set_ylim(fh * 25.4, 0)
        meta = {"pdf": {"CreationDate": None, "ModDate": None}, "svg": {"Date": None}, "png": None}
        for ext in ("pdf", "svg", "png"):
            for a in vector:
                a.set_visible(ext != "png")
            for a in raster:
                a.set_visible(ext == "png")
            fig.savefig(stem.with_suffix("." + ext), dpi=DPI, metadata=meta[ext])
        plt.close(fig)


def on_grid(img, x, y, w, h):
    """A picture (RGBA) placed at x, y with size w, h (mm on the page) as the average of its pixels over each 300 dpi
    pixel it covers, and the extent of those pixels; the PDF and SVG keep the picture's own pixels."""
    x0, y0, x1, y1 = (v / PX for v in (x, y, x + w, y + h))
    c0, c1, r0, r1 = math.floor(x0), math.ceil(x1), math.floor(y0), math.ceil(y1)

    def overlap(n, a, b, t0, t1):   # how much of each target pixel (rows) each picture pixel (columns) covers
        edges = a + (b - a) * np.arange(n + 1) / n
        t = np.arange(t0, t1)[:, None]
        return np.clip(np.minimum(edges[1:], t + 1) - np.maximum(edges[:-1], t), 0, None)
    wx, wy = overlap(img.shape[1], x0, x1, c0, c1), overlap(img.shape[0], y0, y1, r0, r1)
    alpha = img[..., 3:]
    pre = np.concatenate([img[..., :3] * alpha, alpha], axis=-1)   # colours weighted by their opacity
    out = np.stack([wy @ pre[..., c] @ wx.T for c in range(4)], axis=-1)
    rgb = out[..., :3] / np.maximum(out[..., 3:], 1e-12)
    return np.concatenate([rgb, out[..., 3:]], axis=-1).clip(0, 1), (c0 * PX, c1 * PX, r1 * PX, r0 * PX)


def pixel_boxes(kind, k):
    """A straight horizontal or vertical line (solid, dashed or dotted) or a box as filled rectangles (mm) with their
    edges on the 300 dpi grid of the page, each with its colour; None for any other shape."""
    snap = lambda v: math.floor(v / PX + 0.5) * PX
    out = []
    if kind == "rect" and not k["radius"]:
        x, y, w, h, t = k["x"], k["y"], k["w"], k["h"], k["lw"] * PT_MM / 2
        if k["fill"]:
            out.append(((x, y, x + w, y + h), k["fill"]))
        if k["line"]:
            for box in ((x - t, y - t, x + w + t, y + t), (x - t, y + h - t, x + w + t, y + h + t),
                        (x - t, y - t, x + t, y + h + t), (x + w - t, y - t, x + w + t, y + h + t)):
                out.append((box, k["line"]))
    elif kind == "poly" and not k["fill"]:
        pts, t = k["pts"], k["lw"] * PT_MM / 2
        if any(a[0] != b[0] and a[1] != b[1] for a, b in zip(pts, pts[1:])):
            return None
        on_off = {"dash": (8 * t, 6 * t), "dot": (2 * t, 2 * t), None: None}[k["dash"]]
        for i, (a, b) in enumerate(zip(pts, pts[1:])):
            axis = 0 if a[1] == b[1] else 1                     # 0: horizontal, 1: vertical
            lo, hi = sorted((a[axis], b[axis]))
            if i:                                               # a joint: the square corner of a mitred right angle
                lo, hi = (lo - t, hi) if a[axis] == lo else (lo, hi + t)
            if i < len(pts) - 2:
                lo, hi = (lo, hi + t) if b[axis] == hi else (lo - t, hi)
            spans = [(lo, hi)]
            if on_off:                                          # dashes from the start of the line
                start, sign, spans, d = a[axis], 1 if b[axis] >= a[axis] else -1, [], 0.0
                while d < hi - lo - 1e-9:
                    e = min(d + on_off[0], hi - lo)
                    spans.append(tuple(sorted((start + sign * d, start + sign * e))))
                    d += sum(on_off)
            c = a[1 - axis]
            for s0, s1 in spans:
                out.append(((s0, c - t, s1, c + t) if axis == 0 else (c - t, s0, c + t, s1), k["color"]))
    else:
        return None
    return [((snap(x0 + PAGE_X) - PAGE_X, snap(y0 + PAGE_Y) - PAGE_Y, snap(x1 + PAGE_X) - PAGE_X,
              snap(y1 + PAGE_Y) - PAGE_Y), color) for (x0, y0, x1, y1), color in out]


def words(chars, spacing):
    """A line's words as (text, run, offsets of its characters along the line in mm, the spaces before it), split at
    spaces, where the run changes, at pairs that Matplotlib would kern, and at every character of letter-spaced text."""
    out, x, prev, cur, gap = [], 0.0, None, None, ""
    for ch, run in chars:
        same = prev is not None and prev[1] is run
        if (not same or spacing or ch in SPACES or prev[0] in SPACES
                or (ch not in SPACES and kerned(run[1], run[4], prev[0], ch))):
            cur = None
        if ch in SPACES:
            gap += ch
        else:
            if cur is None:
                cur = ["", run, [], gap]
                out.append(cur)
                gap = ""
            cur[0] += ch
            cur[2].append(x)
        x += advance(ch, run) + spacing * PT_MM
        prev = (ch, run)
    return [tuple(w) for w in out]


@lru_cache(maxsize=None)
def outline(ch, bold, italic, pt):
    """A character's outline (points, y up, origin on the baseline)."""
    prop = FontProperties(family=FAMILY, size=pt, weight="bold" if bold else "normal", style="italic" if italic else "normal")
    return TextPath((0, 0), ch, prop=prop)


def nice_ticks(lo, hi, target=4):
    """Axis ticks at 1, 2 or 5 times a power of 10, as in the interface's charts."""
    if lo == hi:
        return [lo - 1, lo, lo + 1]
    raw = (hi - lo) / max(1, target - 1)
    mag = 10 ** math.floor(math.log10(raw))
    norm = raw / mag
    step = (1 if norm < 1.5 else 2 if norm < 3 else 5 if norm < 7 else 10) * mag
    v, out = math.floor(lo / step) * step, []
    while v <= math.ceil(hi / step) * step + step * 1e-6:
        out.append(round(v, 6))
        v += step
    return out


def day_month(d):
    return f"{d.day} {MONTHS[d.month - 1][:3]}"


# ---------------- the figure
def draw(page, folder):
    """Check the response, then lay out panels a, b and c; returns the page height (pixels)."""
    rec = load(folder, "leads_response.json")
    events = {e["type"]: e for e in rec["events"]}
    need(events["done"]["citations"] == rec["citations"] and events["faithfulness"]["claims"] == rec["claims"],
         "the response's sources or claims are not the ones the interface received")
    steps = {e["step"]: e.get("data") or {} for e in rec["events"] if e["type"] == "step"}
    need(not str(steps.get("guardrail-eval", {}).get("scopeNote") or "").strip(),
         "the response has a scope line under the answer, which this figure does not draw")
    cd, skill_meta = check_data(folder, rec)
    var_label, unit = VARIABLES[cd["variable"]]
    check_banner(rec, cd, unit)
    text, cited = interface_view(rec)
    cards = [card(n, c) for n, c in cited]
    marks = {c["n"]: CATEGORY[c["category"]] for c in cards}   # each [n] marker takes source n's colour
    code = rec["leadsProfile"]["reservoir"].upper()
    a_bottom = draw_a(page, rec, text, marks, code)
    b_bottom = draw_b(page, a_bottom + GAP, cd, code, skill_meta, var_label, unit)
    return draw_c(page, b_bottom + GAP, cards)


def draw_a(page, rec, text, marks, code):
    """(a) The question card (user on the right) and the answer (LEADS on the left); returns the panel's bottom."""
    T, AL, AR = PT, CX0, CX1
    profile, question = rec["leadsProfile"], rec["question"]
    name = re.search(rf"((?:[A-Z][a-z]+ )+)\({code}\)", question)   # the reservoir's name as the question gives it
    need(name is not None, "the question does not name the reservoir")
    y = 0.0
    page.textbox(0, y - 1.7, 4, line_h(T["letter"]), [[("a", True)]], pt=T["letter"])
    qx, qr = AL, AR - AVC
    qw = qr - qx - 2 * PAD
    meta_h = line_h(T["meta"])
    quoted = "“" + question + "”"
    q_h = len(paragraph_lines(quoted, qw, T["question"], italic=True)[0]) * line_h(T["question"], 1.22)
    card_h = 2.0 + meta_h + 1.2 + q_h + 1.9
    page.rect(qx, y, qr - qx, card_h, CASE_FILL, CASE_LINE, lw=0.5)
    meta = f"  ·  {name.group(1)}({code})  ·  {profile['decision'].replace('_', ' ').capitalize()}"
    page.textbox(qx + PAD, y + 2.0, qw, meta_h + 0.3, [[(profile["persona"].capitalize(), True, MUTED), (meta, False, MUTED)]],
                 pt=T["meta"])
    page.textbox(qx + PAD, y + 2.0 + meta_h + 1.2, qw, q_h + 0.5, [[(quoted, False)]], pt=T["question"], leading=1.22,
                 italic=True)
    uh = page.user_icon(AR - AVC / 2 - AVV / 2, y + 0.5, AVV)
    page.textbox(AR - AVC, y + 0.5 + uh + 0.3, AVC, line_h(T["small"]) + 0.3, [[("User", True)]], pt=T["small"], align="c")
    y += card_h + 3.0

    ax_ = AL + AVC
    lh_ = page.picture("leads_mark.png", AL + AVC / 2 - AVV / 2, y + 0.5, AVV)
    page.textbox(AL, y + 0.5 + lh_ + 0.3, AVC, line_h(T["small"]) + 0.3, [[("LEADS", True)]], pt=T["small"], align="c")
    aw = AR - ax_
    bottom = answer(Page(), ax_ + PAD, y + PAD, aw - 2 * PAD, text, marks) + PAD - 0.4   # measured before drawing
    page.rect(ax_, y, aw, bottom - y, WHITE, FRAME, lw=0.5)
    first = len(page.ops)
    answer(page, ax_ + PAD, y + PAD, aw - 2 * PAD, text, marks)
    drawn = "\n".join("".join(w[3] + w[0] for w in k["words"])   # each line, its words with the spaces between them
                      for kind, k in page.ops[first:] if kind == "text" and not k.get("bullet"))
    need(spaced(drawn) == shown(text), "the drawn answer is not the text the interface displays")
    return bottom


def answer(page, x, y, w, text, marks):
    """The answer laid out as AnswerText.tsx lays it out, from (x, y) at width w; returns the bottom of its last line.
    Margins between blocks are the interface's (px; of two that meet, the larger): the banner 16 below, a paragraph 12
    below, a heading 18 above and 7 below, a list 12 below and 6 between its items."""
    pt = PT["answer"]
    lh = line_metrics(pt * 1.2)[0]
    runs = lambda line: collapse(inline_runs(keep_together(line), marks))
    margins = {"quote": (16, 16), "para": (0, 12), "heading": (18, 7), "list": (0, 12)}
    below = None
    for kind, lines in answer_blocks(text):
        if below is not None:
            y += max(below, margins[kind][0]) * PX_PT * PT_MM
        below = margins[kind][1]
        if kind == "quote":   # the operational check, in a box
            bx, by = 2.0, 1.7
            paras = [runs(keep_banner(line)) for line in lines]
            h = sum(len(paragraph_lines(p, w - 2 * bx, pt)[0]) for p in paras) * line_h(pt) * LS_RENDER + 2 * by
            page.rect(x, y, w, h, BAN_FILL, BAN_LINE, lw=0.5)
            page.textbox(x + bx, y + by, w - 2 * bx, h - 2 * by, paras, pt=pt)
            y += h
        elif kind == "list":
            for j, item in enumerate(lines):
                y += 6 * PX_PT * PT_MM if j else 0.0
                page.textbox(x + INDENT - BULLET, y, BULLET, lh, [[("•", False, INK)]], pt=pt)
                page.ops[-1][1]["bullet"] = True
                y += page.textbox(x + INDENT, y, w - INDENT, lh, [runs(item)], pt=pt) * lh
        else:   # a paragraph or a heading; its lines (ended by line breaks) each start a new line
            y += page.textbox(x, y, w, lh, [runs(line) for line in lines], pt=pt) * lh
    return y


def draw_b(page, y, cd, code, skill_meta, var_label, unit):
    """(b) The chart, the day-7 outlook and the skill card; returns the panel's bottom."""
    T = PT
    sc = cd["skillCard"]
    # (b1) observations and the 7-day forecast
    page.textbox(0, y - 1.4, 4, line_h(T["letter"]), [[("b", True)]], pt=T["letter"])
    thr, thr_dir = cd["threshold"]["value"], cd["threshold"]["direction"]
    depth = cd["depths"][0]
    eyebrow(page, CX0, y, CX1 - CX0, f"Observations \u2192 {cd['horizon']}-day forecast",
            right=f"{code} \u00b7 {depth:g} m \u00b7 sensors & FLARE")
    sensor, per = cd["sensorSeries"], cd["perDay"]
    clim = cd["climatology"]["mean"]
    ys = [p["v"] for p in sensor] + [v for p in per for v in (p["mean"], p["q10"], p["q90"])] + [thr, clim]
    ticks = nice_ticks(min(ys), max(ys), 4)
    ylo, yhi = ticks[0], ticks[-1]
    if max(ys) >= yhi - 0.02 * (yhi - ylo):   # half a tick step of headroom, without another tick label
        yhi += (ticks[1] - ticks[0]) / 2
    py0 = y + line_h(T["eyebrow"]) + 3.6     # room for the 'latest obs' label above the plot
    py1 = py0 + PLOT_H
    px0, px1 = CX0 + AVC, CX1
    d0, dn = date.fromisoformat(sensor[0]["t"]), date.fromisoformat(per[-1]["target"])
    span = (dn - d0).days
    X = lambda d: px0 + (px1 - px0) * (((date.fromisoformat(d[:10]) - d0).days + 0.5) / (span + 1.0))
    Y = lambda v: py1 - (py1 - py0) * ((v - ylo) / (yhi - ylo))
    band = [(X(p["target"]), Y(p["q90"])) for p in per] + [(X(p["target"]), Y(p["q10"])) for p in reversed(per)]
    page.polyline(band, None, closed=True, fill=BAND)
    page.polyline([(px0, Y(clim)), (px1, Y(clim))], SEAS, lw=0.95, dash="dash")
    page.polyline([(px0, Y(thr)), (px1, Y(thr))], VERMILLION, lw=1.0)
    xl = X(sensor[-1]["t"])
    page.polyline([(xl, py0), (xl, py1)], DIVIDER, lw=0.65, dash="dash")
    lh = line_h(T["small"])
    page.textbox(xl - 10, py0 - lh - 0.6, 20, lh, ["latest obs"], pt=T["small"], color=SK_INK, align="c")
    obs = [(X(p["t"]), Y(p["v"])) for p in sensor]
    page.polyline(obs, INK, lw=0.9)
    for xx, yy in obs[:-1]:
        page.dot(xx, yy, 1.35, INK)
    page.dot(obs[-1][0], obs[-1][1], 1.95, WHITE)   # the latest reading: a white ring
    page.dot(obs[-1][0], obs[-1][1], 1.6, INK)
    page.polyline([(X(p["target"]), Y(p["mean"])) for p in per], BLUE, lw=1.5)
    # line labels on the outer side of the pair: the higher line's label above it, the lower one's below it
    clim_top = clim > thr
    thr_txt, seas_txt = cd["threshold"]["label"], "seasonal mean"
    need(thr_txt.endswith(f" {thr:g} {unit}"), f"the threshold label '{thr_txt}' does not end with {thr:g} {unit}")
    if clim_top:      # seasonal mean above the threshold: both labels above their lines, clear of the legend below
        seas_y = Y(clim) - lh - 0.35
        thr_y = Y(thr) - lh - 0.35
    else:
        thr_y = Y(thr) - lh - 0.35
        seas_y = Y(clim) + 0.35
    if seas_y + lh > py1 - 0.3:   # it would drop into the date row: above its line
        seas_y = Y(clim) - lh - 0.35

    def hits_obs(x0, x1, yt, yb):   # an observation segment crosses the label's box
        for (xa, ya), (xb, yb_) in zip(obs, obs[1:]):
            for f in [i / 20 for i in range(21)]:
                xx_, yy_ = xa + f * (xb - xa), ya + f * (yb_ - ya)
                if x0 - 0.6 <= xx_ <= x1 + 0.6 and yt - 0.6 <= yy_ <= yb + 0.6:
                    return True
        return False
    for txt, ty, col in ((thr_txt, thr_y, VERMILLION), (seas_txt, seas_y, SEAS)):
        tw = measure(txt, T["small"]) + 1.0
        tx = px0 + 1.3
        if hits_obs(tx, tx + tw, ty, ty + lh):   # observations at the left end: the label goes to the right end
            page.textbox(px1 - 1.3 - tw, ty, tw, lh, [[(txt, False, col)]], pt=T["small"], align="r")
        else:
            page.textbox(tx, ty, tw, lh, [[(txt, False, col)]], pt=T["small"])
    # axes: left and bottom, outward ticks, no grid; a minor tick each day, a date every 4th day back from the last
    page.polyline([(px0, py0), (px0, py1), (px1, py1)], INK, lw=0.7)
    for v in ticks:
        page.polyline([(px0 - 0.95, Y(v)), (px0, Y(v))], INK, lw=0.7)
        lab = str(int(v)) if float(v).is_integer() else f"{v:g}"
        page.textbox(px0 - 1.4 - 6.0, Y(v) - lh / 2, 6.0, lh, [lab], pt=T["small"], color=SK_INK, align="r", anchor="ctr")
    page.rot_text(CX0 + 1.0, (py0 + py1) / 2, PLOT_H, f"{var_label} ({unit})", T["small"])
    for k in range(span + 1):
        xx = X((d0 + timedelta(days=k)).isoformat())
        page.polyline([(xx, py1), (xx, py1 + 0.55)], INK, lw=0.5)
    step = max(1, -(-span // 4))
    for k in range(span, -1, -step):
        d = d0 + timedelta(days=k)
        xx = X(d.isoformat())
        page.polyline([(xx, py1), (xx, py1 + 1.05)], INK, lw=0.7)
        page.textbox(xx - 6, py1 + 1.4, 12, lh, [day_month(d)], pt=T["small"], color=SK_INK, align="c")
    # legend inside the plot, top left (or bottom left when the seasonal mean lies above the threshold)
    leg_rows = [("obs", "observed"), ("fc", "forecast mean"), ("band", "10\u201390%")]
    row = 2.75
    lx = px0 + 2.2
    ly0 = (py0 + 1.6) if not clim_top else (py1 - 1.6 - row * len(leg_rows) + 0.4)
    for i, (kind, lab) in enumerate(leg_rows):
        cy = ly0 + i * row + row / 2
        if kind == "obs":
            page.polyline([(lx, cy), (lx + 4.2, cy)], INK, lw=0.9)
            page.dot(lx + 2.1, cy, 1.35, INK)
        elif kind == "fc":
            page.polyline([(lx, cy), (lx + 4.2, cy)], BLUE, lw=1.5)
        else:
            page.rect(lx, cy - 0.85, 4.2, 1.7, BAND, None)
        page.textbox(lx + 5.4, cy - lh / 2, measure(lab, T["small"]) + 1.0, lh, [lab], pt=T["small"], color=SK_INK,
                     anchor="ctr")
    b1_bottom = py1 + 1.4 + lh

    # (b2) forecast outlook on the last day; the value's colour shows the side of the threshold
    y = b1_bottom + 4.2
    eyebrow(page, CX0, y, CX1 - CX0, f"Forecast outlook \u00b7 day {cd['horizon']}", right=f"vs {thr:g} {unit} threshold")
    eoh = cd["endOfHorizon"]
    reads = ([("pessimistic \u00b7 90th", eoh["p90"]), ("expected \u00b7 mean", eoh["mean"]), ("optimistic \u00b7 10th", eoh["p10"])]
             if thr_dir == "above" else
             [("pessimistic \u00b7 10th", eoh["p10"]), ("expected \u00b7 mean", eoh["mean"]), ("optimistic \u00b7 90th", eoh["p90"])])
    t0 = y + line_h(T["eyebrow"]) + 1.3
    vh = line_h(T["value"], 1.05)
    th = 1.9 + line_h(T["small"]) + 0.9 + vh + 1.9
    page.polyline([(CX0, t0), (CX1, t0)], TABLE_RULE, lw=0.7)
    page.polyline([(CX0, t0 + th), (CX1, t0 + th)], TABLE_RULE, lw=0.7)
    cw = (CX1 - CX0) / 3
    for i, (lab, v) in enumerate(reads):
        cx = CX0 + i * cw
        if i:
            page.polyline([(cx, t0), (cx, t0 + th)], RULE, lw=0.5)
        bad = v > thr if thr_dir == "above" else v < thr
        page.textbox(cx + 2.2, t0 + 1.9, cw - 3.0, line_h(T["small"]), [[(lab.upper(), False, SK_MUTED)]], pt=T["small"],
                     spacing=0.04 * T["small"])
        page.textbox(cx + 2.2, t0 + 1.9 + line_h(T["small"]) + 0.9, cw - 3.0, vh,
                     [[(f"{v:.1f}", True, RISK if bad else SAFE), ("\u00a0" + unit, False, SK_MUTED, T["small"] + 1)]],
                     pt=T["value"], leading=1.05)
    b2_bottom = t0 + th

    # (b3) forecast skill: the pooled record frozen at the case date
    y = b2_bottom + 4.2
    var_eye = f"{var_label} forecast skill"
    if sc.get("record"):
        eyebrow(page, CX0, y, CX1 - CX0, var_eye, right=f"vs climatology \u00b7 {code} {skill_meta['depth_m']:g} m")
        days = sc["record"]["days"]
        cls = lambda d: "more" if d["lo"] > 0 else ("less" if d["hi"] < 0 else "same")
        r0 = y + line_h(T["eyebrow"]) + 1.3
        page.polyline([(CX0, r0), (CX1, r0)], TABLE_RULE, lw=0.7)
        page.textbox(CX0, r0 + 1.5, CX1 - CX0, line_h(T["answer"]), [[(sc["verdict"], False, SK_INK)]], pt=T["answer"])
        sp0 = r0 + 1.5 + line_h(T["answer"]) + 1.6   # top tick
        sp1 = sp0 + SKILL_H                          # x axis
        lo = min([0.0] + [d["lo"] for d in days])
        hi = max([0.0] + [d["hi"] for d in days])
        sticks = nice_ticks(lo, hi, 5 if hi - lo > 90 else 4)
        slo, shi = sticks[0], sticks[-1]
        spx0, spx1 = CX0 + AVC, CX1 - 1.0
        n_d = len(days)
        slots, c = max(n_d, 3), (1 + n_d) / 2
        SX = lambda k: spx0 + (spx1 - spx0) * ((k - c) / slots + 0.5)
        SY = lambda v: sp1 - (sp1 - sp0) * ((v - slo) / ((shi - slo) or 1))
        page.polyline([(spx0, sp0), (spx0, sp1)], SK_INK, lw=0.7)
        for v in sticks:
            page.polyline([(spx0 - 0.95, SY(v)), (spx0, SY(v))], SK_INK, lw=0.7)
            lab = f"\u2212{abs(int(v))}" if v < 0 else str(int(v))
            page.textbox(spx0 - 1.4 - 6.0, SY(v) - lh / 2, 6.0, lh, [lab], pt=T["small"], color=SK_TICK, align="r",
                         anchor="ctr")
        page.rot_text(CX0 + 1.0, (sp0 + sp1) / 2, SKILL_H + 4, "CRPSS (%)", T["small"], color=SK_INK)
        if slo < 0:
            page.polyline([(spx0, SY(0)), (CX1, SY(0))], SK_ZERO, lw=0.6)
        page.polyline([(spx0, sp1), (CX1, sp1)], SK_INK, lw=0.7)
        mr = 0.85
        for d in days:
            xx, yy = SX(d["day"]), SY(d["crpss"])
            page.polyline([(xx, SY(d["hi"])), (xx, SY(d["lo"]))], SK_CI, lw=0.9)
            k_ = cls(d)
            if k_ == "less":
                page.rect(xx - mr * 0.875, yy - mr * 0.875, mr * 1.75, mr * 1.75, SK_LESS, None)
            elif k_ == "same":
                page.dot(xx, yy, 2 * mr, WHITE, line=SK_INK, lw=0.9)
            else:
                page.dot(xx, yy, 2 * mr, SK_INK)
            r_ = math.floor(d["crpss"] + 0.5)   # rounded half up, as the interface rounds
            val = f"+{r_}%" if r_ > 0 else f"\u2212{abs(r_)}%" if r_ < 0 else "0%"
            page.textbox(xx + mr + 1.4, yy - lh / 2 + 0.15, measure(val, T["small"]) + 0.8, lh, [[(val, False, SK_INK)]],
                         pt=T["small"], anchor="ctr")
            page.polyline([(xx, sp1), (xx, sp1 + 0.95)], SK_INK, lw=0.7)
            page.textbox(xx - 3, sp1 + 1.3, 6, lh, [str(d["day"])], pt=T["small"], color=SK_TICK, align="c")
        ft_y = sp1 + 1.3 + lh + 0.3
        page.textbox(spx0, ft_y, spx1 - spx0, lh, [[("Forecast day", True, SK_INK)]], pt=T["small"], align="c")
        r1 = ft_y + lh + 1.0
        page.polyline([(CX0, r1), (CX1, r1)], TABLE_RULE, lw=0.7)
        # key: only the classes shown, then the zero line
        ky = r1 + 1.6
        kx = CX0
        for k_, lab in (("more", "More skilful"), ("same", "Not distinguishable"), ("less", "Less skilful")):
            if not any(cls(d) == k_ for d in days):
                continue
            cyk = ky + lh / 2
            if k_ == "less":
                page.rect(kx + 0.35, cyk - 0.65, 1.3, 1.3, SK_LESS, None)
            elif k_ == "same":
                page.dot(kx + 1.0, cyk, 1.5, WHITE, line=SK_INK, lw=0.8)
            else:
                page.dot(kx + 1.0, cyk, 1.6, SK_INK)
            page.textbox(kx + 2.9, ky, measure(lab, T["small"]) + 1.0, lh, [[(lab, False, SK_MUTED)]], pt=T["small"])
            kx += 2.9 + measure(lab, T["small"]) + 4.0
        # the x axis is the zero line when the scale starts at 0
        page.polyline([(kx, ky + lh / 2), (kx + 3.8, ky + lh / 2)], SK_ZERO if slo < 0 else SK_INK,
                      lw=0.6 if slo < 0 else 0.7)
        zl = "0 = as skilful as climatology"
        page.textbox(kx + 5.0, ky, measure(zl, T["small"]) + 1.0, lh, [[(zl, False, SK_MUTED)]], pt=T["small"])
        cap = (f"Dot: skill (CRPSS) of past FLARE forecasts vs climatology; line: {skill_meta['ci']['level']:g}% CI. "
               f"Record frozen at {sc['recordThrough']}.")
        page.textbox(CX0, ky + lh + 0.9, CX1 - CX0, lh, [[(cap, False, SK_MUTED)]], pt=T["small"])
        b3_bottom = ky + lh + 0.9 + lh
    else:   # no skill record at this depth: one line between two rules
        eyebrow(page, CX0, y, CX1 - CX0, var_eye, right=f"{code} \u00b7 {depth:g} m")
        r0 = y + line_h(T["eyebrow"]) + 1.3
        head = f"Forecast skill: not scored {sc['gap']}"
        tx = CX0 + AVC
        inner = line_h(T["answer"])
        r1 = r0 + 2.6 + inner + 2.6
        page.polyline([(CX0, r0), (CX1, r0)], TABLE_RULE, lw=0.7)
        page.polyline([(CX0, r1), (CX1, r1)], TABLE_RULE, lw=0.7)
        icy = r0 + 2.6 + inner / 2
        page.polyline([(CX0 + 0.3, icy), (CX0 + 7.3, icy)], SK_ZERO, lw=0.7, dash="dot")
        page.dot(CX0 + 3.8, icy, 2.8, WHITE, line=SK_CI, lw=0.9, dotted=True)
        page.textbox(tx, r0 + 2.6, CX1 - tx, inner, [[(head, False, SK_INK)]], pt=T["answer"], anchor="ctr")
        b3_bottom = r1

    return b3_bottom


def draw_c(page, y, cards):
    """(c) The evidence list as the interface shows it with its cards closed (tool/app/page.tsx, CitationCard.tsx): the
    number of sources, then each source's number, title and kind; returns the page height (pixels)."""
    T = PT
    lh = line_h(T["small"])
    page.textbox(0, y - 1.4, 4, line_h(T["letter"]), [[("c", True)]], pt=T["letter"])
    eyebrow(page, CX0, y, CX1 - CX0, f"EVIDENCE · {len(cards)} sources", upper=False)
    ry = y + line_h(T["eyebrow"]) + 1.6
    bd, pitch, pill = 3.0, 3.4, 3.8   # badge diameter, line pitch, badge width for numbers from 10
    x_title = CX0 + pill + 1.2
    x_kind = x_title + max(measure(c["title"], T["small"]) for c in cards) + 4.0
    for c in cards:
        n, col = c["n"], CATEGORY[c["category"]]
        cy = ry + pitch / 2
        bw = pill if n >= 10 else bd
        if n >= 10:
            page.rect(CX0, cy - bd / 2, bw, bd, col, None, radius=bd / 2)
        else:
            page.dot(CX0 + bd / 2, cy, bd, col)
        page.textbox(CX0, cy - bd / 2, bw, bd, [[(str(n), True, WHITE)]], pt=T["small"], align="c", anchor="ctr")
        page.textbox(x_title, cy - lh / 2, x_kind - x_title, lh, [[(c["title"], False, INK)]], pt=T["small"], anchor="ctr")
        page.textbox(x_kind, cy - lh / 2, CX1 - x_kind, lh, [[(c["kind"], False, SK_MUTED)]], pt=T["small"],
                     anchor="ctr")
        ry += pitch
    return round((PAGE_Y + cy + PAGE_BOTTOM) / PX)


def eyebrow(page, x, y, w, text, right=None, upper=True):
    """Section head: letter-spaced, bold, muted, in capitals unless upper is False; an optional muted note on the right."""
    pt = PT["eyebrow"]
    page.textbox(x, y, w, pt * 1.25 * PT_MM, [[(text.upper() if upper else text, True, SK_MUTED)]], pt=pt,
                 spacing=0.08 * pt)
    if right:
        page.textbox(x, y, w, pt * 1.25 * PT_MM, [[(right, False, SK_MUTED)]], pt=pt, align="r")


def make_figure(folder, stem):
    """Check the case in folder and write stem.pdf, stem.svg and stem.png there."""
    global CASE
    CASE = folder.name
    page = Page()
    page_h = draw(page, folder)
    page.render(folder / stem, page_h)
    print(f"Wrote {folder / stem}.pdf, .svg and .png")
