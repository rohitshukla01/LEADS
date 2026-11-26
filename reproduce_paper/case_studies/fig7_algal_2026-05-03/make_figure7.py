"""Fig. 7: LEADS's response to the algal-bloom question of 3 May 2026 (leads_response.json), drawn by ../case_figure.py,
which first checks the response against the data in inputs/.

    python make_figure7.py      # writes figure7.{pdf,svg,png}
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from case_figure import make_figure  # noqa: E402

make_figure(HERE, "figure7")
