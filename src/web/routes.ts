import { Hono } from 'hono';
import type { DbClient } from '../db/types';

export type { DbClient };

// CI status derivation (inlined to avoid importing from github/checks which is Node-only)
type CIStatus = 'passing' | 'failing' | 'pending' | 'unknown';

function deriveCIStatus(totalChecks: number, failedChecks: number, pendingChecks: number): CIStatus {
  if (totalChecks === 0) return 'unknown';
  if (failedChecks > 0) return 'failing';
  if (pendingChecks > 0) return 'pending';
  return 'passing';
}

function locScore(additions: number, deletions: number): number {
  const totalLoc = additions + deletions;
  if (totalLoc === 0) return 15;
  return Math.max(0, Math.round(15 - 3 * Math.log10(totalLoc)));
}

function computeCompositeScore(greptileScore: number | null, ciStatus: CIStatus, hasConflicts: boolean, humanComments: number, additions: number = 0, deletions: number = 0): number {
  let score = 0;
  if (greptileScore !== null) score += greptileScore * 8;
  switch (ciStatus) {
    case 'passing': score += 25; break;
    case 'pending': score += 12; break;
    case 'unknown': score += 8; break;
    case 'failing': score += 0; break;
  }
  score += hasConflicts ? -15 : 15;
  if (humanComments >= 2) score += 20;
  else if (humanComments === 1) score += 10;
  score += locScore(additions, deletions);
  return Math.max(0, Math.min(115, score));
}


function buildCandidate(row: any) {
  const ciStatus = deriveCIStatus(row.total_checks, row.failed_checks, row.pending_checks);
  const hasConflicts = row.mergeable === 0 || row.mergeable_state === 'dirty';
  let labels: any[] = [];
  try { labels = JSON.parse(row.labels_json || '[]'); } catch {}
  return {
    number: row.number,
    title: row.title,
    author: row.author,
    state: row.state,
    labels,
    greptileScore: row.greptile_score,
    ciStatus,
    hasConflicts,
    humanComments: row.human_comments,
    compositeScore: computeCompositeScore(row.greptile_score, ciStatus, hasConflicts, row.human_comments, row.additions ?? 0, row.deletions ?? 0),
    additions: row.additions ?? 0,
    deletions: row.deletions ?? 0,
    changedFiles: row.changed_files ?? 0,
    createdAt: row.created_at,
    lastActivity: row.last_activity,
  };
}

const PR_SELECT = `
  SELECT
    pr.number, pr.title, pr.author, pr.mergeable, pr.mergeable_state, pr.state, pr.labels_json,
    pr.additions, pr.deletions, pr.changed_files,
    pr.created_at, pr.updated_at,
    (SELECT MAX(gs.confidence_score) FROM greptile_scores gs WHERE gs.pr_number = pr.number) as greptile_score,
    (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number) as total_checks,
    (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status = 'completed' AND cr.conclusion NOT IN ('success', 'skipped', 'neutral')) as failed_checks,
    (SELECT COUNT(*) FROM check_runs cr WHERE cr.pr_number = pr.number AND cr.status != 'completed') as pending_checks,
    (SELECT COUNT(*) FROM pr_comments pc WHERE pc.pr_number = pr.number AND pc.author NOT LIKE '%[bot]') as human_comments,
    MAX(pr.updated_at, COALESCE((SELECT MAX(pc.created_at) FROM pr_comments pc WHERE pc.pr_number = pr.number), pr.updated_at)) as last_activity
  FROM pull_requests pr`;

// --- Similarity helpers ---

function tokenize(text: string): string[] {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}

function wordShingles(words: string[], n: number): Set<string> {
  const shingles = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    shingles.add(words.slice(i, i + n).join(' '));
  }
  return shingles;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function extractDirs(filename: string): string[] {
  const parts = filename.split('/');
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join('/'));
  }
  return dirs;
}

// --- Contributor scoring ---

interface AuthorStats {
  openCount: number;
  mergedCount: number;
  closedCount: number;
  totalCount: number;
  mergeRate: number;
  isFirstContribution: boolean;
}

function computeContributorScore(stats: AuthorStats): { score: number; breakdown: Record<string, { value: number; reason: string }> } {
  const breakdown: Record<string, { value: number; reason: string }> = {};

  // First-time contributor: high priority to give a good experience
  if (stats.isFirstContribution) {
    breakdown.newcomer = { value: 15, reason: 'First contribution' };
  }

  // Track record: merged PRs show a proven contributor (kept modest so it can't mask bad merge rate)
  if (stats.mergedCount >= 5) {
    breakdown.trackRecord = { value: 10, reason: `${stats.mergedCount} merged PRs — proven contributor` };
  } else if (stats.mergedCount >= 2) {
    breakdown.trackRecord = { value: 6, reason: `${stats.mergedCount} merged PRs — returning contributor` };
  } else if (stats.mergedCount === 1) {
    breakdown.trackRecord = { value: 3, reason: '1 merged PR — has landed work before' };
  } else {
    breakdown.trackRecord = { value: 0, reason: 'No merged PRs yet' };
  }

  // Merge rate: smooth gradient
  const decided = stats.mergedCount + stats.closedCount;
  if (decided >= 2) {
    const pct = Math.round(stats.mergeRate * 100);
    if (stats.mergeRate >= 0.8) {
      breakdown.mergeRate = { value: 10, reason: `${pct}% merge rate — high quality` };
    } else if (stats.mergeRate >= 0.6) {
      breakdown.mergeRate = { value: 5, reason: `${pct}% merge rate — above average` };
    } else if (stats.mergeRate >= 0.4) {
      breakdown.mergeRate = { value: 0, reason: `${pct}% merge rate` };
    } else if (stats.mergeRate >= 0.2) {
      breakdown.mergeRate = { value: -15, reason: `${pct}% merge rate — below average` };
    } else {
      breakdown.mergeRate = { value: -30, reason: `${pct}% merge rate — very few PRs merged` };
    }
  } else {
    breakdown.mergeRate = { value: 0, reason: 'Not enough history to judge' };
  }

  // Open PR load: more open PRs = active contributor needing review bandwidth
  if (stats.openCount >= 5) {
    breakdown.openLoad = { value: 10, reason: `${stats.openCount} open PRs — heavy contributor, needs review bandwidth` };
  } else if (stats.openCount >= 3) {
    breakdown.openLoad = { value: 6, reason: `${stats.openCount} open PRs — active contributor` };
  } else if (stats.openCount >= 2) {
    breakdown.openLoad = { value: 3, reason: `${stats.openCount} open PRs` };
  } else {
    breakdown.openLoad = { value: 0, reason: '1 open PR' };
  }

  const base = 50;
  const total = base + Object.values(breakdown).reduce((sum, b) => sum + b.value, 0);
  return { score: Math.max(0, Math.min(100, total)), breakdown };
}

// --- Detection patterns ---

const TEST_FILE_SQL = `lower(filename) LIKE '%.test.%' OR lower(filename) LIKE '%_test.%' OR lower(filename) LIKE '%/__tests__/%' OR lower(filename) LIKE '%.spec.%' OR lower(filename) LIKE '%_spec.%'`;

const THINKING_PATH_SQL = `lower(body) LIKE '%thinking path%'`;

const ISSUE_LINK_SQL = `lower(body) LIKE '%closes #%' OR lower(body) LIKE '%fixes #%' OR lower(body) LIKE '%resolves #%' OR body LIKE '%/issues/%'`;

function detectThinkingPath(body: string): boolean {
  return body.toLowerCase().includes('thinking path');
}

function detectIssueLink(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes('closes #') || lower.includes('fixes #') || lower.includes('resolves #') || body.includes('/issues/');
}

// --- Bonus scoring ---

const BONUS_TESTS = 10;
const BONUS_THINKING_PATH = 10;
const BONUS_ISSUE_LINK = 10;
const MAX_SCORE = 180;

const FRESHNESS_TIERS = [
  { maxDays: 1, pts: 10 },
  { maxDays: 3, pts: 8 },
  { maxDays: 7, pts: 5 },
  { maxDays: 14, pts: 2 },
];

function freshnessPts(createdAt: string, now: number = Date.now()): { pts: number; ageDays: number } {
  const createdMs = new Date(createdAt.endsWith('Z') ? createdAt : createdAt + 'Z').getTime();
  const ageDays = (now - createdMs) / (1000 * 60 * 60 * 24);
  for (const tier of FRESHNESS_TIERS) {
    if (ageDays < tier.maxDays) return { pts: tier.pts, ageDays };
  }
  return { pts: 0, ageDays };
}

function fullScoreBreakdown(
  greptileScore: number | null, ciStatus: CIStatus, hasConflicts: boolean,
  humanComments: number, additions: number, deletions: number,
  contribPts: number, contribRaw: number,
  tPts: number, tpPts: number, ilPts: number, fPts: number, ageDays: number,
) {
  const greptile = greptileScore !== null ? greptileScore * 8 : 0;
  let ci = 0;
  switch (ciStatus) {
    case 'passing': ci = 25; break;
    case 'pending': ci = 12; break;
    case 'unknown': ci = 8; break;
  }
  const conflicts = hasConflicts ? -15 : 15;
  let comments = 0;
  if (humanComments >= 2) comments = 20;
  else if (humanComments === 1) comments = 10;
  const loc = locScore(additions, deletions);
  const baseTotal = Math.max(0, Math.min(115, greptile + ci + conflicts + comments + loc));

  return {
    total: Math.max(0, Math.min(MAX_SCORE, baseTotal + contribPts + tPts + tpPts + ilPts + fPts)),
    greptile: { value: greptile, max: 40, input: greptileScore },
    ci: { value: ci, max: 25, input: ciStatus },
    conflicts: { value: conflicts, range: '-15 to +15', input: hasConflicts },
    humanComments: { value: comments, max: 20, input: humanComments },
    loc: { value: loc, max: 15, input: additions + deletions, note: 'Fewer changes = higher score' },
    contributor: { value: contribPts, range: '-25 to +25', input: contribRaw },
    tests: { value: tPts, max: 10 },
    thinkingPath: { value: tpPts, max: 10 },
    issueLink: { value: ilPts, max: 10 },
    freshness: { value: fPts, max: 10, input: Math.round(ageDays) },
  };
}

/** Create API routes with an injected DB client — no Node.js imports */
export function createRoutes(getDb: () => Promise<DbClient>): Hono {
  const api = new Hono();

  // List PRs with filters and sorting
  api.get('/prs', async (c) => {
    const db = await getDb();

    const minScore = c.req.query('minScore');
    const ci = c.req.query('ci');
    const noConflicts = c.req.query('noConflicts') === 'true';
    const limitStr = c.req.query('limit');
    const state = c.req.query('state') || 'open';
    const author = c.req.query('author');
    const label = c.req.query('label');
    const sort = c.req.query('sort') || 'score';

    const conditions: string[] = [];
    const params: any[] = [];

    if (state !== 'all') {
      conditions.push('pr.state = ?');
      params.push(state);
    }
    if (author) {
      conditions.push('pr.author = ?');
      params.push(author);
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = await db.all(`${PR_SELECT} ${whereClause} ORDER BY pr.number DESC`, params);

    let candidates = rows.map(buildCandidate);

    // Batch queries for all scoring signals
    const [authorStatRows, testFileRows, tpRows, issueRows] = await Promise.all([
      db.all<{ author: string; state: string; cnt: number }>('SELECT author, state, COUNT(*) as cnt FROM pull_requests GROUP BY author, state'),
      db.all<{ pr_number: number }>(`SELECT DISTINCT pr_number FROM pr_files WHERE ${TEST_FILE_SQL}`),
      db.all<{ number: number }>(`SELECT number FROM pull_requests WHERE ${THINKING_PATH_SQL}`),
      db.all<{ number: number }>(`SELECT number FROM pull_requests WHERE ${ISSUE_LINK_SQL}`),
    ]);

    const authorMap = new Map<string, AuthorStats>();
    for (const r of authorStatRows) {
      if (!authorMap.has(r.author)) {
        authorMap.set(r.author, { openCount: 0, mergedCount: 0, closedCount: 0, totalCount: 0, mergeRate: 0, isFirstContribution: false });
      }
      const s = authorMap.get(r.author)!;
      if (r.state === 'open') s.openCount = r.cnt;
      else if (r.state === 'merged') s.mergedCount = r.cnt;
      else if (r.state === 'closed') s.closedCount = r.cnt;
    }
    for (const [, s] of authorMap) {
      s.totalCount = s.openCount + s.mergedCount + s.closedCount;
      const decided = s.mergedCount + s.closedCount;
      s.mergeRate = decided > 0 ? s.mergedCount / decided : 0;
      s.isFirstContribution = s.totalCount === 1;
    }

    const prsWithTests = new Set(testFileRows.map(r => r.pr_number));
    const prsWithThinkingPath = new Set(tpRows.map(r => r.number));
    const prsWithIssueLink = new Set(issueRows.map(r => r.number));
    const now = Date.now();

    // Enrich candidates with all scoring signals
    for (const c of candidates as any[]) {
      const stats = authorMap.get(c.author) || { openCount: 0, mergedCount: 0, closedCount: 0, totalCount: 0, mergeRate: 0, isFirstContribution: true };
      const contrib = computeContributorScore(stats);
      const cPts = Math.round((contrib.score - 50) * 0.5); // -25 to +25
      const tPts = prsWithTests.has(c.number) ? BONUS_TESTS : 0;
      const tpPts = prsWithThinkingPath.has(c.number) ? BONUS_THINKING_PATH : 0;
      const ilPts = prsWithIssueLink.has(c.number) ? BONUS_ISSUE_LINK : 0;
      const fresh = freshnessPts(c.createdAt, now);

      c.contributorPts = cPts;
      c.contributorScore = contrib.score;
      c.hasTests = tPts > 0;
      c.hasThinkingPath = tpPts > 0;
      c.hasIssueLink = ilPts > 0;
      c.compositeScore = Math.max(0, Math.min(MAX_SCORE,
        c.compositeScore + cPts + tPts + tpPts + ilPts + fresh.pts));
      c.breakdown = fullScoreBreakdown(
        c.greptileScore, c.ciStatus, c.hasConflicts, c.humanComments,
        c.additions, c.deletions, cPts, contrib.score,
        tPts, tpPts, ilPts, fresh.pts, fresh.ageDays,
      );
    }

    if (minScore) candidates = candidates.filter(r => r.greptileScore !== null && r.greptileScore >= parseInt(minScore));
    if (ci && ['passing', 'failing', 'pending'].includes(ci)) candidates = candidates.filter(r => r.ciStatus === ci);
    if (noConflicts) candidates = candidates.filter(r => !r.hasConflicts);
    if (label) {
      const labelLower = label.toLowerCase();
      candidates = candidates.filter(r => r.labels.some((l: any) => l.name.toLowerCase() === labelLower));
    }

    // Sort
    switch (sort) {
      case 'updated':
        candidates.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
        break;
      case 'created':
        candidates.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        break;
      case 'number':
        candidates.sort((a, b) => b.number - a.number);
        break;
      case 'comments':
        candidates.sort((a, b) => b.humanComments - a.humanComments);
        break;
      case 'loc':
        candidates.sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));
        break;
      case 'score':
      default:
        candidates.sort((a, b) => b.compositeScore - a.compositeScore);
        break;
    }

    if (limitStr) candidates = candidates.slice(0, parseInt(limitStr));

    return c.json(candidates);
  });

  // PR detail with computed scores, labels, checks, reviews, and score breakdown
  api.get('/prs/:number', async (c) => {
    const prNumber = parseInt(c.req.param('number'));
    if (isNaN(prNumber)) return c.json({ error: 'Invalid PR number' }, 400);

    const db = await getDb();

    const row = await db.get(`${PR_SELECT} WHERE pr.number = ?`, [prNumber]);
    if (!row) return c.json({ error: 'PR not found' }, 404);

    const candidate = buildCandidate(row);

    const pr = await db.get('SELECT * FROM pull_requests WHERE number = ?', [prNumber]);
    const scores = await db.all('SELECT * FROM greptile_scores WHERE pr_number = ? ORDER BY created_at DESC', [prNumber]);
    const checks = await db.all('SELECT * FROM check_runs WHERE pr_number = ?', [prNumber]);
    const rawReviews = await db.all('SELECT * FROM llm_reviews WHERE pr_number = ? ORDER BY created_at DESC', [prNumber]);

    const reviews = rawReviews.map((r: any) => ({
      ...r,
      review: JSON.parse(r.review_json),
    }));

    // Contributor stats
    const authorRows = await db.all<{ state: string }>(
      'SELECT state FROM pull_requests WHERE author = ?', [candidate.author]
    );
    const openCount = authorRows.filter(r => r.state === 'open').length;
    const mergedCount = authorRows.filter(r => r.state === 'merged').length;
    const closedCount = authorRows.filter(r => r.state === 'closed').length;
    const totalCount = authorRows.length;
    const decided = mergedCount + closedCount;
    const mergeRate = decided > 0 ? mergedCount / decided : 0;
    const isFirstContribution = totalCount === 1;

    const authorStats: AuthorStats = { openCount, mergedCount, closedCount, totalCount, mergeRate, isFirstContribution };
    const contributor = computeContributorScore(authorStats);
    const cPts = Math.round((contributor.score - 50) * 0.5);

    // Bonus signals
    const testFiles = await db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM pr_files WHERE pr_number = ? AND (${TEST_FILE_SQL})`, [prNumber]
    );
    const hasTests = (testFiles?.cnt ?? 0) > 0;
    const body = (pr as any)?.body ?? '';
    const hasThinkingPath = detectThinkingPath(body);
    const hasIssueLink = detectIssueLink(body);
    const fresh = freshnessPts(candidate.createdAt);

    const tPts = hasTests ? BONUS_TESTS : 0;
    const tpPts = hasThinkingPath ? BONUS_THINKING_PATH : 0;
    const ilPts = hasIssueLink ? BONUS_ISSUE_LINK : 0;

    const finalScore = Math.max(0, Math.min(MAX_SCORE,
      candidate.compositeScore + cPts + tPts + tpPts + ilPts + fresh.pts));

    const breakdown = fullScoreBreakdown(
      candidate.greptileScore, candidate.ciStatus, candidate.hasConflicts,
      candidate.humanComments, candidate.additions, candidate.deletions,
      cPts, contributor.score, tPts, tpPts, ilPts, fresh.pts, fresh.ageDays,
    );

    return c.json({
      ...candidate,
      compositeScore: finalScore,
      hasTests,
      hasThinkingPath,
      hasIssueLink,
      body,
      headSha: (pr as any)?.head_sha ?? null,
      scoreBreakdown: breakdown,
      greptileScores: scores,
      checks,
      reviews,
      contributor: {
        score: contributor.score,
        breakdown: contributor.breakdown,
        stats: authorStats,
      },
    });
  });

  // Full-text search across PR comments (BM25)
  api.get('/search', async (c) => {
    const q = c.req.query('q');
    if (!q || q.trim().length === 0) return c.json({ error: 'Query parameter q is required' }, 400);
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr) : 20;

    const db = await getDb();

    const results = await db.all<{
      comment_id: number; pr_number: number; author: string;
      body: string; created_at: string; rank: number;
    }>(`
      SELECT c.comment_id, c.pr_number, c.author, c.body, c.created_at,
             rank
      FROM pr_comments_fts fts
      JOIN pr_comments c ON c.comment_id = fts.rowid
      WHERE pr_comments_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `, [q, limit]);

    // Group by PR with metadata
    const prNumbers = [...new Set(results.map(r => r.pr_number))];
    const byPR = new Map<number, { pr_number: number; title: string; author: string; state: string; labels: any[]; compositeScore: number; matches: any[] }>();

    for (const num of prNumbers) {
      const row = await db.get(`${PR_SELECT} WHERE pr.number = ?`, [num]);
      if (row) {
        const cand = buildCandidate(row);
        byPR.set(num, { pr_number: cand.number, title: cand.title, author: cand.author, state: cand.state, labels: cand.labels, compositeScore: cand.compositeScore, matches: [] });
      }
    }

    for (const r of results) {
      byPR.get(r.pr_number)?.matches.push(r);
    }

    return c.json({
      query: q,
      totalMatches: results.length,
      prs: [...byPR.values()],
    });
  });

  // Comments for a specific PR
  api.get('/prs/:number/comments', async (c) => {
    const prNumber = parseInt(c.req.param('number'));
    if (isNaN(prNumber)) return c.json({ error: 'Invalid PR number' }, 400);
    const db = await getDb();
    const comments = await db.all('SELECT * FROM pr_comments WHERE pr_number = ? ORDER BY created_at ASC', [prNumber]);
    return c.json(comments);
  });

  // Similar / duplicate PR detection
  api.get('/prs/:number/similar', async (c) => {
    const prNumber = parseInt(c.req.param('number'));
    if (isNaN(prNumber)) return c.json({ error: 'Invalid PR number' }, 400);

    const db = await getDb();
    const pr = await db.get<{ number: number; title: string; body: string | null; author: string; created_at: string }>(
      'SELECT number, title, body, author, created_at FROM pull_requests WHERE number = ?', [prNumber]
    );
    if (!pr) return c.json({ error: 'PR not found' }, 404);

    // Get all other PRs
    const others = await db.all<{ number: number; title: string; body: string | null; author: string; created_at: string }>(
      'SELECT number, title, body, author, created_at FROM pull_requests WHERE number != ?', [prNumber]
    );

    // Load file data for source PR
    const srcFiles = await db.all<{ filename: string }>(
      'SELECT filename FROM pr_files WHERE pr_number = ?', [prNumber]
    );
    const srcFileSet = new Set(srcFiles.map(f => f.filename));
    const srcDirSet = new Set(srcFiles.flatMap(f => extractDirs(f.filename)));

    // Load file data for all other PRs in bulk
    const allFiles = await db.all<{ pr_number: number; filename: string }>(
      'SELECT pr_number, filename FROM pr_files WHERE pr_number != ?', [prNumber]
    );
    const filesByPR = new Map<number, Set<string>>();
    const dirsByPR = new Map<number, Set<string>>();
    for (const f of allFiles) {
      if (!filesByPR.has(f.pr_number)) {
        filesByPR.set(f.pr_number, new Set());
        dirsByPR.set(f.pr_number, new Set());
      }
      filesByPR.get(f.pr_number)!.add(f.filename);
      for (const dir of extractDirs(f.filename)) {
        dirsByPR.get(f.pr_number)!.add(dir);
      }
    }

    const srcTitleWords = new Set(tokenize(pr.title));
    const srcBodyWords = tokenize(pr.body || '');
    const srcBodyShingles = wordShingles(srcBodyWords, 3);
    const srcBodyBigrams = wordShingles(srcBodyWords, 2);

    const results: Array<{
      number: number; title: string; author: string; created_at: string;
      titleSimilarity: number; bodySimilarity: number; fileSimilarity: number;
      overallScore: number; sharedFiles: number;
      potentialCopy: boolean; relationship: string;
    }> = [];

    for (const other of others) {
      const otherTitleWords = new Set(tokenize(other.title));
      const titleSim = jaccard(srcTitleWords, otherTitleWords);

      const otherBodyWords = tokenize(other.body || '');
      const otherBodyShingles = wordShingles(otherBodyWords, 3);
      const otherBodyBigrams = wordShingles(otherBodyWords, 2);

      let bodySim: number;
      if (srcBodyShingles.size >= 3 && otherBodyShingles.size >= 3) {
        bodySim = jaccard(srcBodyShingles, otherBodyShingles);
      } else {
        bodySim = jaccard(srcBodyBigrams, otherBodyBigrams);
      }

      // File overlap
      const otherFileSet = filesByPR.get(other.number) || new Set<string>();
      const otherDirSet = dirsByPR.get(other.number) || new Set<string>();
      const fileSim = jaccard(srcFileSet, otherFileSet);
      const dirSim = jaccard(srcDirSet, otherDirSet);

      // Count shared files for display
      let sharedFiles = 0;
      for (const f of srcFileSet) {
        if (otherFileSet.has(f)) sharedFiles++;
      }

      // Score by text only — file overlap is displayed but doesn't affect ranking
      const overall = titleSim * 0.4 + bodySim * 0.6;

      if (overall < 0.08) continue;

      const sameAuthor = pr.author === other.author;
      const potentialCopy = !sameAuthor && bodySim > 0.5;

      let relationship = 'related';
      if (potentialCopy) {
        relationship = 'potential copy';
      } else if (overall > 0.5) {
        relationship = 'likely duplicate';
      } else if (titleSim > 0.5 && bodySim < 0.15) {
        relationship = 'similar topic';
      }

      results.push({
        number: other.number,
        title: other.title,
        author: other.author,
        created_at: other.created_at,
        titleSimilarity: Math.round(titleSim * 100) / 100,
        bodySimilarity: Math.round(bodySim * 100) / 100,
        fileSimilarity: Math.round(fileSim * 100) / 100,
        overallScore: Math.round(overall * 100) / 100,
        sharedFiles,
        potentialCopy,
        relationship,
      });
    }

    // Sort by overall score descending
    results.sort((a, b) => b.overallScore - a.overallScore);

    return c.json({
      pr: prNumber,
      similar: results.slice(0, 8),
    });
  });

  // List unique labels across all PRs
  api.get('/labels', async (c) => {
    const db = await getDb();
    const rows = await db.all<{ labels_json: string }>('SELECT labels_json FROM pull_requests WHERE labels_json IS NOT NULL AND labels_json != \'[]\'');
    const labelMap = new Map<string, { name: string; color: string | null; count: number }>();
    for (const row of rows) {
      try {
        const labels = JSON.parse(row.labels_json);
        for (const l of labels) {
          const key = l.name.toLowerCase();
          const existing = labelMap.get(key);
          if (existing) { existing.count++; }
          else { labelMap.set(key, { name: l.name, color: l.color, count: 1 }); }
        }
      } catch {}
    }
    const sorted = [...labelMap.values()].sort((a, b) => b.count - a.count);
    return c.json(sorted);
  });

  // List unique authors
  api.get('/authors', async (c) => {
    const db = await getDb();
    const rows = await db.all<{ author: string; cnt: number }>('SELECT author, COUNT(*) as cnt FROM pull_requests GROUP BY author ORDER BY cnt DESC');
    return c.json(rows);
  });

  // Scoring formula explanation
  api.get('/scoring', (_c) => {
    return _c.json({
      description: `Composite score (0-${MAX_SCORE}) computed from ten signals`,
      formula: {
        greptile: { weight: '0-40', calculation: 'greptileScore * 8', note: 'Greptile bot confidence score (1-5) from PR comments' },
        ci: { weight: '0-25', values: { passing: 25, pending: 12, unknown: 8, failing: 0 } },
        conflicts: { weight: '-15 to +15', values: { noConflicts: 15, hasConflicts: -15 } },
        humanComments: { weight: '0-20', values: { '0': 0, '1': 10, '2+': 20 }, note: 'Excludes bot comments (authors matching *[bot])' },
        loc: { weight: '0-15', calculation: 'max(0, round(15 - 3 * log10(totalLoc)))', note: 'Fewer lines changed = higher score' },
        contributor: { weight: '-25 to +25', calculation: 'round((contributorScore - 50) * 0.5)', note: 'Contributor priority (0-100) centered at 50' },
        tests: { weight: '0-10', note: 'PRs that include test files (.test., _test., __tests__/, .spec., _spec.)' },
        thinkingPath: { weight: '0-10', note: 'PRs with "Thinking Path" in description' },
        issueLink: { weight: '0-10', note: 'PRs linking to a GitHub issue (closes/fixes/resolves # or /issues/ URL)' },
        freshness: { weight: '0-10', tiers: FRESHNESS_TIERS, note: 'Newer PRs score higher' },
      },
      maxScore: MAX_SCORE,
      minScore: 0,
    });
  });

  // Aggregate stats
  api.get('/stats', async (c) => {
    const db = await getDb();
    const total = await db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM pull_requests');
    const open = await db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM pull_requests WHERE state = 'open'");
    const withScores = await db.get<{ cnt: number }>('SELECT COUNT(DISTINCT pr_number) as cnt FROM greptile_scores');
    const reviewed = await db.get<{ cnt: number }>('SELECT COUNT(DISTINCT pr_number) as cnt FROM llm_reviews');
    const comments = await db.get<{ cnt: number }>('SELECT COUNT(*) as cnt FROM pr_comments');
    const lastSync = await db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'last_sync_at'");
    const mergedCount = await db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'merged_count'");
    const closedCount = await db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'closed_count'");

    return c.json({
      totalPRs: total?.cnt ?? 0,
      openPRs: open?.cnt ?? 0,
      mergedPRs: mergedCount ? parseInt(mergedCount.value) : 0,
      closedPRs: closedCount ? parseInt(closedCount.value) : 0,
      withGreptileScores: withScores?.cnt ?? 0,
      llmReviewed: reviewed?.cnt ?? 0,
      totalComments: comments?.cnt ?? 0,
      lastSyncAt: lastSync?.value ?? null,
    });
  });

  return api;
}
