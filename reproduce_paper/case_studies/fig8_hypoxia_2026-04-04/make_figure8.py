"""Fig. 8: LEADS's response to the hypoxia question of 4 April 2026 (leads_response.json), drawn by ../case_figure.py,
which first checks the response against the data in inputs/.

    python make_figure8.py      # writes figure8.{pdf,svg,png}
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from case_figure import make_figure  # noqa: E402

make_figure(HERE, "figure8")
