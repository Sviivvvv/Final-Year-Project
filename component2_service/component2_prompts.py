"""
Component 2 - Prompt templates for LLM-based bug report content quality scoring.

Provides two prompt variants for the RQ4 experiment (structured vs.
unstructured prompting). Both encode the same rubric so that any measured
difference in scoring consistency or recommendation quality is attributable
to prompt structure, not a rubric mismatch between variants.

Both functions return a single string ready to send as the model's input.
Keep the rubric text in sync across both variants - if deduction values
change in one, they must change in the other, or the RQ4 comparison is
confounded.
"""

from textwrap import dedent


# ---------------------------------------------------------------------------
# Shared rubric text (kept in one place to avoid the two prompts drifting)
# ---------------------------------------------------------------------------

# Dimension weights (Actionability 35 / Specificity 25 / Clarity 20 /
# Logical Consistency 20) were set following expert review, replacing an
# initial equal-weighting: Actionability was raised since a report that
# cannot be reproduced is unusable regardless of write quality, and Logical
# Consistency was lowered since severe internal contradictions are rare and
# largely already caught by the dedicated deduction below.

RUBRIC_TEXT = dedent("""\
    Score the report out of 100 across four dimensions, weighted per expert
    validation (not equally weighted):
    1. Clarity (0-20 points) — unambiguous, grammatically coherent, free of
       undefined jargon or contradictory phrasing.
    2. Specificity (0-25 points) — concrete values (exact inputs, error text,
       screen names, counts) rather than vague quantifiers like "something",
       "sometimes", "a bit".
    3. Logical Consistency (0-20 points) — Observed Behaviour (OB), Expected
       Behaviour (EB), and Steps to Reproduce (S2R) agree with one another; the
       steps plausibly produce the observed behaviour; EB does not contradict OB.
    4. Actionability (0-35 points) — a developer could act on this without a
       clarification round: reproducibility, precondition completeness, an
       isolatable trigger. Weighted highest: a report a developer cannot attempt
       to reproduce is not usable regardless of how well-written it is.

    Deduction guide (apply cumulatively, dimension floor is 0, and a dimension's
    score can never exceed its point cap listed above):
    - Vague quantifier/hedge in place of a concrete detail (OB/S2R): -5 to -10 per
      instance, max -15, hits Specificity.
    - Single-step or missing S2R for a bug that plausibly needs multiple steps: -10,
      hits Actionability.
    - Missing precondition (login state, data setup, environment/device/browser)
      needed to reproduce: -8, hits Actionability.
    - EB is a wish/opinion rather than a specific expected value/state: -8, hits
      Clarity and Logical Consistency.
    - OB and EB are logically incompatible or unrelated: -15, hits Logical
      Consistency.
    - No error message/output/observable symptom where one would be expected: -8,
      hits Specificity.
    - Internal contradiction within the report: -10, hits Logical Consistency.
    - Grammar/fragments broken enough to obscure meaning: -5 per instance, max -10,
      hits Clarity.
    - Near-total reproduction failure (S2R gives no usable path to reproduce at
      all, e.g. a single vague action with no sequence): score Actionability at
      or near 0 (0-3 points) directly, overriding the itemised per-deduction
      total for this dimension — this failure mode is worse than any single
      deduction can capture individually, and the exact point value should not
      be computed by subtracting a fixed amount from the cap.
""")

FEEDBACK_TONE_TEXT = dedent("""\
    Feedback tone rules:
    - Be specific and sentence-anchored — reference the exact sentence, never a
      generic whole-report comment.
    - Suggest a concrete replacement or the category of missing information rather
      than telling the reporter to "be more specific".
    - Surface at most the top 3 highest-impact issues, prioritised by point value —
      do not list every deduction at once.
    - Frame feedback as a gap to close, not a mistake made.
    - Do not include pass/fail language in the feedback text itself.
    - If the report has no meaningful deductions (a very high or perfect score):
      do NOT invent a filler recommendation like "no changes required" or restate
      that the report is good. Either return an empty recommendations array, or —
      only if there is a genuine, non-trivial polish opportunity (e.g. an extra
      environment detail that would help future edge-case debugging even though
      it wasn't required) — return exactly one item framed as an optional
      forward-looking suggestion for next time, not as something wrong with this
      report. A recommendation should always point at a real, specific
      improvement; it should never exist just to fill the array.
""")

OUTPUT_SCHEMA_TEXT = dedent("""\
    Return ONLY a single JSON object (no markdown fences, no prose outside the
    JSON) with exactly this shape:
    {
      "reasoning": "<2-4 sentences walking through the report section by
        section — OB, then EB, then S2R, then how they relate to each other —
        BEFORE assigning any scores. Note which failure markers you found and
        where.>",
      "dimension_scores": {
        "clarity": <int 0-20>,
        "specificity": <int 0-25>,
        "logical_consistency": <int 0-20>,
        "actionability": <int 0-35>
      },
      "total_score": <int 0-100>,
      "deductions_applied": [
        {"marker": "<short label>", "section": "OB|EB|S2R|OB-EB|other",
         "dimension": "<dimension name>", "points": <negative int>,
         "evidence": "<quoted or paraphrased sentence that triggered this>"}
      ],
      "recommendations": [
        {"sentence_reference": "<quoted sentence or section name>",
         "issue": "<what is wrong, one sentence>",
         "suggested_fix": "<concrete suggested rewrite or missing info to add>"}
      ]
    }
    "recommendations" must contain at most 3 items, ordered by |points| descending,
    per the feedback tone rules below. An empty array [] is a valid and expected
    response for a report with no meaningful issues — do not pad it with filler.
    Fill "reasoning" out fully before deciding any of the numeric scores that
    follow it — do not backfill the reasoning to justify a score you already
    picked.
""")


# ---------------------------------------------------------------------------
# Structured prompt (persona + explicit rubric + explicit output format)
# ---------------------------------------------------------------------------

def build_structured_prompt(report_text: str, component1_context: str = "") -> str:
    """
    Builds the RQ4 'structured' prompt: persona assignment, explicit numeric
    rubric, and an explicit output-format constraint.

    The report is placed before the task instructions/rubric rather than
    after, following evidence that instructions placed before a long,
    variable-length input are more prone to being partially forgotten by
    the time the model reaches the end of that input.
    """
    return dedent(f"""\
        You are an expert QA lead with 10+ years of experience triaging software
        bug reports for engineering teams. Your job is to assess whether a bug
        report is clear, specific, internally consistent, and actionable enough
        for a developer to reproduce and fix the defect without needing to ask
        the reporter clarifying questions.

        Bug report to evaluate:
        ---
        {report_text}
        ---

        Component 1 structural context (OB/EB/S2R sentence labels and per-sentence
        HIGH/LOW quality flags from the fine-tuned classifier — use this as
        supporting signal, but make your own judgement from the report text):
        {component1_context or "(not provided)"}

        Now evaluate the report above strictly against this rubric. Do not invent
        criteria not listed here, and do not let overall writing quality (e.g.
        politeness, length) influence the score beyond what the rubric specifies.

        {RUBRIC_TEXT}
        {FEEDBACK_TONE_TEXT}
        {OUTPUT_SCHEMA_TEXT}
    """)


# ---------------------------------------------------------------------------
# Unstructured prompt (task description only, no format/persona constraints)
# ---------------------------------------------------------------------------

def build_unstructured_prompt(report_text: str, component1_context: str = "") -> str:
    """
    Builds the RQ4 'unstructured' prompt: a plain task description with no
    persona, no explicit rubric breakdown, and no output-format constraint.
    Deliberately minimal so the RQ4 comparison isolates the effect of
    prompt structure.
    """
    return dedent(f"""\
        Please rate the quality of this bug report out of 100, thinking about how
        clear, specific, logically consistent, and actionable it is for a
        developer to fix the issue. Give me a score and say what's good or bad
        about it, and any suggestions to improve it.

        Bug report:
        {report_text}
    """)


def build_both_prompts(report_text: str, component1_context: str = "") -> dict:
    """Builds both the structured and unstructured prompts for a given report."""
    return {
        "structured": build_structured_prompt(report_text, component1_context),
        "unstructured": build_unstructured_prompt(report_text, component1_context),
    }


if __name__ == "__main__":
    sample = (
        "OB: The app crashes.\n"
        "EB: It should not crash.\n"
        "S2R: Open the app."
    )
    prompts = build_both_prompts(sample)
    print("=== STRUCTURED ===\n", prompts["structured"][:400], "...\n")
    print("=== UNSTRUCTURED ===\n", prompts["unstructured"])