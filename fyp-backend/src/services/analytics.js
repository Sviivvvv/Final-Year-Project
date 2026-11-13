/**
 * services/analytics.js
 *
 * Pure aggregation over stored attempt documents. No database access here, so
 * it can be unit-tested on plain arrays. Used by GET /reports/analytics for
 * all three roles (QA sees only their own documents; Manager/Admin see all).
 *
 * Terminology:
 *   attempt - one stored report document
 *   thread  - all attempts sharing a thread_id (one bug, revised up to 3x)
 */

const PASS_THRESHOLD = 60;
const DIMENSION_MAX  = { clarity: 20, specificity: 25, logical_consistency: 20, actionability: 35 };

/** Same buckets the frontend used to label recommendations. */
function issueTag(issue = '') {
  const t = String(issue).toLowerCase();
  if (/step|reproduc|precondition|login|setup/.test(t)) return 'Missing steps';
  if (/vague|unclear|specific|generic|detail/.test(t))  return 'Too vague';
  if (/expect|outcome|success|should/.test(t))          return 'Unclear expected result';
  if (/error|message|symptom|screenshot/.test(t))       return 'No error detail';
  if (/contradict|inconsist|mismatch/.test(t))          return 'Inconsistent';
  return 'Needs detail';
}

const round1 = (n) => Math.round(n * 10) / 10;
const mean   = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function groupByThread(docs) {
  const map = new Map();
  for (const d of docs) {
    if (!map.has(d.thread_id)) map.set(d.thread_id, []);
    map.get(d.thread_id).push(d);
  }
  for (const list of map.values()) list.sort((a, b) => a.attempt_number - b.attempt_number);
  return map;
}

function threadOutcome(attempts) {
  if (attempts.some(a => a.passed === true)) return 'passed';
  if (attempts.some(a => a.escalated === true)) return 'escalated';
  return 'in_progress';
}

/** Thread-level summaries used by the history sidebar and the manager list. */
function summarizeThreads(docs) {
  const out = [];
  for (const [threadId, attempts] of groupByThread(docs)) {
    const first  = attempts[0];
    const last   = attempts[attempts.length - 1];
    const scored = attempts.filter(a => a.status === 'scored' && typeof a.total_score === 'number');
    const escDoc = attempts.find(a => a.escalated === true);
    const lastScored = scored[scored.length - 1];
    const tags = [...new Set((lastScored?.recommendations ?? []).map(r => issueTag(r.issue)))].slice(0, 3);
    const allTags = [...new Set(scored.flatMap(a => (a.recommendations ?? []).map(r => issueTag(r.issue))))];
    out.push({
      thread_id:    threadId,
      user_email:   first.user_email ?? null,
      title:        (first.observed_behavior ?? '').slice(0, 90),
      attempts:     attempts.length,
      outcome:      threadOutcome(attempts),
      latest_report_id: last._id.toString(),
      latest_status:    last.status,
      latest_score:     typeof last.total_score === 'number' ? last.total_score : null,
      first_score:      scored.length ? scored[0].total_score : null,
      started_at:   first.submitted_at,
      updated_at:   last.submitted_at,
      waiting_since: escDoc && !escDoc.manager_review ? escDoc.submitted_at : null,
      tags,
      all_tags:     allTags,
      review:       escDoc?.manager_review ?? null,
    });
  }
  out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return out;
}

function dayKey(iso) { return String(iso).slice(0, 10); }

function buildTrend(scored, days) {
  const byDay = new Map();
  for (const d of scored) {
    const k = dayKey(d.submitted_at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(d.total_score);
  }
  if (byDay.size === 0) return [];

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let start;
  if (days) {
    start = new Date(today);
    start.setUTCDate(start.getUTCDate() - (days - 1));
  } else {
    start = new Date([...byDay.keys()].sort()[0] + 'T00:00:00Z');
  }

  const points = [];
  for (let d = new Date(start); d <= today && points.length < 400; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    const vals = byDay.get(k) ?? [];
    points.push({ date: k, count: vals.length, avg: vals.length ? round1(mean(vals)) : null });
  }
  return points;
}

/**
 * @param {object[]} docs  attempt documents already filtered to the viewer + date range
 * @param {{days?: number|null, withReporters?: boolean}} opts
 */
function computeAnalytics(docs, { days = null, withReporters = false } = {}) {
  const scored   = docs.filter(d => d.status === 'scored' && typeof d.total_score === 'number');
  const rejected = docs.filter(d => d.status === 'rejected_incomplete');
  const threads  = groupByThread(docs);

  // Outcomes -------------------------------------------------------------
  let passedFirst = 0, passedRevised = 0, escalated = 0, inProgress = 0;
  const passAttemptNumbers = [];
  for (const attempts of threads.values()) {
    const outcome = threadOutcome(attempts);
    if (outcome === 'passed') {
      const passDoc = attempts.find(a => a.passed === true);
      passAttemptNumbers.push(passDoc.attempt_number);
      if (passDoc.attempt_number === 1) passedFirst += 1; else passedRevised += 1;
    } else if (outcome === 'escalated') escalated += 1;
    else inProgress += 1;
  }
  const threadCount = threads.size;
  const passedCount = passedFirst + passedRevised;
  let escWaiting = 0, escReviewed = 0;
  for (const attempts of threads.values()) {
    const e = attempts.find(a => a.escalated === true);
    if (e) { if (e.manager_review) escReviewed += 1; else escWaiting += 1; }
  }

  // Dimensions -----------------------------------------------------------
  const dimensions = Object.entries(DIMENSION_MAX).map(([key, max]) => {
    const vals = scored.map(d => d.dimension_scores?.[key]).filter(v => typeof v === 'number');
    return { key, max, avg: vals.length ? round1(mean(vals)) : null };
  });

  // Score histogram (10 bins of width 10; 100 lands in the last bin) --------
  const distribution = Array.from({ length: 10 }, (_, i) => ({
    from: i * 10, to: i === 9 ? 100 : i * 10 + 9, count: 0,
  }));
  for (const d of scored) {
    const idx = Math.min(9, Math.floor(d.total_score / 10));
    distribution[idx].count += 1;
  }

  // Improvement across revisions (feeds RQ2-style evidence) ----------------
  const firstScores = [], finalScores = [], deltas = [];
  for (const attempts of threads.values()) {
    const s = attempts.filter(a => a.status === 'scored' && typeof a.total_score === 'number');
    if (s.length === 0) continue;
    firstScores.push(s[0].total_score);
    finalScores.push(s[s.length - 1].total_score);
    if (s.length >= 2) deltas.push(s[s.length - 1].total_score - s[0].total_score);
  }

  // Recurring problems -----------------------------------------------------
  const issueCounts = new Map();
  for (const d of scored) {
    for (const r of d.recommendations ?? []) {
      const tag = issueTag(r.issue);
      issueCounts.set(tag, (issueCounts.get(tag) ?? 0) + 1);
    }
  }
  const topIssues = [...issueCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  const missingCounts = { OB: 0, EB: 0, S2R: 0 };
  for (const d of rejected) for (const code of d.missing_sections ?? []) {
    if (code in missingCounts) missingCounts[code] += 1;
  }

  // Learning over time (RQ2): does each reporter's FIRST-try score rise from
  // one report to the next? Revisions inside one report are excluded on
  // purpose, since those go up simply because the feedback says what to fix.
  const firstTryByUser = new Map();
  const threadList = [...threads.values()].sort((a, b) => (a[0].submitted_at < b[0].submitted_at ? -1 : 1));
  for (const attempts of threadList) {
    const email = attempts[0].user_email;
    if (!email) continue;                       // old documents without an owner
    const first = attempts[0];
    if (first.status !== 'scored' || typeof first.total_score !== 'number') continue;
    if (!firstTryByUser.has(email)) firstTryByUser.set(email, []);
    firstTryByUser.get(email).push(first.total_score);
  }
  const MAX_N = 8;
  const learning = [];
  for (let k = 0; k < MAX_N; k++) {
    const vals = [...firstTryByUser.values()].map(list => list[k]).filter(v => typeof v === 'number');
    if (vals.length === 0) break;
    learning.push({ report_no: k + 1, reporters: vals.length, avg_first_try: round1(mean(vals)) });
  }
  const learners = [...firstTryByUser.values()].filter(l => l.length >= 2);
  const learningGain = learners.length ? round1(mean(learners.map(l => l[l.length - 1] - l[0]))) : null;

  // Reporter feedback on the assistant ---------------------------------------
  const rated   = docs.filter(d => d.user_feedback && typeof d.user_feedback.helpful === 'boolean');
  const helpful = rated.filter(d => d.user_feedback.helpful).length;

  const result = {
    threshold: PASS_THRESHOLD,
    totals: {
      attempts:        docs.length,
      threads:         threadCount,
      scored_attempts: scored.length,
      structural_rejections: rejected.length,
      avg_score:       scored.length ? round1(mean(scored.map(d => d.total_score))) : null,
      pass_rate:       threadCount ? round1((passedCount / threadCount) * 100) : null,
      first_try_pass_rate: threadCount ? round1((passedFirst / threadCount) * 100) : null,
      escalation_rate: threadCount ? round1((escalated / threadCount) * 100) : null,
      avg_attempts_to_pass: passAttemptNumbers.length ? round1(mean(passAttemptNumbers)) : null,
    },
    escalations: { waiting: escWaiting, reviewed: escReviewed },
    outcomes: { passed_first_try: passedFirst, passed_after_revision: passedRevised, escalated, in_progress: inProgress },
    dimensions,
    distribution,
    trend: buildTrend(scored, days),
    improvement: {
      threads_measured: firstScores.length,
      avg_first_score:  firstScores.length ? round1(mean(firstScores)) : null,
      avg_final_score:  finalScores.length ? round1(mean(finalScores)) : null,
      revised_threads:  deltas.length,
      avg_revision_gain: deltas.length ? round1(mean(deltas)) : null,
    },
    top_issues: topIssues,
    missing_sections: missingCounts,
    structure_check: {
      blocked: rejected.length,
      checked: docs.length,
      blocked_rate: docs.length ? round1((rejected.length / docs.length) * 100) : null,
      threads_blocked_first_try: [...threads.values()].filter(a => a[0].status === 'rejected_incomplete').length,
    },
    learning: {
      by_report: learning,
      reporters_with_2plus: learners.length,
      avg_gain_first_to_latest: learningGain,
    },
    small_sample: threadCount < 10,
    assistant_feedback: {
      rated: rated.length,
      helpful_rate: rated.length ? round1((helpful / rated.length) * 100) : null,
    },
  };

  if (withReporters) {
    const byUser = new Map();
    for (const [, attempts] of threads) {
      const email = attempts[0].user_email ?? 'unknown';
      if (!byUser.has(email)) byUser.set(email, { email, threads: 0, passed: 0, scores: [] });
      const u = byUser.get(email);
      u.threads += 1;
      if (threadOutcome(attempts) === 'passed') u.passed += 1;
      for (const a of attempts) if (a.status === 'scored' && typeof a.total_score === 'number') u.scores.push(a.total_score);
    }
    result.reporters = [...byUser.values()]
      .map(u => {
        const ft = firstTryByUser.get(u.email) ?? [];
        return {
          email: u.email,
          known: u.email !== 'unknown',
          threads: u.threads,
          pass_rate: round1((u.passed / u.threads) * 100),
          avg_score: u.scores.length ? round1(mean(u.scores)) : null,
          enough_data: u.threads >= 3,
          first_try_first:  ft.length ? ft[0] : null,
          first_try_latest: ft.length >= 2 ? ft[ft.length - 1] : null,
        };
      })
      .sort((a, b) => b.threads - a.threads);
  }

  return result;
}

const HOUR = 3600000;

/**
 * Review activity per manager, from escalated attempt documents.
 * Turnaround = time from the report being escalated to a verdict being saved.
 */
function computeManagerStats(escalatedDocs, managerEmails = [], now = Date.now()) {
  const since30 = now - 30 * 24 * HOUR;
  const byReviewer = new Map();
  const ensure = (email) => {
    if (!byReviewer.has(email)) byReviewer.set(email, { email, reviews: 0, reviews_30d: 0, accepted: 0, needs_rework: 0, hours: [], last_review_at: null });
    return byReviewer.get(email);
  };
  for (const e of managerEmails) ensure(e);

  const waiting = [];
  for (const d of escalatedDocs) {
    const r = d.manager_review;
    if (!r) {
      waiting.push({
        thread_id: d.thread_id, title: (d.observed_behavior ?? '').slice(0, 90),
        user_email: d.user_email ?? null, waiting_hours: Math.max(0, (now - new Date(d.submitted_at).getTime()) / HOUR),
      });
      continue;
    }
    const m = ensure(r.reviewer);
    m.reviews += 1;
    if (new Date(r.reviewed_at).getTime() >= since30) m.reviews_30d += 1;
    if (r.decision === 'accepted') m.accepted += 1; else m.needs_rework += 1;
    const h = (new Date(r.reviewed_at).getTime() - new Date(d.submitted_at).getTime()) / HOUR;
    if (Number.isFinite(h) && h >= 0) m.hours.push(h);
    if (!m.last_review_at || r.reviewed_at > m.last_review_at) m.last_review_at = r.reviewed_at;
  }

  const managers = [...byReviewer.values()].map(({ hours, ...m }) => ({
    ...m, avg_turnaround_hours: hours.length ? round1(mean(hours)) : null,
  })).sort((a, b) => b.reviews - a.reviews);

  const allHours = [...byReviewer.values()].flatMap(m => m.hours);
  const reviewed = managers.reduce((n, m) => n + m.reviews, 0);
  const accepted = managers.reduce((n, m) => n + m.accepted, 0);
  waiting.sort((a, b) => b.waiting_hours - a.waiting_hours);

  return {
    team: {
      waiting: waiting.length,
      reviewed,
      reviewed_30d: managers.reduce((n, m) => n + m.reviews_30d, 0),
      avg_turnaround_hours: allHours.length ? round1(mean(allHours)) : null,
      oldest_waiting_hours: waiting.length ? round1(waiting[0].waiting_hours) : null,
      accepted_rate: reviewed ? round1((accepted / reviewed) * 100) : null,
    },
    managers,
    waiting: waiting.slice(0, 8).map(w => ({ ...w, waiting_hours: round1(w.waiting_hours) })),
  };
}

module.exports = { computeManagerStats, computeAnalytics, summarizeThreads, threadOutcome, groupByThread, issueTag, PASS_THRESHOLD, DIMENSION_MAX };
