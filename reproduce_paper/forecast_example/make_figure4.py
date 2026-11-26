"""Fig. 4: (a, b) the FLARE chlorophyll-a forecast of 14 June 2026 at FCR (1.6 m); (c) how the forecast-skill
record is built; (d) the skill record, by forecast day.

(a) The 221 ensemble members, their mean and 10th-90th percentile band for days 1-7, the observations of the
    7 days before the forecast start, the 20 µg/L operating threshold and the seasonal mean (all VERA readings
    within 14 days of the latest reading's day of the year, 13 June, in every year up to that reading).
(b) The members on each forecast day (violins split at the threshold) and the share above 20 µg/L.
(c) The steps from the FLARE and climatology forecasts, scored by VERA4cast, to the skill record shown with each
    forecast.
(d) CRPSS (%) with its 95% confidence interval, days 1-7, from the tool's skill record
    (tool/lib/skill/forecast-skill.json, which reproduce.sh rebuilds from the scores in ../forecast_skill/).

Reads members.csv, member_shares.csv, observations.csv, vera_chla_history.csv and icons/ in this folder. Makes no
API calls.

    python make_figure4.py      # writes figure4.{pdf,svg,png}
"""
import csv
import datetime as dt
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
matplotlib.rcdefaults()   # ignore any personal matplotlibrc, so local matplotlib settings cannot change the figure
import matplotlib.dates as mdates
import matplotlib.image as mpimg
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager
from matplotlib.lines import Line2D
from matplotlib.patches import FancyArrowPatch, Patch, Polygon, Rectangle
from matplotlib.ticker import FuncFormatter
from scipy.stats import gaussian_kde

HERE = Path(__file__).resolve().parent
SKILL = next(p / "tool" / "lib" / "skill" / "forecast-skill.json" for p in HERE.parents
             if (p / "tool" / "lib" / "skill" / "forecast-skill.json").exists())

try:   # the paper's figures use Arial; without it the text is drawn in DejaVu Sans
    font_manager.findfont(font_manager.FontProperties(family="Arial"), fallback_to_default=False)
    FAMILY = "Arial"
except ValueError:
    FAMILY = "DejaVu Sans"

MM = 1 / 25.4
plt.rcParams.update({
    "font.family": FAMILY,
    "font.size": 7.5, "axes.titlesize": 7.9, "axes.labelsize": 7.9,
    "xtick.labelsize": 7, "ytick.labelsize": 7, "legend.fontsize": 7,
    "font.weight": "bold", "axes.labelweight": "bold",
    "axes.linewidth": 0.5, "xtick.major.width": 0.5, "ytick.major.width": 0.5,
    "xtick.major.size": 2.5, "ytick.major.size": 2.5,
    "xtick.minor.width": 0.4, "ytick.minor.width": 0.4,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.titleweight": "bold", "axes.titlepad": 4,
    "legend.frameon": False, "lines.linewidth": 1.0,
    "pdf.fonttype": 42, "ps.fonttype": 42, "svg.fonttype": "none", "svg.hashsalt": "leads",
    "savefig.dpi": 600, "axes.unicode_minus": True,
    "mathtext.fontset": "custom", "mathtext.rm": FAMILY, "mathtext.it": f"{FAMILY}:italic",
    "mathtext.bf": f"{FAMILY}:bold", "mathtext.sf": FAMILY, "mathtext.default": "bf",
})
UGL = "µg l$^{-1}$"
THR, NM, K7, OBS_SHOW = 20.0, 221, 7, 7
REF = dt.date(2026, 6, 14)   # forecast start
d = dt.date.fromisoformat


def rows(name):
    with open(HERE / name, newline="") as fh:
        return list(csv.DictReader(fh))


# data
summ = rows("member_shares.csv")
M = np.full((NM, 14), np.nan)   # members x forecast days 1-14
for r in rows("members.csv"):
    M[int(r["member"]) - 1, int(r["day"]) - 1] = float(r["value"])
assert not np.isnan(M).any()
for r in summ:   # the members give the saved per-day numbers exactly
    k = int(r["day"]); col = M[:, k - 1]
    assert int(r["k_above_20"]) == int((col > THR).sum()) and abs(float(r["mean"]) - col.mean()) < 1e-9
    assert abs(float(r["p10"]) - np.percentile(col, 10)) < 1e-9 and abs(float(r["p90"]) - np.percentile(col, 90)) < 1e-9
S_day = np.array([int(r["day"]) for r in summ]); S_date = [d(r["date"]) for r in summ]
S_frac = np.array([float(r["fraction"]) for r in summ]); S_mean = np.array([float(r["mean"]) for r in summ])
S_p10 = np.array([float(r["p10"]) for r in summ]); S_p90 = np.array([float(r["p90"]) for r in summ])
obs = rows("observations.csv")
O_date = [d(r["date"]) for r in obs]
O_val = np.array([float(r["value"]) if r["value"] != "" else np.nan for r in obs])
O_after = np.array([r["after_forecast_start"] == "True" for r in obs])
O_rel = np.array([int(r["day_rel_to_start"]) for r in obs])
O_ok = ~np.isnan(O_val)
LATEST = O_date[[i for i in range(len(O_rel)) if O_rel[i] < 0 and O_ok[i]][-1]]   # latest reading before the start
history = {r["date"]: float(r["value"]) for r in rows("vera_chla_history.csv")}
for x, v in zip(O_date, O_val):   # the two files agree where they overlap
    if str(x) in history and not np.isnan(v):
        assert history[str(x)] == v
doy, near = LATEST.timetuple().tm_yday, []
for ds, v in history.items():   # every reading within 14 days of the same day of the year, up to the latest reading
    day = d(ds)
    if day <= LATEST and min(abs(day.timetuple().tm_yday - doy), 366 - abs(day.timetuple().tm_yday - doy)) <= 14:
        near.append(v)
SEAS_MEAN = float(np.mean(near))
skill = json.loads(SKILL.read_text(encoding="utf-8"))["fcre"]["Chla_ugL_mean"]["days"][:7]
_L7 = np.array([x["day"] for x in skill]); _V7 = np.array([x["crpss"] for x in skill])
_LO7 = np.array([x["lo"] for x in skill]); _HI7 = np.array([x["hi"] for x in skill])

# the paper's numbers: the seasonal mean (in the Results), the shares in panel b and the skill in panel d
assert LATEST == dt.date(2026, 6, 13) and len(near) == 216 and round(SEAS_MEAN, 2) == 15.74
assert [round(100 * f) for f in S_frac[:K7]] == [44, 61, 70, 71, 75, 76, 77]
assert [round(v) for v in _V7] == [62, 55, 47, 41, 35, 29, 24] and (_LO7 > 0).all()

# layout (mm on a 183 mm wide page)
FH = 138.0
fig = plt.figure(figsize=(183 * MM, FH * MM))
TOP = 1 - 10.9 / FH; BOT = TOP - 46.1 / FH
RIGHT_PAD = 3.0
XC0, WC = 2.2, 96.0
XL1 = XC0 + WC - RIGHT_PAD; XRC = XC0 + WC; XD0 = XRC + 12.0
XA0, XR1 = 0.068 * 183, 182.7
ax1 = fig.add_axes([XA0 / 183, BOT, (XL1 - XA0) / 183, TOP - BOT])
ax2 = fig.add_axes([XD0 / 183, BOT, (XR1 - XD0) / 183, TOP - BOT])
B0 = 9.6 / FH; B1 = B0 + 56.0 / FH
DW = XR1 - XD0
axw = fig.add_axes([XC0 / 183, B0, WC / 183, 56.0 / FH])
axd = fig.add_axes([XD0 / 183, B0, DW / 183, 56.0 / FH])

# panel a: forecast with members, band, observations, threshold and seasonal mean
C_ENS, C_THR, C_SEAS, C_BAND, A_BAND = "#0072B2", "#D55E00", "#4e8b5a", "#8C96A0", 0.28
x_fc = np.array([mdates.date2num(x) for x in S_date])[:K7]
M7 = M[:, :K7]
X_L0, X_L1 = mdates.date2num(REF - dt.timedelta(days=OBS_SHOW)), x_fc[-1]
for i in range(NM):
    ax1.plot(x_fc, M7[i], color="0.55", lw=0.25, alpha=0.18, zorder=1, solid_capstyle="round")
ax1.fill_between(x_fc, S_p10[:K7], S_p90[:K7], color=C_BAND, alpha=A_BAND, lw=0, zorder=2)
ax1.plot(x_fc, S_mean[:K7], color=C_ENS, lw=1.2, zorder=4)
ax1.hlines(20, X_L0, X_L1, color=C_THR, lw=0.8, zorder=3)
ax1.axvline(mdates.date2num(REF), color="0.2", lw=0.6, ls=(0, (3, 2)), zorder=3)
pre = ~O_after & O_ok & (O_rel >= -OBS_SHOW)
ax1.plot([mdates.date2num(x) for x, p in zip(O_date, pre) if p], O_val[pre], "o",
         ms=2.6, mfc="black", mec="black", mew=0.4, zorder=6, ls="none")
ax1.hlines(SEAS_MEAN, X_L0, X_L1, color=C_SEAS, lw=0.9, ls=(0, (5, 3)), zorder=3)
ymax = float(np.ceil((max(M7.max(), np.nanmax(O_val[pre])) + 4.0) / 5.0) * 5)
assert ymax == 60
ax1.set_ylim(0, ymax)
ax1.set_xlim(mdates.date2num(REF - dt.timedelta(days=OBS_SHOW)) - 0.8, x_fc[-1] + 0.8)
ax1.set_xticks([mdates.date2num(REF + dt.timedelta(days=k)) for k in (-7, -4, 0, 3, 7)])
ax1.xaxis.set_minor_locator(mdates.DayLocator())
ax1.xaxis.set_major_formatter(FuncFormatter(lambda x, pos: f"{mdates.num2date(x).day} {mdates.num2date(x):%b}"))
ax1.tick_params(axis="x", which="minor", length=1.2)
ax1.set_xlabel("Date (2026)")
ax1.set_ylabel(f"Chlorophyll-a ({UGL})")
ax1.text(X_L0, 20 + 0.6, "algal operating threshold", color=C_THR, fontsize=7, ha="left", va="bottom")
ax1.text(mdates.date2num(REF), ymax * 1.01, "forecast start", fontsize=7, ha="center", va="bottom", color="0.2", clip_on=False)
handles = [
    Line2D([], [], marker="o", ls="none", ms=2.6, mfc="black", mec="black", label="observations"),
    Line2D([], [], color="0.55", lw=0.6, alpha=0.6, label=f"members (n = {NM})"),
    Line2D([], [], color=C_ENS, lw=1.2, label="ensemble mean"),
    Patch(facecolor=C_BAND, alpha=A_BAND, lw=0, label="10th–90th percentile"),
    Line2D([], [], color=C_SEAS, lw=0.9, ls=(0, (5, 3)), label="seasonal mean"),
]
ax1.legend(handles=handles, loc="upper left", bbox_to_anchor=(0.0, 1.02), handlelength=1.4,
           handletextpad=0.5, borderaxespad=0.2, labelspacing=0.3)

# panel b: members on each forecast day, split at the threshold, with the share above it
k7 = S_day <= 7
ax2.set_ylim(0, ymax)
_grid = np.unique(np.r_[np.linspace(0, ymax, 600), THR])
HW = 0.42
B_ABOVE, B_BELOW, B_LAB = "#F1D7CC", "#C4DCEA", "#B8481F"
B_EDGE_ABOVE, B_EDGE_BELOW = "#DE5C2B", "#2F6EB5"
for kd, fr in zip(S_day[k7], S_frac[k7]):
    v = M[:, int(kd) - 1]
    dens_full = gaussian_kde(v)(_grid)
    keep = (dens_full >= 0.01 * dens_full.max()) & (_grid >= v.min()) & (_grid <= v.max())
    g = _grid[keep]; dens = dens_full[keep]
    w = HW * dens / dens.max()
    below = g <= THR + 0.3; above = g >= THR
    for msk, fc in ((below, B_BELOW), (above, B_ABOVE)):
        xs = np.r_[kd - w[msk], (kd + w[msk])[::-1]]; ys = np.r_[g[msk], g[msk][::-1]]
        ax2.add_patch(Polygon(np.c_[xs, ys], closed=True, fc=fc, ec="none", alpha=1.0, zorder=2))
    for msk, ec in ((g <= THR, B_EDGE_BELOW), (g >= THR, B_EDGE_ABOVE)):
        if msk.sum() < 2:
            continue
        gg, ww = g[msk], w[msk]
        end = 0 if ec == B_EDGE_BELOW else -1
        ax2.plot(kd - ww, gg, color=ec, lw=0.6, zorder=3, solid_capstyle="butt")
        ax2.plot(kd + ww, gg, color=ec, lw=0.6, zorder=3, solid_capstyle="butt")
        ax2.plot([kd - ww[end], kd + ww[end]], [gg[end]] * 2, color=ec, lw=0.6, zorder=3, solid_capstyle="butt")
    ax2.plot([kd - 0.12, kd + 0.12], [v.mean()] * 2, color="black", lw=0.8, zorder=4)
    ax2.text(kd, ymax * 0.985, f"{100 * fr:.0f}%", ha="center", va="top", fontsize=6.8, fontweight="bold", color=B_LAB, zorder=5)
ax2.axhline(THR, color="black", lw=0.8, zorder=1)
ax2.set_ylabel(f"Chlorophyll-a ({UGL})")
ax2.set_xticks(range(1, 8)); ax2.set_xlim(0.45, 7.55)
ax2.set_xlabel("Forecast day")
ax2.set_title(f"Members above 20 {UGL}")
ax2.tick_params(axis="x", length=0, pad=plt.rcParams["xtick.major.pad"] + plt.rcParams["xtick.major.size"])

# panel c: how the skill record is built: VERA4cast steps 1-3, LEADS steps 4-6
TXT = 13.0 * 180.7 / 297.0
ARROW, ARROW_LW = "#4A5560", 1.2
STEPS_TOP = [(1, "ssid_chart_boxed", "FLARE and\nclimatology\nforecasts"), (2, "fact_check", "Scored against\nobservations"),
             (3, "database", "Public score\narchive")]
STEPS_BOT = [(4, "skill_curve_boxed", "Past forecast\nskill by forecast\nday, with 95% CI"), (5, "link", "Matched to each\nforecast day"),
             (6, "chat", "Shown with each\nforecast as its\nskill record")]
LANES = {"VERA4cast": dict(fill="E0F1F5", icon="3B4148", label="2C3137"), "LEADS": dict(fill="EDEFDC", icon="5D6921", label="4A5516")}
items = []


def add(z, kind, **kw):
    items.append((z, len(items), kind, kw))


_pw = axw.get_position(); W, H = _pw.width * 183.0, _pw.height * FH
axw.set_xlim(0, W); axw.set_ylim(0, H); axw.set_aspect("equal"); axw.set_axis_off()
Wl = W - RIGHT_PAD; gap = 1.6; lane_h = (H - gap) / 2
for y0, name in ((H - lane_h, "VERA4cast"), (0.0, "LEADS")):
    col = LANES[name]
    add(0, "rect", x=0, y=y0, w=Wl, h=lane_h, fc="#" + col["fill"])
    add(5, "text", x=2.2, y=y0 + lane_h - 2.5, s=name, size=TXT, color="#" + col["label"], bold=True, ha="left", va="center", spacing=1.15)
ic = 9.0; x0, x2 = 21.5, Wl - 18.0; xs = [x0, x0 + 0.5 * (x2 - x0), x2]; tops = [H - 4.8, lane_h - 4.8]
for steps, top, order, lane in ((STEPS_TOP, tops[0], xs, "VERA4cast"), (STEPS_BOT, tops[1], xs[::-1], "LEADS")):
    col = LANES[lane]
    for (n, icon, title), x in zip(steps, order):
        add(4, "image", x=x - ic / 2, y=top - ic, w=ic, h=ic, path=HERE / "icons" / f"{icon}_{col['icon']}.png")
        add(5, "text", x=x - ic / 2 - 1.0, y=top - 1.6, s=str(n), size=TXT, color="#" + col["label"], bold=True, ha="right", va="center", spacing=1.15)
        add(5, "text", x=x, y=top - ic - 1.2, s=title, size=TXT, color="#1E2A33", bold=True, ha="center", va="top", spacing=1.12)
cy = [t - ic / 2 for t in tops]; num_w = 2.6
for p, q, y in ((xs[0] + ic / 2 + 1.2, xs[1] - ic / 2 - 1.0 - num_w, cy[0]), (xs[1] + ic / 2 + 1.2, xs[2] - ic / 2 - 1.0 - num_w, cy[0]),
                (xs[2] - ic / 2 - 1.0 - num_w, xs[1] + ic / 2 + 1.2, cy[1]), (xs[1] - ic / 2 - 1.0 - num_w, xs[0] + ic / 2 + 1.2, cy[1])):
    add(2.5, "arrow", pts=[(float(p), float(y)), (float(q), float(y))])
y_from = tops[0] - ic - 1.2 - (STEPS_TOP[2][2].count("\n") + 1) * TXT * 1.12 * 25.4 / 72 - 0.8
add(2.5, "arrow", pts=[(float(xs[2]), float(y_from)), (float(xs[2]), float(tops[1] + 0.6))])
for z, _, kind, kw in sorted(items, key=lambda t: (t[0], t[1])):
    if kind == "rect":
        p = Rectangle((kw["x"], kw["y"]), kw["w"], kw["h"], fc=kw["fc"], ec="none", lw=0.0, fill=True); p.set_zorder(z); axw.add_patch(p)
    elif kind == "image":
        axw.imshow(mpimg.imread(kw["path"]), extent=(kw["x"], kw["x"] + kw["w"], kw["y"], kw["y"] + kw["h"]), zorder=z, interpolation="antialiased")
    elif kind == "text":
        axw.text(kw["x"], kw["y"], kw["s"], fontsize=kw["size"], color=kw["color"], fontweight="bold" if kw["bold"] else "normal",
                 ha=kw["ha"], va=kw["va"], linespacing=kw["spacing"], zorder=z)
    elif kind == "arrow":
        axw.add_patch(FancyArrowPatch(kw["pts"][-2], kw["pts"][-1], arrowstyle="-|>", mutation_scale=9.0, lw=ARROW_LW,
                                      color=ARROW, zorder=z, shrinkA=0, shrinkB=0))
axw.set_xlim(0, W); axw.set_ylim(0, H); axw.set_aspect("equal")

# panel d: skill record, days 1-7
D_LINE, D_BAND = "#9E2A2B", "#D99A9B"
axd.fill_between(_L7, _LO7, _HI7, color=D_BAND, alpha=0.40, lw=0, zorder=2)
axd.plot(_L7, _V7, color=D_LINE, lw=0.9, zorder=4, marker="o", ms=2.2, mfc="black", mec="white", mew=0.4)
for _l, _v in zip(_L7, _V7):
    axd.text(_l, _v + 2.6, f"+{_v:.0f}%", ha="center", va="bottom", fontsize=6.5, fontweight="bold", color="black", zorder=5)
axd.set_xlim(0.45, 7.55); axd.set_ylim(0, 80)
axd.set_xticks(range(1, 8)); axd.set_yticks([0, 20, 40, 60, 80])
axd.tick_params(axis="x", length=0, pad=plt.rcParams["xtick.major.pad"] + plt.rcParams["xtick.major.size"])
axd.set_xlabel("Forecast day"); axd.set_ylabel("CRPSS (%)")
axd.text(0.6, 1.6, "0 = as skilful as climatology", fontsize=6.2, color="0.35", ha="left", va="bottom")
axd.set_title("Chlorophyll-a forecast skill")

# panel letters
_ytop = TOP + 5.8 / FH; LET_AC = 0.45
fig.text(LET_AC / 183, _ytop, "a", fontsize=9, fontweight="bold", ha="left", va="bottom")
fig.text(XRC / 183, _ytop, "b", fontsize=9, fontweight="bold", ha="left", va="bottom")
fig.text(LET_AC / 183, B1 + 2.4 / FH, "c", fontsize=9, fontweight="bold", ha="left", va="bottom")
fig.text(axd.get_position().x0 - 12.0 / 183, B1 + 2.4 / FH, "d", fontsize=9, fontweight="bold", ha="left", va="bottom")
fig.canvas.draw()
meta = {"pdf": {"CreationDate": None, "ModDate": None}, "svg": {"Date": None}, "png": None}
for ext in ("pdf", "svg", "png"):
    fig.savefig(HERE / f"figure4.{ext}", bbox_inches="tight", pad_inches=0.02, metadata=meta[ext])
print(f"Wrote {HERE / 'figure4.pdf'}")
