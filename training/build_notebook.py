"""
Generate component1_v12_kaggle.ipynb: a self-contained Kaggle notebook that embeds common.py, train.py
and compare_runs.py (so there is one source of truth, the .py files next to this script).

    python build_notebook.py
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def read(name):
    return open(os.path.join(HERE, name), encoding="utf8").read()


def md(text):
    return {"cell_type": "markdown", "metadata": {}, "source": text.strip("\n").splitlines(True)}


def code(text):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": text.strip("\n").splitlines(True)}


def writefile(name):
    return code(f"%%writefile {name}\n" + read(name))


cells = [
    md("""
# Component 1 - improved training runs (v12 candidates)

Goal: improve the deployed v10 model (test macro-F1 0.747; weakest: **S2R** F1 0.70 and **EB** F1 0.73, with the
Expected-Behaviour phrasing sensitivity documented in Section 5.4.1).

This notebook trains three variants **with the v10 recipe unchanged** (lr 2e-5, 6 epochs, batch 16, weighted EB/S2R sampler,
macro-F1 checkpoint selection, thresholds tuned on validation, test scored once) and changes only one thing at a time:

| run | what changes vs v10 |
|---|---|
| `aug` | extra **training-only** sentences (rule-based rewrites + Gemini paraphrases of EB / S2R sentences) |
| `ctx` | the model also sees the **previous sentence** of the same bug report |
| `aug_ctx` | both |

The v10 baseline is not retrained: its predictions (`baseline_probs.npz`, `baseline_results.json`) were produced locally from the
verified v10 checkpoint (SHA-256 `171562925ab6...`) and are compared against the new runs with a **paired bootstrap over bug reports**,
because a single run's score moves by a few points from chance alone (v10 vs v11, Table 5.3).

**Before running** - create a Kaggle dataset containing: `bug_reports_train.csv`, `bug_reports_val.csv`, `bug_reports_test.csv`,
`bug_reports_train_aug.csv` (from `augment_data.py`), `baseline_probs.npz` and `baseline_results.json`.
Attach it to this notebook, turn the **GPU on** and **Internet on** (the notebook downloads `roberta-large`).
"""),
    code("""
import glob, json, os, shutil, subprocess, sys, time

# ---- edit these -------------------------------------------------------------------------
RUNS = {                       # name -> train.py switches
    "aug":     ["--train-file", "bug_reports_train_aug.csv"],
    "ctx":     ["--context", "1"],
    "aug_ctx": ["--train-file", "bug_reports_train_aug.csv", "--context", "1"],
}
SEEDS  = [42]                  # add 43, 44 for more evidence (each extra seed repeats every run)
EPOCHS = 6                     # v10 used 6 (early stopping patience 2)
# -----------------------------------------------------------------------------------------

hits = glob.glob("/kaggle/input/**/bug_reports_val.csv", recursive=True)
assert hits, "Attach the dataset with bug_reports_*.csv to this notebook"
DATA_DIR = os.path.dirname(hits[0])
print("data dir:", DATA_DIR, sorted(os.listdir(DATA_DIR)))
os.makedirs("runs", exist_ok=True)
for f in ("baseline_probs.npz", "baseline_results.json"):      # v10 baseline for the comparison
    if os.path.exists(os.path.join(DATA_DIR, f)):
        shutil.copy(os.path.join(DATA_DIR, f), "runs")
"""),
    code("!pip -q install tabulate"),
    writefile("common.py"),
    writefile("train.py"),
    writefile("compare_runs.py"),
    code("""
import torch
print("torch", torch.__version__, "| cuda:", torch.cuda.is_available(), "|", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "NO GPU")
assert torch.cuda.is_available(), "Turn the GPU on in the notebook settings"
import pandas as pd
for n in ("train", "train_aug", "val", "test"):
    p = os.path.join(DATA_DIR, f"bug_reports_{n}.csv")
    if os.path.exists(p):
        d = pd.read_csv(p); print(f"{n:<10} {len(d):>7} rows | EB {int(d.is_EB.sum()):>5} S2R {int(d.is_S2R.sum()):>5}")
"""),
    md("## Train\nEach run saves `runs/<name>.pt`, `<name>_results.json` and `<name>_probs.npz`. Finished runs are skipped, so the cell is safe to re-run after a disconnect."),
    code("""
for seed in SEEDS:
    for name, switches in RUNS.items():
        run = name if seed == SEEDS[0] and len(SEEDS) == 1 else f"{name}_s{seed}"
        if os.path.exists(f"runs/{run}_results.json"):
            print("skip (done):", run); continue
        cmd = [sys.executable, "-u", "train.py", "--data-dir", DATA_DIR, "--run-name", run, "--seed", str(seed), "--epochs", str(EPOCHS), *switches]
        print("\\n" + "=" * 100 + "\\n" + " ".join(cmd) + "\\n" + "=" * 100, flush=True)
        t0 = time.time()
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in p.stdout:
            if "Warning" not in line:
                print(line, end="", flush=True)
        p.wait()
        print(f"[{run}] finished with code {p.returncode} in {(time.time() - t0) / 60:.1f} min")
"""),
    md("## Compare with v10\nRead the *P(better)* column: only treat a run as an improvement when its interval excludes zero."),
    code("""
out = subprocess.run([sys.executable, "compare_runs.py", "--runs-dir", "runs", "--test-csv", os.path.join(DATA_DIR, "bug_reports_test.csv"), "--baseline", "baseline"],
                     capture_output=True, text=True)
print(out.stdout or out.stderr)
"""),
    md("""
## What to do with the result

1. Download `runs/` (at least `*_results.json`, `*_probs.npz`, `comparison.md` and the `.pt` of the best run) from the notebook output.
2. Re-verify the best checkpoint locally with `evaluate_checkpoint.py` (same step as Code Listing 7) and check its SHA-256 matches `*_results.json`.
3. Deploy only if it beats v10 with a clear margin (interval excludes zero) **and** does not lose on the class it was not meant to help.
   If `ctx` or `aug_ctx` wins, the service also has to feed the previous sentence at inference time (a small change in `app.py`).
4. Report negative results as honestly as v11 was reported: an idea that does not clear the noise is still a finding.
"""),
]

nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}},
      "nbformat": 4, "nbformat_minor": 5}
out = os.path.join(HERE, "component1_v12_kaggle.ipynb")
json.dump(nb, open(out, "w", encoding="utf8"), indent=1)
print("wrote", out, f"({len(cells)} cells)")
