"""Read a *_test_predictions.csv and summarise where the model fails, per class."""
import re
import sys
import pandas as pd

path = sys.argv[1]
d = pd.read_csv(path)
pd.set_option("display.width", 220, "display.max_colwidth", 140)

MODAL = re.compile(r"\b(should|shall|must|expect(?:ed|s)?|supposed to|ought|needs? to|would|ideally|instead)\b", re.I)
NUMBERED = re.compile(r"^\s*(\d+[\.\)]|step\s*\d+|[-*•])\s*", re.I)

for c in ["EB", "S2R", "OB"]:
    t = d[f"is_{c}"] == 1
    p = d[f"pred_{c}"] == 1
    fn, fp, tp = d[t & ~p], d[~t & p], d[t & p]
    print(f"\n===== {c}: positives={t.sum()}  TP={len(tp)}  FN={len(fn)}  FP={len(fp)}")
    s = d["sentence_text"].astype(str)
    print("  modal/expectation word present  -> positives: %.0f%%  FN: %.0f%%  FP: %.0f%%" % (
        100 * s[t].str.contains(MODAL).mean(), 100 * s[fn.index].str.contains(MODAL).mean() if len(fn) else 0,
        100 * s[fp.index].str.contains(MODAL).mean() if len(fp) else 0))
    print("  numbered/bullet prefix          -> positives: %.0f%%  FN: %.0f%%  FP: %.0f%%" % (
        100 * s[t].str.contains(NUMBERED).mean(), 100 * s[fn.index].str.contains(NUMBERED).mean() if len(fn) else 0,
        100 * s[fp.index].str.contains(NUMBERED).mean() if len(fp) else 0))
    print("  median length (chars)           -> positives: %d  FN: %d  FP: %d" % (
        s[t].str.len().median(), s[fn.index].str.len().median() if len(fn) else 0, s[fp.index].str.len().median() if len(fp) else 0))
    print("  -- sample false negatives (missed) --")
    for x in fn.sample(min(8, len(fn)), random_state=1)["sentence_text"]:
        print("   FN:", str(x)[:150].replace("\n", " "))
    print("  -- sample false positives --")
    for x in fp.sample(min(6, len(fp)), random_state=1)["sentence_text"]:
        print("   FP:", str(x)[:150].replace("\n", " "))

# Confusions between classes
eb_fn = d[(d.is_EB == 1) & (d.pred_EB == 0)]
print("\nEB misses that were predicted as OB:", int(((eb_fn.pred_OB == 1)).sum()), "of", len(eb_fn))
s2r_fn = d[(d.is_S2R == 1) & (d.pred_S2R == 0)]
print("S2R misses that were predicted as OB:", int((s2r_fn.pred_OB == 1).sum()), "of", len(s2r_fn))
print("\nPer-project macro-ish F1 (lowest 6 by S2R F1):")
rows = []
for proj, g in d.groupby("project"):
    if g.is_S2R.sum() < 15:
        continue
    tp = ((g.is_S2R == 1) & (g.pred_S2R == 1)).sum(); fp = ((g.is_S2R == 0) & (g.pred_S2R == 1)).sum(); fn = ((g.is_S2R == 1) & (g.pred_S2R == 0)).sum()
    rows.append((proj, g.is_S2R.sum(), 2 * tp / max(1, 2 * tp + fp + fn)))
print(pd.DataFrame(rows, columns=["project", "S2R positives", "F1"]).sort_values("F1").head(6).to_string(index=False))
