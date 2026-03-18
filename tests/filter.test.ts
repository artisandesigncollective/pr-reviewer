import { describe, it, expect } from 'vitest';
import { aggregateCheckStatus, CIStatus, CheckRun } from '../src/github/checks';

describe('aggregateCheckStatus', () => {
  it('returns unknown for empty checks', () => {
    expect(aggregateCheckStatus([])).toBe('unknown');
  });

  it('returns passing when all checks succeed', () => {
    const checks: CheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'success', updatedAt: '' },
      { name: 'test', status: 'completed', conclusion: 'success', updatedAt: '' },
    ];
    expect(aggregateCheckStatus(checks)).toBe('passing');
  });

  it('returns failing when any check fails', () => {
    const checks: CheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'success', updatedAt: '' },
      { name: 'test', status: 'completed', conclusion: 'failure', updatedAt: '' },
    ];
    expect(aggregateCheckStatus(checks)).toBe('failing');
  });

  it('returns pending when any check is in progress', () => {
    const checks: CheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'success', updatedAt: '' },
      { name: 'test', status: 'in_progress', conclusion: null, updatedAt: '' },
    ];
    expect(aggregateCheckStatus(checks)).toBe('pending');
  });

  it('treats skipped checks as passing', () => {
    const checks: CheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'skipped', updatedAt: '' },
      { name: 'test', status: 'completed', conclusion: 'success', updatedAt: '' },
    ];
    expect(aggregateCheckStatus(checks)).toBe('passing');
  });

  it('treats neutral checks as passing', () => {
    const checks: CheckRun[] = [
      { name: 'lint', status: 'completed', conclusion: 'neutral', updatedAt: '' },
    ];
    expect(aggregateCheckStatus(checks)).toBe('passing');
  });
});

describe('locScore', () => {
  function locScore(additions: number, deletions: number): number {
    const totalLoc = additions + deletions;
    if (totalLoc === 0) return 15;
    return Math.max(0, Math.round(15 - 3 * Math.log10(totalLoc)));
  }

  it('0 LOC gives max score of 15', () => {
    expect(locScore(0, 0)).toBe(15);
  });

  it('small PR (~10 LOC) scores high', () => {
    expect(locScore(5, 5)).toBe(12);
  });

  it('medium PR (~200 LOC) scores moderately', () => {
    expect(locScore(100, 100)).toBe(8);
  });

  it('large PR (~1000 LOC) scores low', () => {
    expect(locScore(500, 500)).toBe(6);
  });

  it('very large PR (~10000 LOC) scores 3', () => {
    expect(locScore(5000, 5000)).toBe(3);
  });

  it('never goes below 0', () => {
    expect(locScore(500000, 500000)).toBe(0);
  });
});

describe('composite score logic', () => {
  // Mirror the scoring formula from src/scoring/filter.ts and src/web/routes.ts
  function locScore(additions: number, deletions: number): number {
    const totalLoc = additions + deletions;
    if (totalLoc === 0) return 15;
    return Math.max(0, Math.round(15 - 3 * Math.log10(totalLoc)));
  }

  function computeCompositeScore(greptileScore: number | null, ciStatus: CIStatus, hasConflicts: boolean, humanComments: number, additions: number = 0, deletions: number = 0): number {
    let score = 0;
    // Greptile: 0-40
    if (greptileScore !== null) score += greptileScore * 8;
    // CI: 0-25
    switch (ciStatus) {
      case 'passing': score += 25; break;
      case 'pending': score += 12; break;
      case 'unknown': score += 8; break;
      case 'failing': score += 0; break;
    }
    // Conflicts: +/-15
    score += hasConflicts ? -15 : 15;
    // Human comments: 0-20
    if (humanComments >= 2) score += 20;
    else if (humanComments === 1) score += 10;
    // LOC: 0-15 (fewer changes = higher score)
    score += locScore(additions, deletions);
    return Math.max(0, Math.min(115, score));
  }

  it('max score: greptile 5 + passing CI + no conflicts + 2 comments + 0 LOC = 115', () => {
    expect(computeCompositeScore(5, 'passing', false, 2, 0, 0)).toBe(115);
  });

  it('min score: no greptile + failing CI + conflicts + 0 comments = 0', () => {
    expect(computeCompositeScore(null, 'failing', true, 0, 50000, 50000)).toBe(0);
  });

  it('greptile 3 + passing CI + no conflicts + 0 comments + 0 LOC = 79', () => {
    expect(computeCompositeScore(3, 'passing', false, 0, 0, 0)).toBe(79);
  });

  it('smaller PRs score higher than larger PRs', () => {
    const small = computeCompositeScore(3, 'passing', false, 0, 10, 10);
    const large = computeCompositeScore(3, 'passing', false, 0, 500, 500);
    expect(small).toBeGreaterThan(large);
  });

  it('conflicts reduce score by 30 vs no conflicts', () => {
    const withConflicts = computeCompositeScore(3, 'passing', true, 0);
    const noConflicts = computeCompositeScore(3, 'passing', false, 0);
    expect(noConflicts - withConflicts).toBe(30);
  });

  it('1 human comment adds 10 points', () => {
    const none = computeCompositeScore(3, 'passing', false, 0);
    const one = computeCompositeScore(3, 'passing', false, 1);
    expect(one - none).toBe(10);
  });

  it('2+ human comments add 20 points', () => {
    const none = computeCompositeScore(3, 'passing', false, 0);
    const two = computeCompositeScore(3, 'passing', false, 2);
    expect(two - none).toBe(20);
  });

  it('clamps to 0-115 range', () => {
    expect(computeCompositeScore(null, 'failing', true, 0, 50000, 50000)).toBe(0);
    expect(computeCompositeScore(5, 'passing', false, 5, 0, 0)).toBe(115);
  });
});
