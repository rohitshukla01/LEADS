"""Shared definitions: data loading, evidence channels and average precision."""
import csv
import json
from pathlib import Path

HERE = Path(__file__).parent
RESULTS = HERE / "results"

METRICS = ["faithfulness", "answer_relevancy", "context_precision_no_ref", "context_recall"]
CHANNELS = ["literature", "sensor", "forecast", "tool_output"]
CATEGORIES = {"science": "Research", "data": "Observation", "hybrid": "Multi-source", "forecast": "Forecast",
              "management": "Management"}

# Tool outputs are deterministic records that LEADS computes before the answer is written.
TOOL_OUTPUT_PREFIXES = ("DATA RECENCY ANCHOR", "DEPTH AVAILABILITY", "OPERATIONAL FRAMING",
                        "FORECAST SKILL RECORD", "DECISION CONSTRAINT EVALUATION",
                        "Seasonal climatological baseline")


def channel(context: str) -> str:
    """Evidence channel of a retrieved item, from the fixed header each LEADS reader writes."""
    if context.startswith("Sensor observation at"):
        return "sensor"
    if context.startswith("FLARE"):
        return "forecast"
    if context.startswith(TOOL_OUTPUT_PREFIXES):
        return "tool_output"
    return "literature"


def average_precision(verdicts):
    """RAGAS reference-free context precision for one answer, from its item verdicts in rank order."""
    hits = sum(verdicts)
    num = sum((sum(verdicts[: k + 1]) / (k + 1)) * verdicts[k] for k in range(len(verdicts)))
    return num / (hits + 1e-10)


def load_benchmark():
    # Forecast-first ordering was used for F1–F5, HYB-1 and HYB-2.
    return json.loads((HERE / "benchmark.json").read_text())["items"]


def load_scores(path=None):
    with open(path or HERE / "ragas_scores.csv") as fh:
        return {r["id"]: {"category": r["category"], **{m: float(r[m]) for m in METRICS}} for r in csv.DictReader(fh)}


def load_item_verdicts(path=None):
    """Item verdicts grouped by question, in rank order."""
    rows = [json.loads(line) for line in Path(path or HERE / "item_verdicts.jsonl").read_text().splitlines()]
    out = {}
    for r in sorted(rows, key=lambda r: (r["id"], r["rank"])):
        out.setdefault(r["id"], []).append(r)
    return out


def prepare_ragas_import():
    """ragas 0.4.3 imports langchain_community.chat_models.vertexai, which langchain-community 0.4.2
    does not include. The judge here is ChatOpenAI, so a stub module is registered before
    ragas is imported."""
    import sys
    import types
    name = "langchain_community.chat_models.vertexai"
    try:
        __import__(name)
    except ImportError:
        module = types.ModuleType(name)

        class ChatVertexAI:
            def __init__(self, *args, **kwargs):
                raise RuntimeError("Vertex AI is not used; the judge is ChatOpenAI.")

        module.ChatVertexAI = ChatVertexAI
        sys.modules[name] = module


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
