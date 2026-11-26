"""Fig. 6: expert ratings of LEADS answers, from expert_ratings.csv (300 ratings). Makes no API calls.

Left: share of ratings at each score (1-5) for each criterion, with mean ± s.d. (50 ratings each).
Right: mean rating of each question (5 experts x 6 criteria = 30 ratings), for all 10 questions, the
    manager-framed (Q1-Q6) and the researcher-framed (Q7-Q10) ones. Box = interquartile range, line = median,
    whiskers = furthest question mean within 1.5 x interquartile range of the box, dots = questions,
    white circle = mean.
It also prints the rating counts, means and s.d. reported in Results.

    python make_figure6.py      # writes figure6.{pdf,svg,png}
"""
import csv
from pathlib import Path

import numpy as np
from matplotlib.patches import Circle, Rectangle

HERE = Path(__file__).parent


def setup_matplotlib():
    import matplotlib
    matplotlib.use("Agg")
    matplotlib.rcdefaults()   # ignore any personal matplotlibrc, so local matplotlib settings cannot change the figures
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    try:
        font_manager.findfont(font_manager.FontProperties(family="Arial"), fallback_to_default=False)
        family = "Arial"
    except ValueError:
        family = "DejaVu Sans"
    plt.rcParams.update({"font.family": family, "font.size": 6.5, "pdf.fonttype": 42, "svg.fonttype": "none",
                         "svg.hashsalt": "leads", "mathtext.fontset": "custom", "mathtext.rm": family,
                         "mathtext.it": f"{family}:italic"})
    return plt

def save_figure(fig, path):
    """Save PDF, SVG and 600-dpi PNG without creation dates, so repeated runs give identical files."""
    path.parent.mkdir(exist_ok=True)
    fig.savefig(f"{path}.pdf", metadata={"CreationDate": None, "ModDate": None})
    fig.savefig(f"{path}.svg", metadata={"Date": None})
    fig.savefig(f"{path}.png", dpi=600)



plt = setup_matplotlib()
ARIAL = plt.rcParams["font.family"] == ["Arial"]   # without Arial, setup_matplotlib() uses DejaVu Sans
CRITERIA = [("accuracy", "Accuracy"), ("completeness", "Completeness"), ("verbosity", "Verbosity"),
            ("clarity", "Clarity"), ("actionability", "Actionability"),
            ("reasoning_transparency", "Reasoning transparency")]
MANAGER, RESEARCHER = range(1, 7), range(7, 11)   # questions asked from the manager and the researcher profile

# The figure is laid out in millimetres (y pointing down) on a 183 mm wide canvas, as in the paper.
W_MM = 183.0
FS, FS_LEG = 7, 6   # font sizes (pt)
LIKERT = ["#EAF2F9", "#C9DEF0", "#99C3E1", "#5092C7", "#3464A4"]   # scores 1 to 5
SEP, GRID, SWATCH_LINE, INK = "#FFFFFF", "#DDE3EA", "#C3CDD8", "#1A1A18"
# fill, line and dot colours of the boxes: all, manager-framed and researcher-framed questions
BOX = [("#C4C4C4", "#555555", "#555555"), ("#E8BCD6", "#8C4A7E", "#8C4A7E"), ("#F3C96B", "#A6740F", "#8F6309")]
# Width (mm) of the tick label "3.5" at 7 pt, which places the y-axis title: in Arial, measured once with Pillow 12.3.0
# (Raqm layout) from the macOS Arial.ttf; 3.93 in DejaVu Sans. A constant keeps the layout the same on every computer.
LABEL_3_5_MM = 3.432693142361111 if ARIAL else 3.93


def numbers():
    """Numbers of Fig. 6, rounded as for the paper's figure, which is drawn from them."""
    with open(HERE / "expert_ratings.csv", newline="") as fh:
        rows = list(csv.DictReader(fh))
    R = np.array([[int(r[c]) for c, _ in CRITERIA] for r in rows])   # one row per rated answer
    question = np.array([int(r["question"][1:]) for r in rows])
    qmean = {q: R[question == q].mean() for q in range(1, 11)}

    def box(qs):   # quartiles as numpy.percentile; whiskers to the furthest point within 1.5 x IQR
        v = np.array([qmean[q] for q in qs])
        q1, med, q3 = np.percentile(v, [25, 50, 75])
        iqr = q3 - q1
        b = {"mean": v.mean(), "median": med, "q1": q1, "q3": q3,
             "whisker_lo": v[v >= q1 - 1.5 * iqr].min(), "whisker_hi": v[v <= q3 + 1.5 * iqr].max()}
        return {k: round(float(x), 3) for k, x in b.items()}

    return {"experts": len({r["reviewer"] for r in rows}), "ratings": R.size, "mean": round(float(R.mean()), 3),
            "count": {k: int((R == k).sum()) for k in range(1, 6)},
            "criteria": [{"criterion": name, "mean": round(float(R[:, j].mean()), 2),
                          "sd": round(float(R[:, j].std(ddof=1)), 2),
                          "pct": [round(float(100 * (R[:, j] == k).sum() / len(R)), 1) for k in range(1, 6)]}
                         for j, (_, name) in enumerate(CRITERIA)],
            "query_means": {q: round(float(m), 3) for q, m in qmean.items()},
            "boxes": {"All queries": box(range(1, 11)), "Manager-framed": box(MANAGER),
                      "Researcher-framed": box(RESEARCHER)}}


def layout(N):
    """Rectangles, circles, lines and texts in drawing order (mm), and the canvas height. The box-plot area is
    square; its x axis shares the baseline of the bars and its top (rating 5) the top of the first bar row."""
    items = []
    rect = lambda **k: items.append({"k": "rect", "lw": 0.45, **k})
    oval = lambda **k: items.append({"k": "oval", **k})
    line = lambda **k: items.append({"k": "line", "color": INK, "lw": 0.6, **k})
    text = lambda **k: items.append({"k": "text", "size": FS, "bold": False, "ha": "left", "va": "center",
                                     "color": INK, "rot": 0, **k})

    # left panel: share of ratings at each score
    crit = N["criteria"]
    LX = 29.6                        # right edge of the criterion labels
    BX0, BW = 31.6, 74.0             # bars: x origin, width of 100%
    TOP, PITCH, BH = 5.0, 7.2, 4.4   # first row top, row pitch, bar height
    AY = TOP + PITCH * len(crit)     # x axis baseline, shared with the box plot
    MX = BX0 + BW + 2.0              # mean ± s.d. column
    text(x=MX, y=TOP - 2.0, s="Mean ± s.d.", bold=True)
    for v in range(20, 101, 20):     # light vertical gridlines behind the bars
        xv = BX0 + BW * v / 100
        line(x0=xv, y0=TOP + 0.4, x1=xv, y1=AY, color=GRID, lw=0.4)
    for i, c in enumerate(crit):
        yc = TOP + PITCH * (i + 0.5)
        text(x=LX, y=yc, s=c["criterion"], ha="right")
        x = BX0
        for k, p in enumerate(c["pct"]):
            if p > 0:
                w = BW * p / 100
                rect(x=x, y=yc - BH / 2, w=w, h=BH, fill=LIKERT[k], line=SEP, lw=0.6)
                x += w
        text(x=MX, y=yc, s=f"{c['mean']:.2f} ± {c['sd']:.2f}")
    line(x0=BX0, y0=AY, x1=BX0 + BW, y1=AY)
    for v in range(0, 101, 20):
        xv = BX0 + BW * v / 100
        line(x0=xv, y0=AY, x1=xv, y1=AY + 1.0)
        text(x=xv, y=AY + 1.5, s=str(v), ha="center", va="top")
    text(x=BX0 + BW / 2, y=AY + 5.0, s="Percentage of ratings", ha="center", va="top")
    LEG_Y, SQ, SQH = AY + 11.6, 3.4, 2.6   # legend centre line, swatch width and height
    lx0 = BX0 + BW / 2 - 2.5 * SQ
    for k in range(5):
        rect(x=lx0 + k * SQ, y=LEG_Y - SQH / 2, w=SQ, h=SQH, fill=LIKERT[k], line=SWATCH_LINE, lw=0.45)
        text(x=lx0 + (k + 0.5) * SQ, y=LEG_Y, s=str(k + 1), size=FS_LEG, ha="center",
             color="#FFFFFF" if k == 4 else INK)
    text(x=lx0 - 1.2, y=LEG_Y, s="Strongly disagree", size=FS_LEG, ha="right")
    text(x=lx0 + 5 * SQ + 1.2, y=LEG_Y, s="Strongly agree", size=FS_LEG)

    # right panel: question means, rating 3 to 5 on a square plot area
    PY0, PY1 = TOP, AY
    SIDE = PY1 - PY0
    AX1 = W_MM - 2.9
    AX0 = AX1 - SIDE
    X_LO, X_HI = 0.5, 3.5            # three evenly spaced groups at x = 1, 2, 3
    xr = lambda p: AX0 + SIDE * (p - X_LO) / (X_HI - X_LO)
    yr = lambda v: PY1 - SIDE * (v - 3) / 2
    line(x0=AX0, y0=PY0, x1=AX0, y1=PY1)
    line(x0=AX0, y0=PY1, x1=AX1, y1=PY1)
    for v, lab in [(3, "3"), (3.5, "3.5"), (4, "4"), (4.5, "4.5"), (5, "5")]:
        line(x0=AX0 - 1.0, y0=yr(v), x1=AX0, y1=yr(v))
        text(x=AX0 - 1.5, y=yr(v), s=lab, ha="right")
    text(x=AX0 - 1.5 - LABEL_3_5_MM - 2.2, y=(PY0 + PY1) / 2, s="Query mean rating", ha="center", rot=90)

    names = ["All\nqueries", "Manager-\nframed", "Researcher-\nframed"]
    qm = N["query_means"]
    members = [[qm[q] for q in range(1, 11)], [qm[q] for q in MANAGER], [qm[q] for q in RESEARCHER]]
    BOXW = 0.45
    hw = xr(1 + BOXW / 2) - xr(1)     # half box width (mm); caps are half the box width
    for j, b in enumerate(N["boxes"].values()):
        fill, ln, dot = BOX[j]
        xc = xr(j + 1)
        line(x0=xc, y0=yr(b["whisker_hi"]), x1=xc, y1=yr(b["q3"]), color=ln, lw=0.8)
        line(x0=xc, y0=yr(b["q1"]), x1=xc, y1=yr(b["whisker_lo"]), color=ln, lw=0.8)
        for wv in (b["whisker_hi"], b["whisker_lo"]):
            line(x0=xc - hw / 2, y0=yr(wv), x1=xc + hw / 2, y1=yr(wv), color=ln, lw=0.8)
        rect(x=xc - hw, y=yr(b["q3"]), w=2 * hw, h=yr(b["q1"]) - yr(b["q3"]), fill=fill, line=ln, lw=0.8)
        line(x0=xc - hw, y0=yr(b["median"]), x1=xc + hw, y1=yr(b["median"]), color=ln, lw=1.0)
        for v in members[j]:           # one dot per question, over the box; the white edge keeps touching dots apart
            oval(cx=xc, cy=yr(v), r=0.45, fill=dot, line="#FFFFFF", lw=0.25)
        oval(cx=xc, cy=yr(b["mean"]), r=0.9, fill="#FFFFFF", line=INK, lw=0.8)
        line(x0=xc, y0=PY1, x1=xc, y1=PY1 + 1.0)
        text(x=xc, y=PY1 + 1.5, s=names[j], ha="center", va="top")
    return items, round(LEG_Y + SQH / 2 + 1.9, 1)


def draw(items, height):
    """Draw the items in order, each on top of the previous ones."""
    # Without Arial the text is drawn in DejaVu Sans, which is wider: 2 mm more on the left keeps every label inside.
    pad = 0 if ARIAL else 2
    fig = plt.figure(figsize=((W_MM + pad) / 25.4, height / 25.4))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(-pad, W_MM)
    ax.set_ylim(height, 0)
    ax.set_aspect("equal")
    ax.axis("off")
    for z, it in enumerate(items, start=2):
        if it["k"] == "rect":
            ax.add_patch(Rectangle((it["x"], it["y"]), it["w"], it["h"], facecolor=it["fill"], edgecolor=it["line"],
                                   linewidth=it["lw"], zorder=z))
        elif it["k"] == "oval":
            ax.add_patch(Circle((it["cx"], it["cy"]), it["r"], facecolor=it["fill"], edgecolor=it["line"],
                                linewidth=it["lw"], zorder=z))
        elif it["k"] == "line":
            ax.plot([it["x0"], it["x1"]], [it["y0"], it["y1"]], color=it["color"], linewidth=it["lw"],
                    solid_capstyle="butt", zorder=z)
        else:
            ax.text(it["x"], it["y"], it["s"], fontsize=it["size"], fontweight="bold" if it["bold"] else "normal",
                    ha=it["ha"], va=it["va"], color=it["color"], rotation=it["rot"], linespacing=1.15, zorder=z)
    return fig


def main():
    N = numbers()
    n, count = N["ratings"], N["count"]
    high = count[4] + count[5]
    print(f"{n} ratings from {N['experts']} experts on {len(N['query_means'])} questions, mean {N['mean']:.2f}")
    print(f"Rated 4 or 5: {high} of {n} ({100 * high / n:.0f}%); rated 2: {count[2]} ({100 * count[2] / n:.0f}%); "
          f"rated 1: {count[1]}")
    for c in N["criteria"]:
        print(f"{c['criterion']:<24} {c['mean']:.2f} ± {c['sd']:.2f}   % at 1-5: " + " ".join(f"{p:.0f}" for p in c["pct"]))
    print(f"Manager-framed questions (Q1-Q6): mean {N['boxes']['Manager-framed']['mean']:.2f}")
    print(f"Researcher-framed questions (Q7-Q10): mean {N['boxes']['Researcher-framed']['mean']:.2f}")
    print("Question means (30 ratings each): " + ", ".join(f"Q{q} {m:.2f}" for q, m in N["query_means"].items()))
    save_figure(draw(*layout(N)), HERE / "figure6")
    print(f"Wrote {HERE / 'figure6.pdf'}")


if __name__ == "__main__":
    main()
