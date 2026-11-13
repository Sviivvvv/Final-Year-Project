# Component 1 - improving the model (v12 candidates)

Deployed model: **v10**, test macro-F1 **0.747** (OB 0.810, EB 0.729, S2R 0.700). The two weak spots
(Section 5.4.1 of the report) are **S2R recall** and **Expected-Behaviour phrasing sensitivity**.

## What was found (error analysis of v10 on the test set, `error_analysis.py`)

- Only **190 EB sentences** are in the test set, so one run's EB F1 moves by about +/-0.03 from chance alone.
  That is why every comparison here uses a paired bootstrap over bug reports (`compare_runs.py`).
- 18% of true EB sentences contain no "should/expected" word, yet 57% of EB false positives do: the model leans on the word "should".
- Many S2R misses are sentences whose label depends on their neighbours ("Current code:", "Error experienced on following hardware:").
  A sentence on its own cannot tell. Hence the **context** experiment (feed the previous sentence too).
- Some dataset labels are noisy (e.g. "Other not changed." labelled EB), which caps the achievable score.

## What was built

| file | purpose |
|---|---|
| `evaluate_checkpoint.py` | Independent re-verification of any checkpoint (tunes thresholds on **val**, scores **test** once). Reproduces v10 exactly (0.747, same SHA-256). |
| `augment_data.py` | Builds extra **training-only** sentences: rule-based EB rewrites, cue prefixes, S2R list-marker variants, and Gemini paraphrases (identifiers / numbers must survive or the paraphrase is dropped). Never touches val/test; drops anything that appears in val/test. |
| `train.py` | The v10 recipe with switches `--train-file` (augmented data) and `--context 1` (previous sentence). |
| `compare_runs.py` | 95% bootstrap intervals, paired difference vs baseline, P(better), and an ensemble score. |
| `build_notebook.py` -> `component1_v12_kaggle.ipynb` | Self-contained Kaggle notebook that embeds the three scripts and runs `aug`, `ctx`, `aug_ctx`. |
| `error_analysis.py` | Where a prediction file goes wrong, per class. |

## Run it

1. (Done) `python augment_data.py --data-dir <data> --gemini` -> `artifacts/bug_reports_train_aug.csv` and `artifacts/augmentation_report.md`.
2. (Done) `python evaluate_checkpoint.py --checkpoint ../checkpoints/component1_v10.pt --data-dir <data> --tag baseline --out artifacts/runs_local`
3. Make a Kaggle dataset with: `bug_reports_train.csv`, `bug_reports_val.csv`, `bug_reports_test.csv`,
   `artifacts/bug_reports_train_aug.csv`, `artifacts/runs_local/baseline_probs.npz`, `artifacts/runs_local/baseline_results.json`.
4. New Kaggle notebook -> import `component1_v12_kaggle.ipynb`, attach the dataset, turn **GPU** and **Internet** on, Run All.
   Rough cost: about 1.5-2 h per run on a T4 (three runs by default; trim `RUNS` to save time). The cell is resumable.
5. Download `runs/`, then locally: `python evaluate_checkpoint.py --checkpoint runs/<best>.pt ... ` to re-verify (same as Listing 7).

## Why the evaluation is trustworthy

- Augmentation is applied to the **train split only**; ChatBR's published F1 > 0.98 augments before splitting (near-duplicate leakage) and is not comparable.
- Thresholds are tuned on **validation**; the test set is scored once per run.
- Augmented rows never feed the content-quality head (`quality_trusted = 0`): the rule engine that produced that label was not run on them.
- A new model is only worth deploying if its gain over v10 has a 95% interval that excludes zero.

## Deploying a winner

- Same architecture, so `checkpoints/component1_v12.pt` drops in via `COMPONENT1_CHECKPOINT_PATH` and the new thresholds go in `THRESHOLDS` in `app.py`.
- If a **context** run wins, `app.py` must also pass the previous sentence as the second segment when tokenising (`tokenizer(sentence, previous_sentence, truncation="longest_first", ...)`), exactly as `common.add_context` does in training.
