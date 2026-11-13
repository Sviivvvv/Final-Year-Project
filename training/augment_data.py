"""
Build the extra TRAINING sentences for Component 1's two weak spots:
Expected Behaviour (EB) phrasing sensitivity and Steps to Reproduce (S2R) recall.

    python augment_data.py --data-dir <dir with bug_reports_*.csv> [--gemini] [--max-eb 1700] [--max-s2r 2400]

Rules that keep the evaluation honest (and that the report can cite):
  * Only the TRAIN split is augmented. Validation and test are never touched, and any augmented
    sentence that already appears in validation or test is dropped (no near-duplicate leakage,
    which is the flaw the report points out in ChatBR's published augmented numbers).
  * Every augmented row keeps the structure labels of the sentence it came from, and records
    `aug_type` and `source_row` so it can be audited.
  * Augmented rows get quality_trusted = 0, so they never influence the content-quality head
    (that label comes from the rule engine, which was not run on the new text).

Rule-based rewrites (free, deterministic given --seed):
  modal    EB: "X should Y" -> "X is expected to Y" / "must Y" / "is supposed to Y"
  cue      EB/OB/S2R: add a natural cue prefix ("Expected result:", "Actual result:", "Steps:"),
           at the same rate for all three classes so no class is uniquely cue-marked
  format   S2R: add, change or strip list markers ("1.", "Step 2:", "-")
Gemini paraphrases (--gemini): new wording for EB and S2R sentences. Identifiers, numbers, versions,
paths, URLs and quoted/code strings must survive unchanged or the paraphrase is rejected.
"""

import argparse
import concurrent.futures as cf
import json
import os
import random
import re
import sys
import time

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, "artifacts")

# ----------------------------------------------------------------------------- rule-based rewrites

PLURAL_SUBJECTS = {"they", "we", "you", "i", "these", "those", "both"}


def _is_plural(word: str) -> bool:
    # Only pronouns are treated as plural; guessing from a trailing "s" gets "Reconcile with errors" wrong.
    return word.lower().strip(".,;:()'\"`") in PLURAL_SUBJECTS


def rewrite_modal(text: str, rng: random.Random):
    """Swap the first 'should' for another expectation phrasing. Returns None if not applicable."""
    m = re.search(r"\b(\w+)\s+(should(?:n't| not)?)\b(?!\s+have\b)", text, re.I)
    if not m:
        return None
    subj, modal = m.group(1), m.group(2).lower()
    negative = modal != "should"
    plural = _is_plural(subj)
    if negative:
        options = ["must not", "is not supposed to" if not plural else "are not supposed to", "is not expected to" if not plural else "are not expected to"]
    else:
        options = ["must", "is expected to" if not plural else "are expected to", "is supposed to" if not plural else "are supposed to"]
    choice = rng.choice(options)
    start, end = m.start(2), m.end(2)
    out = text[:start] + choice + text[end:]
    return out if out != text else None


EB_CUES = ["Expected behavior: ", "Expected result: ", "Expected: ", "Expected outcome: "]
OB_CUES = ["Actual behavior: ", "Actual result: ", "Actual: ", "Observed behavior: "]
S2R_CUES = ["Steps to reproduce: ", "Steps: ", "To reproduce: "]
CUE_ANY = re.compile(r"^\s*(expected|actual|observed|steps?|to reproduce)\b[^:]{0,25}:", re.I)


def add_cue(text: str, cues, rng: random.Random):
    if CUE_ANY.match(text):
        return None
    return rng.choice(cues) + text


LIST_MARK = re.compile(r"^\s*(?:\(?\d{1,2}[\.\)]|step\s*\d{1,2}\s*[:\.\)-]|[-*•])\s+", re.I)


def rewrite_list_marker(text: str, rng: random.Random):
    """S2R: strip an existing list marker, or add a different one."""
    if LIST_MARK.match(text):
        out = LIST_MARK.sub("", text, count=1)
        return out if len(out.split()) >= 2 else None
    n = rng.randint(1, 7)
    return rng.choice([f"{n}. ", f"{n}) ", f"Step {n}: ", "- ", "* "]) + text


# ----------------------------------------------------------------------------- Gemini paraphrases

KEEP_TOKEN = re.compile(r"`[^`]+`|\"[^\"]{1,60}\"|https?://\S+|[\w.\-/\\]*[\w]\.[A-Za-z]{1,5}\b|\b[A-Za-z_]+[A-Z_][\w]*\b|\S*\d\S*")
ROLE_TEXT = {
    "EB": "EXPECTED BEHAVIOUR: what the software should do / what the reporter expected to happen",
    "S2R": "STEP TO REPRODUCE: an action, setup detail or condition the reporter performed to trigger the bug",
}


def keep_tokens(text: str):
    toks = {t.strip(".,;:()[]{}") for t in KEEP_TOKEN.findall(text)}
    return {t for t in toks if len(t) > 1}


def paraphrase_ok(orig: str, new: str) -> bool:
    new = (new or "").strip()
    if not new or new.lower() == orig.lower():
        return False
    ratio = len(new) / max(1, len(orig))
    if not 0.5 <= ratio <= 1.8:
        return False
    if not all(t in new for t in keep_tokens(orig)):
        return False
    a, b = set(re.findall(r"\w+", orig.lower())), set(re.findall(r"\w+", new.lower()))
    return len(a & b) / max(1, len(a | b)) < 0.85  # must actually differ in wording


def make_prompt(role: str, items, k: int) -> str:
    listing = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(items))
    return (
        "You are helping build a training set for a classifier that labels sentences taken from software bug reports.\n"
        f"Every sentence below is a {ROLE_TEXT[role]}.\n"
        f"For each numbered sentence write {k} paraphrase(s) that:\n"
        "- keep the same meaning and the SAME ROLE, so the classifier label stays correct\n"
        "- change the wording and sentence structure noticeably (do not just swap one word)\n"
        "- keep every identifier, number, version, file name, URL, code snippet and quoted string EXACTLY as written\n"
        "- add no new facts, and stay between 0.6x and 1.6x of the original length\n"
        "- are plain text, one sentence each, no numbering or bullets\n\n"
        f"Sentences:\n{listing}\n\n"
        'Return ONLY JSON: {"items":[{"id":1,"paraphrases":["..."]}, ...]} with one entry per sentence.'
    )


def call_gemini(prompt: str, model: str, temperature: float = 0.8) -> str:
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
    resp = client.models.generate_content(
        model=model, contents=prompt,
        config=types.GenerateContentConfig(temperature=temperature, response_mime_type="application/json"),
    )
    return resp.text


def _loads_lenient(raw: str):
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
    try:
        return json.loads(raw, strict=False)
    except json.JSONDecodeError:
        # Sentences with Windows paths make the model emit single backslashes: double those that are not valid escapes.
        return json.loads(re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", raw, flags=re.S), strict=False)


def gemini_batch(role, rows, k, model, retries=6):
    """rows: list of (source_row, text). Returns [(source_row, paraphrase)], or None if every attempt failed."""
    prompt = make_prompt(role, [t for _, t in rows], k)
    last = None
    for attempt in range(retries):
        try:
            items = _loads_lenient(call_gemini(prompt, model))["items"]
            out = []
            for it in items:
                idx = int(it["id"]) - 1
                if not 0 <= idx < len(rows):
                    continue
                src, orig = rows[idx]
                for p in it.get("paraphrases", [])[:k]:
                    if paraphrase_ok(orig, p):
                        out.append((src, p.strip()))
            return out
        except Exception as e:
            last = e
            rate_limited = "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e)
            time.sleep(min(90, (15 if rate_limited else 2) * (attempt + 1)))
    print("  batch failed after retries:", re.sub(r"AIza[\w-]+", "<key>", repr(last))[:160], file=sys.stderr)
    return None


def run_gemini(role, df, idxs, k, model, batch_size, workers, cache_path):
    cache = {}
    if os.path.exists(cache_path):
        for line in open(cache_path, encoding="utf8"):
            r = json.loads(line)
            if r.get("ok") or r["paras"]:  # older cache lines without "ok" and without paraphrases were failures
                cache[(r["role"], r["src"])] = r["paras"]
    todo = [i for i in idxs if (role, i) not in cache]
    batches = [todo[i:i + batch_size] for i in range(0, len(todo), batch_size)]
    print(f"[gemini] {role}: {len(idxs)} sentences, {len(todo)} not cached, {len(batches)} requests")
    with open(cache_path, "a", encoding="utf8") as cf_out, cf.ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(gemini_batch, role, [(i, str(df.at[i, "sentence_text"])) for i in b], k, model): b for b in batches}
        for n, fut in enumerate(cf.as_completed(futs), 1):
            got = {}
            for src, p in fut.result():
                got.setdefault(src, []).append(p)
            for src in futs[fut]:
                cache[(role, src)] = got.get(src, [])
                cf_out.write(json.dumps({"role": role, "src": int(src), "paras": got.get(src, [])}) + "\n")
            cf_out.flush()
            if n % 20 == 0:
                print(f"  {n}/{len(batches)} requests done")
    return {src: paras for (r, src), paras in cache.items() if r == role}


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--out", default=None, help="output CSV (default: artifacts/bug_reports_train_aug.csv)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--cue-rate", type=float, default=0.12)
    ap.add_argument("--s2r-format-rate", type=float, default=0.25)
    ap.add_argument("--gemini", action="store_true")
    ap.add_argument("--model", default="gemini-3.1-flash-lite")
    ap.add_argument("--max-eb", type=int, default=1700)
    ap.add_argument("--max-s2r", type=int, default=2400)
    ap.add_argument("--eb-paraphrases", type=int, default=2)
    ap.add_argument("--batch-size", type=int, default=12)
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()

    os.makedirs(ART, exist_ok=True)
    rng = random.Random(args.seed)
    train = pd.read_csv(f"{args.data_dir}/bug_reports_train.csv")
    heldout = set()
    for name in ("val", "test"):
        heldout |= set(pd.read_csv(f"{args.data_dir}/bug_reports_{name}.csv")["sentence_text"].astype(str).str.strip().str.lower())
    seen = set(train["sentence_text"].astype(str).str.strip().str.lower())

    new_rows = []

    def emit(src, text, kind):
        key = text.strip().lower()
        if not key or key in seen or key in heldout:
            return False
        seen.add(key)
        r = train.loc[src].to_dict()
        r.update(sentence_text=text, aug_type=kind, source_row=int(src), quality_trusted=0)
        new_rows.append(r)
        return True

    eb = train.index[train.is_EB == 1].tolist()
    s2r = train.index[train.is_S2R == 1].tolist()
    ob = train.index[(train.is_OB == 1) & (train.is_EB == 0) & (train.is_S2R == 0)].tolist()

    for i in eb:  # modal rewrites: every EB sentence that uses "should"
        out = rewrite_modal(str(train.at[i, "sentence_text"]), rng)
        if out:
            emit(i, out, "rule_modal")
    for pool, cues in ((eb, EB_CUES), (ob, OB_CUES), (s2r, S2R_CUES)):  # same cue rate for each class
        for i in rng.sample(pool, int(len(pool) * args.cue_rate)):
            out = add_cue(str(train.at[i, "sentence_text"]), cues, rng)
            if out:
                emit(i, out, "rule_cue")
    for i in rng.sample(s2r, int(len(s2r) * args.s2r_format_rate)):
        out = rewrite_list_marker(str(train.at[i, "sentence_text"]), rng)
        if out:
            emit(i, out, "rule_format")
    n_rule = len(new_rows)
    print(f"rule-based rows added: {n_rule}")

    if args.gemini:
        if "GOOGLE_API_KEY" not in os.environ:
            from dotenv import load_dotenv
            load_dotenv(os.path.join(HERE, "..", "component2_service", ".env"))
        cache = os.path.join(ART, "gemini_cache.jsonl")
        eb_pick = eb if len(eb) <= args.max_eb else rng.sample(eb, args.max_eb)
        s2r_pick = rng.sample(s2r, min(args.max_s2r, len(s2r)))
        for role, idxs, k in (("EB", eb_pick, args.eb_paraphrases), ("S2R", s2r_pick, 1)):
            got = run_gemini(role, train, idxs, k, args.model, args.batch_size, args.workers, cache)
            for src, paras in got.items():
                for p in paras:
                    emit(src, p, "gemini")
        print(f"gemini rows added: {len(new_rows) - n_rule}")

    aug = pd.DataFrame(new_rows)
    base = train.copy()
    base["aug_type"] = "original"
    base["source_row"] = base.index
    base["quality_trusted"] = 1
    combined = pd.concat([base, aug], ignore_index=True)
    out_path = args.out or os.path.join(ART, "bug_reports_train_aug.csv")
    combined.to_csv(out_path, index=False)

    # Audit report
    lines = ["# Augmentation report", "", f"Original train rows: {len(train)}  |  augmented rows: {len(aug)}  |  total: {len(combined)}", "",
             "| aug_type | EB | S2R | OB-only | rows |", "|---|---|---|---|---|"]
    for kind, g in aug.groupby("aug_type"):
        lines.append(f"| {kind} | {int(g.is_EB.sum())} | {int(g.is_S2R.sum())} | {int(((g.is_OB == 1) & (g.is_EB == 0) & (g.is_S2R == 0)).sum())} | {len(g)} |")
    lines += ["", "Positives in train after augmentation: " +
              ", ".join(f"{c}={int(combined['is_' + c].sum())} (was {int(train['is_' + c].sum())})" for c in ("OB", "EB", "S2R")), "", "## Examples (original -> augmented)", ""]
    for kind, g in aug.groupby("aug_type"):
        lines.append(f"**{kind}**")
        for _, r in g.sample(min(5, len(g)), random_state=1).iterrows():
            lines.append(f"- `{str(train.at[int(r.source_row), 'sentence_text'])[:110]}`  \n  -> `{str(r.sentence_text)[:110]}`")
        lines.append("")
    open(os.path.join(ART, "augmentation_report.md"), "w", encoding="utf8").write("\n".join(lines))
    print("\n".join(lines[:12]))
    print("wrote", out_path)


if __name__ == "__main__":
    main()
