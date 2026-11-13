// Shared constants and small pure helpers.

export const PASS_THRESHOLD = 60;
export const MAX_ATTEMPTS = 3;

/** The four things a report is scored on, in plain words. Maximums match the signed rubric. */
export const DIMENSIONS = [
  { key: 'clarity',             label: 'Clarity',             short: 'Clarity',     max: 20, hint: 'Written plainly, so a developer does not have to guess' },
  { key: 'specificity',         label: 'Specificity',         short: 'Specificity', max: 25, hint: 'Names exact pages, buttons, values and error messages' },
  { key: 'logical_consistency', label: 'Logical consistency', short: 'Consistency', max: 20, hint: 'Observed and expected behaviour fit together without contradiction' },
  { key: 'actionability',       label: 'Actionability',       short: 'Actionability', max: 35, hint: 'A developer can follow the steps and see the bug' },
];

export const SECTIONS = [
  { key: 'observed_behavior',  code: 'OB',  n: 1, label: 'Observed Behaviour',   hint: 'What actually happened',        placeholder: 'e.g. Clicking "Pay now" on the checkout page shows a blank white screen and the console logs a 500 error.', rows: 3 },
  { key: 'expected_behavior',  code: 'EB',  n: 2, label: 'Expected Behaviour',   hint: 'What should have happened instead',       placeholder: 'e.g. The order confirmation page should open and show an order number.', rows: 3 },
  { key: 'steps_to_reproduce', code: 'S2R', n: 3, label: 'Steps to Reproduce',   hint: 'One action per line, in order',       placeholder: '1. Log in as user1@example.com\n2. Add item #42 to the cart\n3. Open /checkout\n4. Click "Pay now"', rows: 4 },
];

export const SECTION_NAMES = {
  OB: 'Observed Behaviour',
  EB: 'Expected Behaviour',
  S2R: 'Steps to Reproduce',
};

export const EMPTY_FIELDS = { observed_behavior: '', expected_behavior: '', steps_to_reproduce: '' };

export const EXAMPLES = [
  {
    id: 'vague',
    label: 'Try a vague report',
    fields: {
      observed_behavior: 'The checkout thing is broken and shows something weird.',
      expected_behavior: 'It should work fine.',
      steps_to_reproduce: '1. Go to the shop\n2. Try to pay',
    },
  },
  {
    id: 'strong',
    label: 'Try a strong report',
    fields: {
      observed_behavior: 'Clicking "Pay now" on /checkout shows a blank white page after about 3 seconds. The browser console logs "POST /api/orders 500 (Internal Server Error)".',
      expected_behavior: 'The order confirmation page should open and show an order number (e.g. #10234), and the cart should be emptied.',
      steps_to_reproduce: '1. Log in as user1@example.com (the standard staging test account)\n2. Add "Blue Mug" (item #42) to the cart\n3. Open https://staging.shop.test/checkout\n4. Select "Visa ending 4242" as payment method\n5. Click "Pay now"',
    },
  },
];

/**
 * Status colour from a 0-100 percentage: red below the pass threshold,
 * amber for a pass that still has room to improve, green for strong.
 */
export function tone(pct) {
  if (pct < PASS_THRESHOLD) return 'bad';
  if (pct < 80) return 'warn';
  return 'good';
}
export const TONE_VAR = { bad: 'var(--bad)', warn: 'var(--warn)', good: 'var(--good)' };
export const TONE_LABEL = { bad: 'Needs work', warn: 'Good enough', good: 'Strong' };

/** One plain sentence for a score, used as the headline of a result. */
export function verdictFor(score, passed) {
  if (!passed) return { tone: 'bad', title: 'Not ready to send yet', sub: `It needs ${PASS_THRESHOLD} to go to developers. Fix the points below and try again.` };
  if (score >= 80) return { tone: 'good', title: 'Ready to send', sub: 'A developer can act on this report as written.' };
  return { tone: 'warn', title: 'Good enough to send', sub: 'It passes, but the points below would make it clearer.' };
}

/** Hours -> "5 h", "2 days". */
export function fmtHours(h) {
  if (h === null || h === undefined) return '-';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}
/** How worrying a wait is: green under a day, amber under three, red after. */
export function waitTone(h) {
  if (h === null || h === undefined) return 'quiet';
  if (h <= 24) return 'good';
  if (h <= 72) return 'warn';
  return 'bad';
}

export function shortIssueTag(issue = '') {
  const t = String(issue).toLowerCase();
  if (/step|reproduc|precondition|login|setup/.test(t)) return 'Missing steps';
  if (/vague|unclear|specific|generic|detail/.test(t))  return 'Too vague';
  if (/expect|outcome|success|should/.test(t))          return 'Unclear expected result';
  if (/error|message|symptom|screenshot/.test(t))       return 'No error detail';
  if (/contradict|inconsist|mismatch/.test(t))          return 'Inconsistent';
  return 'Needs detail';
}

/** Short, stable reference for a report thread, e.g. "BR-4F2A9C". */
export function refId(threadId = '') {
  const s = String(threadId).replace(/[^a-z0-9]/gi, '');
  return s ? `BR-${s.slice(-6).toUpperCase()}` : 'BR-NEW';
}

export function displayName(email = '') {
  const local = String(email).split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local ? local.replace(/\b\w/g, c => c.toUpperCase()) : 'there';
}
export function initials(email = '') {
  const parts = displayName(email).split(' ').filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function formatDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d ago` : formatDay(iso);
}

/** Bucket threads into the groups a chat sidebar uses. */
export function groupByRecency(items, getDate) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const day = 86400000;
  const groups = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Older', items: [] },
  ];
  for (const it of items) {
    const age = start.getTime() - new Date(getDate(it)).getTime();
    if (age <= 0) groups[0].items.push(it);
    else if (age <= day) groups[1].items.push(it);
    else if (age <= 7 * day) groups[2].items.push(it);
    else groups[3].items.push(it);
  }
  return groups.filter(g => g.items.length);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts / older browsers.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function reportAsText(r) {
  return [
    `Observed Behaviour:\n${(r.observed_behavior ?? '').trim()}`,
    `Expected Behaviour:\n${(r.expected_behavior ?? '').trim()}`,
    `Steps to Reproduce:\n${(r.steps_to_reproduce ?? '').trim()}`,
  ].join('\n\n');
}

export function feedbackAsText(a) {
  const lines = [`Bug report quality: ${a.total_score}/100 (${a.passed ? 'PASS' : 'FAIL'})`];
  for (const d of DIMENSIONS) {
    if (a.dimension_scores?.[d.key] !== undefined) lines.push(`- ${d.short}: ${a.dimension_scores[d.key]}/${d.max}`);
  }
  if (a.recommendations?.length) {
    lines.push('', 'Suggested improvements:');
    a.recommendations.forEach((r, i) => {
      lines.push(`${i + 1}. "${r.sentence_reference}"`, `   Issue: ${r.issue}`, `   Fix: ${r.suggested_fix}`);
    });
  }
  return lines.join('\n');
}
