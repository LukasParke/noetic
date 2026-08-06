/**
 * REGRESSION SUITE — UPSTREAMING.md's verifiable claims.
 *
 * The notes file is the upstream maintainer's entry point to a 21-commit port
 * branch, so its factual claims carry real cost when they rot. Review found
 * three that were false or unverifiable:
 *
 *  - "Every commit says which fork commit(s) it came from" — two commits have
 *    no fork origin (the notes file itself and the inspector glyph fix, which
 *    is new work for an upstream-only package), so a reviewer whose process is
 *    "diff each commit against its cited fork commit" stalls with no way to
 *    tell a forgotten citation from intentionally-new code.
 *  - "cleanly revertable" for the multi-agent proposal tranche — reverting it
 *    hits `CONFLICT (modify/delete)` on `patterns/agents.ts`, because a later
 *    Part-1 commit (`efc2b689`) edits a file the tranche created.
 *  - the fork's `call-tool` Step-kind name, which does not exist upstream.
 *
 * These assertions check the claims the notes make about THIS branch against
 * the branch itself (git history, the tree), so a reword that reintroduces an
 * unverifiable promise fails rather than shipping.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

//#region Repo access

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function readNotes(): string {
  return readFileSync(`${REPO_ROOT}UPSTREAMING.md`, 'utf-8');
}

/** Runs git in the repo root and returns trimmed stdout. */
function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  }).trim();
}

/** The commits the "Dropping the tranche" section tells a maintainer to revert. */
const TRANCHE_REVERT_COMMITS = [
  '928d63c3',
  '77cb290d',
  '4cccf95d',
] as const;

/** The file whose modify/delete conflict the notes tell the maintainer to resolve by deleting. */
const CONFLICTED_PATH = 'packages/core/src/patterns/agents.ts';

/** The Part-1 commit that reaches back into the tranche. */
const CONTEXT_INPUT_COMMIT = 'efc2b689';

//#endregion

describe('UPSTREAMING.md provenance claim is honest about un-cited commits', () => {
  it('does not claim that every commit cites a fork origin', () => {
    const notes = readNotes();

    expect(notes).not.toContain('Every commit says which fork commit(s) it came from');
    expect(notes).toContain('Every ported commit cites its fork origin');
  });

  it('names the commits that have no fork origin', () => {
    const notes = readNotes();

    // The glyph commit is the one genuine code commit with no fork origin, and
    // the reason (upstream-only package) is what makes it reviewable.
    expect(notes).toContain('928d63c3');
    expect(notes).toContain('inspector glyph');
  });

  it('the glyph commit really has no fork-origin line (the softened claim is accurate)', () => {
    const body = git([
      'log',
      '-1',
      '--format=%B',
      '928d63c3',
    ]);

    expect(body).not.toContain("Ported from OpenRouter's fork");
  });

  it('every other code commit in the range does cite a fork origin', () => {
    const range = git([
      'log',
      '--format=%H',
      'ead54108..HEAD',
    ])
      .split('\n')
      .filter((line) => line.length > 0);
    const uncited: string[] = [];

    for (const sha of range) {
      const body = git([
        'log',
        '-1',
        '--format=%B',
        sha,
      ]);
      const citesFork = /OpenRouter fork|OpenRouter's fork/.test(body);
      if (!citesFork) {
        uncited.push(
          git([
            'log',
            '-1',
            '--format=%h %s',
            sha,
          ]),
        );
      }
    }

    // Exactly the commits the notes disclose: the notes file, the glyph fix,
    // and the post-port review-round fixes. If a new un-cited commit appears,
    // this fails and the notes need a line for it.
    for (const entry of uncited) {
      const isDisclosed =
        entry.includes('upstreaming notes') ||
        entry.includes('inspector') ||
        /review round|review-round/i.test(entry);
      expect(isDisclosed).toBe(true);
    }
  });
});

describe('UPSTREAMING.md revert instructions match what git actually does', () => {
  it('does not claim the proposal tranche is cleanly revertable', () => {
    expect(readNotes()).not.toContain('cleanly revertable');
  });

  it('discloses the conflicting file and the later commit that causes it', () => {
    const notes = readNotes();

    expect(notes).toContain(CONFLICTED_PATH);
    expect(notes).toContain(CONTEXT_INPUT_COMMIT);
    expect(notes).toContain('CONFLICT (modify/delete)');
  });

  it('gives a revert command listing all three commits', () => {
    const notes = readNotes();

    for (const sha of TRANCHE_REVERT_COMMITS) {
      expect(notes).toContain(sha);
    }
    expect(notes).toContain(
      `git revert --no-commit ${TRANCHE_REVERT_COMMITS[0]} ${TRANCHE_REVERT_COMMITS[1]} ${TRANCHE_REVERT_COMMITS[2]}`,
    );
    expect(notes).toContain(`git rm --force ${CONFLICTED_PATH}`);
  });

  it('the conflict is real: efc2b689 modifies a file 4cccf95d created', () => {
    const created = git([
      'show',
      '--name-only',
      '--format=',
      '4cccf95d',
    ]).split('\n');
    const modified = git([
      'show',
      '--name-only',
      '--format=',
      CONTEXT_INPUT_COMMIT,
    ]).split('\n');

    expect(created).toContain(CONFLICTED_PATH);
    expect(modified).toContain(CONFLICTED_PATH);
    // The file is still present at HEAD — the revert really does have to
    // resolve a modify/delete rather than a plain delete.
    expect(existsSync(`${REPO_ROOT}${CONFLICTED_PATH}`)).toBe(true);
  });

  it('deleting the file is a complete resolution: nothing outside the tranche imports it', () => {
    const importers = git([
      'grep',
      '-l',
      '--',
      "from './agents'",
      'HEAD',
      '--',
      'packages/core/src',
    ])
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^HEAD:/, ''));

    // Only the tranche's own module and the core barrel (itself reverted by
    // 77cb290d/4cccf95d) may reference it.
    for (const importer of importers) {
      const isInTranche =
        importer.includes('patterns/agent-nodes.ts') ||
        importer.includes('patterns/index.ts') ||
        importer.includes('src/index.ts');
      expect(isInTranche).toBe(true);
    }
  });
});

describe('UPSTREAMING.md records the documented tradeoffs', () => {
  it('flags the frozen-but-mutably-typed loop snapshot history', () => {
    const notes = readNotes();

    expect(notes).toContain('frozen at runtime');
    expect(notes).toContain('ReadonlyArray<unknown>');
    expect(notes).toContain('semver-major');
  });

  it('the freeze it describes is really there', () => {
    const source = readFileSync(
      `${REPO_ROOT}packages/core/src/interpreter/execute-control.ts`,
      'utf-8',
    );
    const snapshotType = readFileSync(`${REPO_ROOT}packages/types/src/types/step.ts`, 'utf-8');

    expect(source).toContain('Object.freeze([');
    // Still the mutable public type — the note is describing current reality.
    expect(snapshotType).toContain('history: unknown[];');
  });

  it('flags the workflow tool-node error-kind collapse and where to gate instead', () => {
    const notes = readNotes();

    expect(notes).toContain('WORKFLOW_TOOL_CALL_FAILED');
    expect(notes).toContain('gate on the failing node');
  });

  it('the collapse it describes is really there', () => {
    const hydrator = readFileSync(
      `${REPO_ROOT}packages/core/src/builders/workflow-hydrator.ts`,
      'utf-8',
    );

    expect(hydrator).toContain('executeToolCall');
    expect(hydrator).toContain("code: 'WORKFLOW_TOOL_CALL_FAILED'");
  });

  it('lists the post-port review round so the un-cited fixes are accounted for', () => {
    const notes = readNotes();

    expect(notes).toContain('## Post-port review round');
    for (const topic of [
      'session-log item-schema registry',
      'rollback sweep',
      'warm layer hydration keys on scope',
      'compaction fold index space',
      'doom-loop guard',
      'file-storage legacy-key migration',
      'allocator minimums guarantee',
      '`context_pressure` latch',
    ]) {
      expect(notes).toContain(topic);
    }
  });
});
