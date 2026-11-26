"""Fig. 5: (a) RAGAS scores of the 30 benchmark answers; (b) evidence sources used, by question type.

(a) Mean, median, bootstrap 95% confidence interval of the mean (10,000 resamples) and
    interquartile range of each metric, from ragas_scores.csv.
(b) Ribbons join each question type to the sources its answers used (evidence_use.py); ribbon width
    is the number of answers. Node order minimises ribbon crossings weighted by ribbon width (exhaustive search).

    python make_figure5.py      # writes figure5.{pdf,svg,png}
"""
import itertools

import numpy as np
from matplotlib.lines import Line2D
from matplotlib.patches import Patch, PathPatch, Rectangle
from matplotlib.path import Path as MPath

from common import CATEGORIES, CHANNELS, HERE, METRICS, load_scores, save_figure, setup_matplotlib
from evidence_use import summarise

plt = setup_matplotlib()
INK, GRID, MUTED = "#1A1A1A", "#CFCFCF", "#6B6B6B"
TEAL, SAND, MEDIAN = "#1B998B", "#E9D3AE", "#B0443A"
METRIC_NAMES = {"faithfulness": "Faithfulness", "answer_relevancy": "Answer\nrelevancy",
                "context_precision_no_ref": "Context\nprecision", "context_recall": "Context\nrecall"}
CHANNEL_STYLE = {"literature": ("Literature", "#0072B2"), "sensor": ("Sensor", "#009E73"),
                 "forecast": ("Ensemble forecast\n(FLARE)", "#E69F00"), "tool_output": ("Tool outputs", "#CC79A7")}


def bootstrap_ci(x, n=10000, seed=7):
    rng = np.random.default_rng(seed)
    return np.percentile(rng.choice(x, size=(n, len(x)), replace=True).mean(axis=1), [2.5, 97.5])


def radar(ax, fig):
    s = load_scores()
    S = np.array([[s[q][m] for m in METRICS] for q in s])
    mean, med = S.mean(axis=0), np.median(S, axis=0)
    q1, q3 = np.percentile(S, [25, 75], axis=0)
    ci = np.array([bootstrap_ci(S[:, j]) for j in range(len(METRICS))])
    theta = np.arange(4) * np.pi / 2
    close = lambda v: np.append(v, v[0])
    ax.set_theta_offset(np.pi / 2); ax.set_theta_direction(-1)

    # bands with straight edges between adjacent axes
    tt = np.linspace(0, 2 * np.pi, 400)
    def band_edge(vals):
        tc = np.append(theta, 2 * np.pi)
        xs, ys = close(vals) * np.cos(tc), close(vals) * np.sin(tc)
        seg = np.clip(np.searchsorted(tc, tt, side="right") - 1, 0, 3)
        x0, y0, x1, y1 = xs[seg], ys[seg], xs[seg + 1], ys[seg + 1]
        dx, dy = x1 - x0, y1 - y0
        return (x0 * dy - y0 * dx) / (np.cos(tt) * dy - np.sin(tt) * dx)
    ax.fill_between(tt, band_edge(q1), band_edge(q3), color=SAND, alpha=0.75, lw=0, zorder=1)
    ax.fill_between(tt, band_edge(ci[:, 0]), band_edge(ci[:, 1]), color=TEAL, alpha=0.42, lw=0, zorder=2)
    ax.scatter(theta, med, marker="D", s=30, color=MEDIAN, edgecolor="none", zorder=6, clip_on=False)
    ax.plot(close(theta), close(mean), color=INK, lw=1.3, zorder=5, solid_joinstyle="round")
    ax.scatter(theta, mean, s=15, color="white", edgecolor=INK, linewidth=1.1, zorder=9, clip_on=False)

    ax.set_xlim(0, 2 * np.pi); ax.set_ylim(0, 1.0)
    ax.set_yticks([0.25, 0.5, 0.75, 1.0])
    # Ring labels run along the Context recall axis, where the scores are farthest from the centre, so they never cover
    # the score polygon; the outer ring (1) is left unlabelled because the note under the legend gives the 0-1 range
    ax.set_yticklabels(["0.25", "0.50", "0.75", ""], fontsize=7, color="#3D3D3D")
    ax.set_rlabel_position(270)
    ax.yaxis.set_zorder(10)
    for lab in ax.get_yticklabels():
        lab.set_bbox(dict(fc="white", ec="none", alpha=0.85, pad=0.6))
    ax.set_xticks(theta); ax.set_xticklabels([])
    ax.yaxis.grid(True, color=GRID, lw=0.45, ls=(0, (2.2, 1.6)))
    ax.xaxis.grid(True, color=GRID, lw=0.45)
    ax.spines["polar"].set_color("#9A9A9A"); ax.spines["polar"].set_linewidth(0.6)
    place = {0: ((0, 7), "center", "bottom"), 1: ((7, 0), "left", "center"),
             2: ((0, -7), "center", "top"), 3: ((-7, 0), "right", "center")}
    for j, m in enumerate(METRICS):
        off, ha, va = place[j]
        ax.annotate(METRIC_NAMES[m], xy=(theta[j], 1.0), xytext=off, textcoords="offset points", ha=ha, va=va,
                    fontsize=8, fontweight="bold", color=INK, annotation_clip=False, linespacing=1.1)
    handles = [Line2D([], [], color=INK, lw=1.3, marker="o", ms=3.5, mfc="white", mec=INK),
               Line2D([], [], marker="D", ls="", mfc=MEDIAN, mec="none", ms=3.8),
               Patch(fc=TEAL, alpha=0.42, lw=0), Patch(fc=SAND, alpha=0.75, lw=0)]
    # scale note under the legend
    fig.text(0.25, 0.017, "Scores range from 0 to 1; higher is better.", ha="center", va="bottom", fontsize=7,
             color="#444444")
    fig.legend(handles, ["Mean", "Median", "95% CI of mean", "Interquartile range ($n$ = 30)"], loc="lower center",
               bbox_to_anchor=(0.25, 0.046), ncol=4, frameon=False, fontsize=6.8, handlelength=1.4, columnspacing=1.0)


def alluvial(ax):
    ev = summarise()
    N, K = ev["answers_per_type"], {(c, ch): ev["answers_using_channel"][c][ch] for c in CATEGORIES for ch in CHANNELS}
    uses = {c: sum(K[(c, ch)] for ch in CHANNELS) for c in CATEGORIES}
    chu = {ch: sum(K[(c, ch)] for c in CATEGORIES) for ch in CHANNELS}
    flows = [(c, ch, K[(c, ch)]) for c in CATEGORIES for ch in CHANNELS if K[(c, ch)]]

    def crossings(lo, ro):
        pl, pr = {t: i for i, t in enumerate(lo)}, {c: i for i, c in enumerate(ro)}
        return sum(w1 * w2 for (a, b, w1), (c, d, w2) in itertools.combinations(flows, 2)
                   if (pl[a] - pl[c]) * (pr[b] - pr[d]) < 0)
    _, left, right = min(((crossings(lo, ro), lo, ro) for lo in itertools.permutations(CATEGORIES)
                          for ro in itertools.permutations(CHANNELS)), key=lambda x: x[0])

    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis("off")
    gap = 0.025
    unit = (1 - gap * (len(CATEGORIES) - 1)) / sum(uses.values())
    gap_r = (1 - unit * sum(chu.values())) / (len(CHANNELS) - 1)
    XL, XR, W = 0.30, 0.66, 0.035
    yl, y = {}, 1.0
    for c in left:
        h = uses[c] * unit; yl[c] = (y - h, y); y -= h + gap
    yr, y = {}, 1.0
    for ch in right:
        h = chu[ch] * unit; yr[ch] = (y - h, y); y -= h + gap_r
    lcur, rcur = {c: yl[c][1] for c in left}, {ch: yr[ch][1] for ch in right}
    lslot, rslot = {}, {}
    for c in left:
        for ch in right:
            if K[(c, ch)]:
                h = K[(c, ch)] * unit; lslot[(c, ch)] = (lcur[c] - h, lcur[c]); lcur[c] -= h
    for ch in right:
        for c in left:
            if K[(c, ch)]:
                h = K[(c, ch)] * unit; rslot[(c, ch)] = (rcur[ch] - h, rcur[ch]); rcur[ch] -= h
    x0, x1 = XL + W, XR
    MIN_SEP = 0.040    # smallest centre-to-centre gap (axes units) between two count labels, so bold 7 pt digits never touch
    labels = {}        # question type -> [[y, k]], top to bottom
    for (c, ch), (l0, l1) in lslot.items():
        r0, r1 = rslot[(c, ch)]; xm = (x0 + x1) / 2
        verts = [(x0, l1), (xm, l1), (xm, r1), (x1, r1), (x1, r0), (xm, r0), (xm, l0), (x0, l0), (x0, l1)]
        codes = [MPath.MOVETO, MPath.CURVE4, MPath.CURVE4, MPath.CURVE4, MPath.LINETO,
                 MPath.CURVE4, MPath.CURVE4, MPath.CURVE4, MPath.CLOSEPOLY]
        ax.add_patch(PathPatch(MPath(verts, codes), fc=CHANNEL_STYLE[ch][1], ec="none", alpha=0.45, zorder=1))
        labels.setdefault(c, []).append([(l0 + l1) / 2, K[(c, ch)]])
    for c, labs in labels.items():
        # all counts stay in one straight column; two that sit too close are spread apart vertically, half each way
        for i in range(1, len(labs)):
            gap = labs[i - 1][0] - labs[i][0]
            if gap < MIN_SEP:
                labs[i - 1][0] += (MIN_SEP - gap) / 2
                labs[i][0] -= (MIN_SEP - gap) / 2
        for ym, k in labs:
            ax.text(x0 + 0.012, ym, str(k), fontsize=7, fontweight="bold", va="center", ha="left", color=INK, zorder=3)
    for c in left:
        a, b = yl[c]
        ax.add_patch(Rectangle((XL, a), W, b - a, fc="#4A4A4A", ec="none", zorder=2))
        ax.text(XL - 0.015, (a + b) / 2 + 0.008, CATEGORIES[c], ha="right", va="bottom", fontsize=7, fontweight="bold")
        ax.text(XL - 0.015, (a + b) / 2 - 0.004, f"$n$ = {N[c]}", ha="right", va="top", fontsize=6.5, color="#6A6A6A")
    for ch in right:
        a, b = yr[ch]
        ax.add_patch(Rectangle((XR, a), W, b - a, fc=CHANNEL_STYLE[ch][1], ec="none", zorder=2))
        ax.text(XR + W + 0.015, (a + b) / 2, CHANNEL_STYLE[ch][0], ha="left", va="center", fontsize=7, fontweight="bold", color=INK, linespacing=1.1)
    ax.text(XL + W / 2, -0.035, "Question type", ha="center", va="top", fontsize=8, fontweight="bold", color="#333333")
    ax.text(XR + W / 2, -0.035, "Evidence used", ha="center", va="top", fontsize=8, fontweight="bold", color="#333333")


def main():
    fig = plt.figure(figsize=(183 / 25.4, 88 / 25.4))
    radar(fig.add_axes([0.10, 0.22, 0.30, 0.62], projection="polar"), fig)
    alluvial(fig.add_axes([0.52, 0.12, 0.46, 0.78]))
    fig.text(0.012, 0.965, "a", fontsize=9, fontweight="bold", va="top")
    fig.text(0.512, 0.965, "b", fontsize=9, fontweight="bold", va="top")
    save_figure(fig, HERE / "figure5")
    print(f"Wrote {HERE / 'figure5.pdf'}")


if __name__ == "__main__":
    main()
