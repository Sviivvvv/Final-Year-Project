"""
Tests for component2_service.score_report.

All Gemini calls are mocked with realistic response shapes, so these tests
run without network access or an API key. What is tested end-to-end:
  1. The prompt is correctly built and sent.
  2. A realistic Gemini-shaped JSON response is parsed correctly.
  3. dimension_scores / recommendations / reasoning survive the round trip.
  4. The passed/PASS_THRESHOLD logic is correct at the boundary (59/60/61).
  5. Markdown-fenced ```json responses (which Gemini output sometimes
     includes) still parse correctly.
  6. LLM exceptions and unparsable responses degrade gracefully instead of
     raising.
"""

import json
from unittest.mock import patch

from component2_service import score_report, PASS_THRESHOLD

REALISTIC_GEMINI_RESPONSE = json.dumps({
    "reasoning": (
        "OB reports a crash but gives no error text or screen name. EB is "
        "a bare negation of OB rather than a specific expected state. S2R "
        "is a single vague step ('sometimes') with no precondition given. "
        "OB and EB are at least consistent with each other, but neither "
        "section gives a developer anything concrete to act on."
    ),
    "dimension_scores": {
        "clarity": 15,
        "specificity": 7,
        "logical_consistency": 20,
        "actionability": 10,
    },
    "total_score": 52,
    "deductions_applied": [
        {"marker": "vague quantifier", "section": "S2R", "dimension": "specificity",
         "points": -10, "evidence": "Open the app sometimes."},
        {"marker": "no observable symptom", "section": "OB", "dimension": "specificity",
         "points": -8, "evidence": "The app crashes when I do the thing."},
        {"marker": "single-step S2R", "section": "S2R", "dimension": "actionability",
         "points": -10, "evidence": "Open the app sometimes."},
    ],
    "recommendations": [
        {"sentence_reference": "Open the app sometimes.",
         "issue": "No concrete trigger or precondition given.",
         "suggested_fix": "State the exact action sequence and device/OS version."},
        {"sentence_reference": "The app crashes when I do the thing.",
         "issue": "\"The thing\" is not an identifiable action.",
         "suggested_fix": "Name the exact screen and button/gesture involved."},
    ],
})


def test_realistic_response_parses_end_to_end():
    with patch("component2_service.call_gemini", return_value=REALISTIC_GEMINI_RESPONSE):
        result = score_report(
            "OB: The app crashes when I do the thing.\n"
            "EB: It should not crash.\n"
            "S2R: Open the app sometimes."
        )
    assert result["total_score"] == 52
    assert result["passed"] is False  # 52 < 60
    assert result["dimension_scores"]["specificity"] == 7
    assert len(result["recommendations"]) == 2
    assert result["parsed_ok"] is True
    assert result["error"] is None
    print("test_realistic_response_parses_end_to_end: PASS")


def test_pass_threshold_boundary():
    for score, expected_pass in [(59, False), (60, True), (61, True)]:
        resp = json.dumps({
            "reasoning": "x", "total_score": score,
            "dimension_scores": {"clarity": score // 4},
            "deductions_applied": [], "recommendations": [],
        })
        with patch("component2_service.call_gemini", return_value=resp):
            result = score_report("some report text")
        assert result["passed"] is expected_pass, f"score={score}"
    assert PASS_THRESHOLD == 60
    print("test_pass_threshold_boundary: PASS")


def test_markdown_fenced_response_still_parses():
    fenced = "```json\n" + REALISTIC_GEMINI_RESPONSE + "\n```"
    with patch("component2_service.call_gemini", return_value=fenced):
        result = score_report("some report text")
    assert result["parsed_ok"] is True
    assert result["total_score"] == 52
    print("test_markdown_fenced_response_still_parses: PASS")


def test_llm_exception_degrades_gracefully():
    with patch("component2_service.call_gemini", side_effect=RuntimeError("429 rate limited")):
        result = score_report("some report text")
    assert result["total_score"] is None
    assert result["passed"] is False
    assert result["parsed_ok"] is False
    assert "429 rate limited" in result["error"]
    print("test_llm_exception_degrades_gracefully: PASS")


def test_unparsable_response_falls_back_to_regex_score():
    junk = "I'd give this report a 45 out of 100, it's missing a lot of detail."
    with patch("component2_service.call_gemini", return_value=junk):
        result = score_report("some report text")
    # parsed_ok is False (no JSON), but the regex fallback still recovers a score
    assert result["parsed_ok"] is False
    assert result["total_score"] == 45
    assert result["passed"] is False
    assert result["dimension_scores"] == {}
    print("test_unparsable_response_falls_back_to_regex_score: PASS")


def test_component1_context_dict_is_formatted_into_prompt():
    captured_prompt = {}

    def fake_call_gemini(prompt, model="x", temperature=0.0):
        captured_prompt["prompt"] = prompt
        return REALISTIC_GEMINI_RESPONSE

    context = {"sentences": [
        {"text": "The app crashes when I do the thing.", "label": "OB", "quality": "LOW"},
        {"text": "Open the app sometimes.", "label": "S2R", "quality": "LOW"},
    ]}
    with patch("component2_service.call_gemini", side_effect=fake_call_gemini):
        score_report("OB: ...\nS2R: ...", component1_context=context)

    assert "[OB/LOW]" in captured_prompt["prompt"]
    assert "[S2R/LOW]" in captured_prompt["prompt"]
    print("test_component1_context_dict_is_formatted_into_prompt: PASS")


if __name__ == "__main__":
    test_realistic_response_parses_end_to_end()
    test_pass_threshold_boundary()
    test_markdown_fenced_response_still_parses()
    test_llm_exception_degrades_gracefully()
    test_unparsable_response_falls_back_to_regex_score()
    test_component1_context_dict_is_formatted_into_prompt()
    print("\nAll tests passed.")