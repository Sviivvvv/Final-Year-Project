"""
Component 2 - deployed scoring service.

Runtime path: one report in, one Gemini call, a parsed score and feedback
dict out. Meant to be called synchronously from a request handler (the
FastAPI endpoint in component2_api.py).

Uses the structured prompt variant (not unstructured), Gemini only, and
temperature=0.0 by default for deterministic, reproducible scoring on the
same input. Response parsing logic matches component2_pipeline.py so
scoring behaviour stays consistent between the research pipeline and this
deployed service.
"""

import json
import os
import re
import time
from typing import Optional, Union

from dotenv import load_dotenv
load_dotenv()

from component2_prompts import build_structured_prompt

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Pre-submission quality gate threshold.
PASS_THRESHOLD = 60

# Default Gemini model; overridable per-call.
DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------

def call_gemini(prompt: str, model: str = DEFAULT_GEMINI_MODEL, temperature: float = 0.0) -> str:
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
    """Extracts total_score from a parsed or raw LLM response, with regex fallbacks."""
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


def _format_component1_context(component1_context: Union[dict, str, None]) -> str:
    """
    Formats Component 1's structural context for use in the prompt.
    build_structured_prompt expects a string; Component 1's service returns
    structured data (sentence labels/flags), so this renders that into
    readable text rather than passing raw JSON to the model.
    """
    if component1_context is None:
        return ""
    if isinstance(component1_context, str):
        return component1_context
    lines = []
    for sentence in component1_context.get("sentences", []):
        text = sentence.get("text", "")
        label = sentence.get("label", "?")
        quality = sentence.get("quality", "?")
        lines.append(f'- [{label}/{quality}] "{text}"')
    return "\n".join(lines) if lines else json.dumps(component1_context)


# ---------------------------------------------------------------------------
# The core entry point
# ---------------------------------------------------------------------------

def score_report(
    report_text: str,
    component1_context: Union[dict, str, None] = None,
    model: str = DEFAULT_GEMINI_MODEL,
    temperature: float = 0.0,
) -> dict:
    """
    Scores one bug report via Gemini using the structured rubric prompt,
    and returns a parsed score and feedback dict.

    Returns on success:
        {
          "total_score": int,
          "passed": bool,               # total_score >= PASS_THRESHOLD
          "dimension_scores": {...},
          "recommendations": [...],
          "reasoning": str,
          "deductions_applied": [...],
          "parsed_ok": True,
          "error": None,
        }

    Returns on LLM/parse failure (does not raise, so the caller can decide
    how to surface this rather than getting an unhandled exception):
        {
          "total_score": None,
          "passed": False,
          "dimension_scores": {},
          "recommendations": [],
          "reasoning": None,
          "deductions_applied": [],
          "parsed_ok": False,
          "error": "<what went wrong>",
          "raw_response": "<raw text, for debugging/logs>",
        }
    """
    context_str = _format_component1_context(component1_context)
    prompt = build_structured_prompt(report_text, context_str)

    t0 = time.time()
    try:
        raw = call_gemini(prompt, model=model, temperature=temperature)
    except Exception as e:
        return {
            "total_score": None,
            "passed": False,
            "dimension_scores": {},
            "recommendations": [],
            "reasoning": None,
            "deductions_applied": [],
            "parsed_ok": False,
            "error": f"LLM call failed: {type(e).__name__}: {e}",
            "raw_response": "",
            "latency_s": round(time.time() - t0, 3),
        }
    latency_s = round(time.time() - t0, 3)

    parsed = parse_llm_json(raw)
    total_score = extract_score(parsed, raw)

    if parsed is None or total_score is None:
        return {
            "total_score": total_score,
            "passed": bool(total_score is not None and total_score >= PASS_THRESHOLD),
            "dimension_scores": {},
            "recommendations": [],
            "reasoning": None,
            "deductions_applied": [],
            "parsed_ok": False,
            "error": "Could not parse a structured JSON response from the model.",
            "raw_response": raw,
            "latency_s": latency_s,
        }

    return {
        "total_score": total_score,
        "passed": total_score >= PASS_THRESHOLD,
        "dimension_scores": parsed.get("dimension_scores", {}),
        "recommendations": parsed.get("recommendations", []),
        "reasoning": parsed.get("reasoning"),
        "deductions_applied": parsed.get("deductions_applied", []),
        "parsed_ok": True,
        "error": None,
        "raw_response": raw,
        "latency_s": latency_s,
    }


if __name__ == "__main__":
    # Manual smoke test against the real Gemini API. Requires GOOGLE_API_KEY
    # to be set in the environment.
    sample_report = (
        "OB: The app crashes when I do the thing.\n"
        "EB: It should not crash.\n"
        "S2R: Open the app sometimes."
    )
    result = score_report(sample_report)
    print(json.dumps(result, indent=2))