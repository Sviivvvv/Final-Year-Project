"""
Component 2 - LLM content quality scoring pipeline.

Runs sample reports through both prompt variants (structured/unstructured,
RQ4) and multiple LLMs (RQ5), with repeated calls per condition to measure
scoring consistency. Results are logged to CSV and summarised into the
statistics used for the RQ4/RQ5 findings.
"""

import argparse
import csv
import json
import os
import random
import re
import statistics
import sys
import time
from dataclasses import dataclass, asdict
from itertools import product
from typing import Optional

from component2_prompts import build_structured_prompt, build_unstructured_prompt
from sample_reports import SAMPLE_REPORTS


# ---------------------------------------------------------------------------
# LLM call wrappers
# ---------------------------------------------------------------------------

def call_gemini(prompt: str, model: str, temperature: float = 0.0) -> str:
    """Calls the Gemini API and returns the raw text response."""
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
    resp = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(temperature=temperature),
    )
    return resp.text


def call_gpt(prompt: str, model: str, temperature: float = 0.0) -> str:
    """Calls the OpenAI API and returns the raw text response."""
    from openai import OpenAI
    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    resp = client.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.choices[0].message.content


def call_groq(prompt: str, model: str, temperature: float = 0.0) -> str:
    """Calls the Groq API (OpenAI-compatible) and returns the raw text response."""
    from openai import OpenAI
    client = OpenAI(
        api_key=os.environ["GROQ_API_KEY"],
        base_url="https://api.groq.com/openai/v1",
    )
    resp = client.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.choices[0].message.content


def call_cerebras(prompt: str, model: str, temperature: float = 0.0) -> str:
    """Calls the Cerebras API (OpenAI-compatible) and returns the raw text response."""
    from openai import OpenAI
    client = OpenAI(
        api_key=os.environ["CEREBRAS_API_KEY"],
        base_url="https://api.cerebras.ai/v1",
    )
    resp = client.chat.completions.create(
        model=model,
        temperature=temperature,
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.choices[0].message.content


def call_mock(prompt: str, model: str, report_id: str, prompt_type: str) -> str:
    """
    Deterministic mock scorer for testing the pipeline without API calls.
    Score is derived from report length so the pipeline has non-constant
    data to log; not a stand-in for real LLM scoring behaviour.
    """
    random.seed(hash((report_id, model, prompt_type)) % (2**31))
    base = 40 + min(len(prompt), 2000) // 40
    noise = random.randint(-4, 4)
    total = max(0, min(100, base + noise))
    quarter = total // 4
    remainder = total - quarter * 4
    dims = [quarter] * 4
    dims[0] += remainder
    payload = {
        "dimension_scores": {
            "clarity": dims[0], "specificity": dims[1],
            "logical_consistency": dims[2], "actionability": dims[3],
        },
        "total_score": total,
        "deductions_applied": [],
        "recommendations": [],
    }
    return json.dumps(payload)


# ---------------------------------------------------------------------------
# Response parsing
# ---------------------------------------------------------------------------

def parse_llm_json(raw_text: str) -> Optional[dict]:
    """Strips markdown fences if present and parses JSON; returns None on failure."""
    text = raw_text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                return None
        return None


def extract_score(parsed: Optional[dict], raw_text: str) -> Optional[int]:
    """
    Extracts a total score from a parsed or raw LLM response. Tries the
    structured 'total_score' field first, then falls back to progressively
    looser text patterns ("90/100", "90 out of 100", "score...90").
    """
    if parsed and isinstance(parsed.get("total_score"), (int, float)):
        return int(parsed["total_score"])
    m = re.search(r"(\d{1,3})\s*/\s*100", raw_text)
    if m:
        return int(m.group(1))
    m = re.search(r"(\d{1,3})\s+out of\s+100", raw_text, re.IGNORECASE)
    if m:
        return int(m.group(1))
    m = re.search(r"(?:score|rate|rating)[^\d]{0,25}(\d{1,3})", raw_text, re.IGNORECASE)
    if m:
        return int(m.group(1))
    return None


# ---------------------------------------------------------------------------
# Experiment runner
# ---------------------------------------------------------------------------

@dataclass
class RunResult:
    """One row of experiment output: a single scoring call's result."""
    report_id: str
    expected_band: str
    model: str
    prompt_type: str
    repeat_index: int
    total_score: Optional[int]
    parsed_ok: bool
    latency_s: float
    raw_response: str


MODEL_FN = {"gemini": call_gemini, "gpt": call_gpt, "groq": call_groq, "cerebras": call_cerebras}
PROMPT_FN = {"structured": build_structured_prompt, "unstructured": build_unstructured_prompt}

# Minimum seconds between consecutive calls to the same model, to stay
# within each provider's rate limit. Override with --sleep if needed.
MODEL_MIN_GAP_S = {"gemini": 4.5, "gpt": 0.5, "groq": 2.5, "cerebras": 2.5}


def load_resume_counts(resume_path):
    """
    Reads a previous results CSV and counts existing successful rows per
    (report_id, model, prompt_type), so a resumed run can skip work already
    completed instead of redoing it.
    """
    counts = {}
    with open(resume_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["total_score"] not in ("", "None", None):
                key = (row["report_id"], row["model"], row["prompt_type"])
                counts[key] = counts.get(key, 0) + 1
    return counts


def run_experiment(reports, models, prompt_types, repeats, model_names, out_path,
                    mock=False, sleep_s=None, temperature=0.0, resume_counts=None):
    """
    Runs every (report, model, prompt_type) combination `repeats` times and
    writes each result row to `out_path` as it's produced. Failed calls are
    logged with total_score=None and the error message, rather than
    discarding results already collected. If resume_counts is given, any
    combination that already has enough successful scores is skipped.
    """
    resume_counts = resume_counts or {}
    total_calls = len(reports) * len(models) * len(prompt_types) * repeats
    done = 0
    skipped = 0
    failed = 0
    last_call_time = {}
    fieldnames = list(RunResult.__dataclass_fields__.keys())

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        f.flush()

        for report, model, prompt_type in product(reports, models, prompt_types):
            already = resume_counts.get((report["id"], model, prompt_type), 0)
            needed = max(0, repeats - already)
            if needed == 0:
                skipped += repeats
                continue

            prompt = PROMPT_FN[prompt_type](report["text"], report["component1_context"])
            for rep in range(needed):
                if not mock:
                    gap = sleep_s if sleep_s is not None else MODEL_MIN_GAP_S.get(model, 1.0)
                    elapsed = time.time() - last_call_time.get(model, 0)
                    if elapsed < gap:
                        time.sleep(gap - elapsed)

                t0 = time.time()
                error_msg = None
                try:
                    if mock:
                        raw = call_mock(prompt, model, report["id"], prompt_type)
                    else:
                        raw = MODEL_FN[model](prompt, model_names[model], temperature)
                except Exception as e:
                    raw = ""
                    error_msg = f"{type(e).__name__}: {e}"
                last_call_time[model] = time.time()
                latency = time.time() - t0

                if error_msg is not None:
                    score, parsed_ok = None, False
                    raw_for_row = error_msg
                    failed += 1
                else:
                    parsed = parse_llm_json(raw)
                    score = extract_score(parsed, raw)
                    parsed_ok = parsed is not None
                    raw_for_row = raw

                row = RunResult(
                    report_id=report["id"], expected_band=report["expected_band"],
                    model=model, prompt_type=prompt_type, repeat_index=already + rep,
                    total_score=score, parsed_ok=parsed_ok,
                    latency_s=round(latency, 3), raw_response=raw_for_row,
                )
                writer.writerow(asdict(row))
                f.flush()

                done += 1
                status = f"score={score}" if error_msg is None else f"FAILED: {error_msg[:80]}"
                print(f"[{done}/{total_calls - skipped}] {report['id']} | {model} | {prompt_type} | "
                      f"rep {already + rep} -> {status}", file=sys.stderr)

    if skipped:
        print(f"\nSkipped {skipped} calls already present in the resume file.", file=sys.stderr)
    if failed:
        print(f"\n{failed} of {total_calls - skipped} calls failed and were logged with "
              f"total_score=None in {out_path}.", file=sys.stderr)
    return failed


def write_csv(results, path):
    """Writes a list of RunResult objects to a CSV file."""
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(asdict(results[0]).keys()))
        writer.writeheader()
        for r in results:
            writer.writerow(asdict(r))


def read_results_csv(path):
    """Reads a results CSV back into a list of RunResult objects."""
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            rows.append(RunResult(
                report_id=row["report_id"],
                expected_band=row["expected_band"],
                model=row["model"],
                prompt_type=row["prompt_type"],
                repeat_index=int(row["repeat_index"]),
                total_score=int(row["total_score"]) if row["total_score"] not in ("", "None") else None,
                parsed_ok=row["parsed_ok"] in ("True", "true", True),
                latency_s=float(row["latency_s"]) if row["latency_s"] not in ("", "None") else 0.0,
                raw_response=row["raw_response"],
            ))
    return rows


# ---------------------------------------------------------------------------
# RQ4: scoring consistency (structured vs unstructured)
# RQ5: cross-model agreement
# ---------------------------------------------------------------------------

def compute_rq4_consistency(results):
    """
    Computes the standard deviation of total_score across repeated calls
    for each (report, model, prompt_type) group, then averages across
    groups per prompt_type for the RQ4 comparison. Lower std-dev means
    more consistent scoring.
    """
    groups = {}
    for r in results:
        key = (r.report_id, r.model, r.prompt_type)
        groups.setdefault(key, []).append(r.total_score)

    per_group_std = []
    for (report_id, model, prompt_type), scores in groups.items():
        clean = [s for s in scores if s is not None]
        std = statistics.pstdev(clean) if len(clean) >= 2 else None
        per_group_std.append({
            "report_id": report_id, "model": model, "prompt_type": prompt_type,
            "n": len(clean), "mean_score": round(statistics.mean(clean), 1) if clean else None,
            "std_dev": round(std, 2) if std is not None else None,
        })

    by_prompt_type = {}
    for row in per_group_std:
        if row["std_dev"] is None:
            continue
        by_prompt_type.setdefault(row["prompt_type"], []).append(row["std_dev"])
    summary = {
        pt: {"mean_std_dev": round(statistics.mean(v), 2), "n_groups": len(v)}
        for pt, v in by_prompt_type.items()
    }
    return per_group_std, summary


def compute_rq5_agreement(results, model_a="gemini", model_b="groq"):
    """
    Computes mean score per model for each (report, prompt_type), the
    absolute difference between two models' mean scores, and a Pearson
    correlation across reports as an agreement measure for RQ5. The two
    models compared are configurable.
    """
    means = {}
    for r in results:
        key = (r.report_id, r.prompt_type, r.model)
        means.setdefault(key, []).append(r.total_score)
    per_report_means = {}
    for (report_id, prompt_type, model), scores in means.items():
        clean = [s for s in scores if s is not None]
        if clean:
            per_report_means[(report_id, prompt_type, model)] = statistics.mean(clean)

    rows = []
    prompt_types = sorted({k[1] for k in per_report_means})
    report_ids = sorted({k[0] for k in per_report_means})
    for prompt_type in prompt_types:
        a_scores, b_scores = [], []
        for report_id in report_ids:
            a = per_report_means.get((report_id, prompt_type, model_a))
            b = per_report_means.get((report_id, prompt_type, model_b))
            if a is not None and b is not None:
                rows.append({
                    "report_id": report_id, "prompt_type": prompt_type,
                    f"{model_a}_mean": round(a, 1), f"{model_b}_mean": round(b, 1),
                    "abs_diff": round(abs(a - b), 1),
                })
                a_scores.append(a)
                b_scores.append(b)
        pearson_r = None
        if len(a_scores) >= 2:
            try:
                pearson_r = round(statistics.correlation(a_scores, b_scores), 3)
            except Exception:
                pearson_r = None
        rows.append({"report_id": "ALL", "prompt_type": prompt_type,
                      f"{model_a}_mean": None, f"{model_b}_mean": None,
                      "abs_diff": None, "pearson_r": pearson_r})
    return rows


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    """Parses CLI arguments, runs the experiment, and prints RQ4/RQ5 summaries."""
    ap = argparse.ArgumentParser(description="Component 2 scoring pipeline")
    ap.add_argument("--models", nargs="+", default=["gemini", "groq"],
                     help="Which models to run: any of gemini, gpt, groq, cerebras.")
    ap.add_argument("--prompt-types", nargs="+", default=["structured", "unstructured"])
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--mock", action="store_true", help="Use mock scorer, no API calls")
    ap.add_argument("--sleep", type=float, default=None,
                     help="Override seconds between calls to the same model.")
    ap.add_argument("--gemini-model", default="gemini-3.1-flash-lite")
    ap.add_argument("--gpt-model", default="gpt-4o-mini")
    ap.add_argument("--groq-model", default="llama-3.1-8b-instant")
    ap.add_argument("--cerebras-model", default="llama-3.3-70b")
    ap.add_argument("--temperature", type=float, default=0.0,
                     help="Sampling temperature. 0.0 is the deployed default; "
                          "use a non-zero value for the RQ4 consistency experiment.")
    ap.add_argument("--out", default="component2_results.csv")
    ap.add_argument("--resume-from", default=None,
                     help="Path to a previous run's results CSV; combinations "
                          "already complete there are skipped.")
    ap.add_argument("--sample-size", type=int, default=None,
                     help="Only run the first N reports.")
    ap.add_argument("--bands", nargs="+", default=None, choices=["high", "medium", "low"],
                     help="Only run reports matching one of these expected bands.")
    args = ap.parse_args()

    reports = SAMPLE_REPORTS
    if args.bands:
        reports = [r for r in reports if r["expected_band"] in args.bands]
    if args.sample_size:
        reports = reports[:args.sample_size]
    if not reports:
        print("No reports left after --bands/--sample-size filtering.", file=sys.stderr)
        sys.exit(1)
    if len(reports) < len(SAMPLE_REPORTS):
        print(f"Running on a subset: {len(reports)} of {len(SAMPLE_REPORTS)} reports.\n",
              file=sys.stderr)

    if not args.mock:
        key_for = {"gemini": "GOOGLE_API_KEY", "gpt": "OPENAI_API_KEY", "groq": "GROQ_API_KEY", "cerebras": "CEREBRAS_API_KEY"}
        missing = [key_for[m] for m in args.models if key_for[m] not in os.environ]
        if missing:
            print(f"Missing env vars: {missing}. Set them or pass --mock.", file=sys.stderr)
            sys.exit(1)

    if args.temperature > 0 and args.repeats < 2:
        print("Warning: --temperature > 0 with --repeats < 2 gives no consistency signal.",
              file=sys.stderr)

    model_names = {"gemini": args.gemini_model, "gpt": args.gpt_model, "groq": args.groq_model, "cerebras": args.cerebras_model}

    resume_counts = None
    if args.resume_from:
        resume_counts = load_resume_counts(args.resume_from)
        n_groups_done = sum(1 for c in resume_counts.values() if c >= args.repeats)
        print(f"--resume-from {args.resume_from}: found {len(resume_counts)} groups with "
              f"prior data, {n_groups_done} already complete.\n", file=sys.stderr)

    print(f"Running at temperature={args.temperature}\n", file=sys.stderr)

    n_failed = run_experiment(
        reports, args.models, args.prompt_types, args.repeats,
        model_names=model_names, out_path=args.out, mock=args.mock,
        sleep_s=args.sleep, temperature=args.temperature, resume_counts=resume_counts,
    )
    print(f"\nFinished. Results saved incrementally to {args.out} "
          f"({n_failed} failed calls logged with total_score=None).\n")

    results = read_results_csv(args.out)

    per_group, rq4_summary = compute_rq4_consistency(results)
    print("=== RQ4: scoring consistency (mean std-dev of total_score across repeats) ===")
    for pt, stats_ in rq4_summary.items():
        print(f"  {pt:>12}: mean std-dev = {stats_['mean_std_dev']} (over {stats_['n_groups']} report/model groups)")
    print("  Lower std-dev = more consistent scoring across repeated calls.\n")

    rq5_models = [m for m in args.models if m in ("gemini", "gpt", "groq", "cerebras")]
    if len(rq5_models) >= 2:
        model_a, model_b = rq5_models[0], rq5_models[1]
        rq5_rows = compute_rq5_agreement(results, model_a=model_a, model_b=model_b)
        print(f"=== RQ5: {model_a} vs {model_b} agreement per report ===")
        for row in rq5_rows:
            if row["report_id"] == "ALL":
                print(f"  [{row['prompt_type']}] Pearson r across reports "
                      f"({model_a} mean vs {model_b} mean) = {row.get('pearson_r')}")
            else:
                print(f"  [{row['prompt_type']}] {row['report_id']}: "
                      f"{model_a}={row[f'{model_a}_mean']} {model_b}={row[f'{model_b}_mean']} "
                      f"|diff|={row['abs_diff']}")
    else:
        print("=== RQ5 skipped: need at least 2 models in --models to compare ===")


if __name__ == "__main__":
    main()