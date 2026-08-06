import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertWritableUnderVersionControl,
  WriteGuardError,
} from '../../src/optimization/write-guard';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'write-guard-'));
  spawnSync(
    'git',
    [
      'init',
      '-q',
    ],
    {
      cwd: dir,
    },
  );
  spawnSync(
    'git',
    [
      'config',
      'user.email',
      't@t',
    ],
    {
      cwd: dir,
    },
  );
  spawnSync(
    'git',
    [
      'config',
      'user.name',
      't',
    ],
    {
      cwd: dir,
    },
  );
  return dir;
}

describe('assertWritableUnderVersionControl (E1)', () => {
  it('passes for a committed, unmodified file', () => {
    const repo = makeRepo();
    const file = join(repo, 'prompt.ts');
    writeFileSync(file, 'export const p = "hello";\n');
    spawnSync(
      'git',
      [
        'add',
        '.',
      ],
      {
        cwd: repo,
      },
    );
    spawnSync(
      'git',
      [
        'commit',
        '-qm',
        'x',
      ],
      {
        cwd: repo,
      },
    );
    const verdicts = assertWritableUnderVersionControl([
      file,
    ]);
    expect(verdicts[0].status).toBe('clean');
  });

  it('refuses an untracked file', () => {
    const repo = makeRepo();
    const file = join(repo, 'loose.ts');
    writeFileSync(file, 'export const p = "hi";\n');
    expect(() =>
      assertWritableUnderVersionControl([
        file,
      ]),
    ).toThrow(WriteGuardError);
  });

  it('refuses a tracked file with uncommitted modifications', () => {
    const repo = makeRepo();
    const file = join(repo, 'prompt.ts');
    writeFileSync(file, 'v1');
    spawnSync(
      'git',
      [
        'add',
        '.',
      ],
      {
        cwd: repo,
      },
    );
    spawnSync(
      'git',
      [
        'commit',
        '-qm',
        'x',
      ],
      {
        cwd: repo,
      },
    );
    writeFileSync(file, 'v2-uncommitted');
    expect(() =>
      assertWritableUnderVersionControl([
        file,
      ]),
    ).toThrow('dirty');
  });

  it('forceDirty overrides but still reports verdicts', () => {
    const repo = makeRepo();
    const file = join(repo, 'loose.ts');
    writeFileSync(file, 'x');
    const verdicts = assertWritableUnderVersionControl(
      [
        file,
      ],
      true,
    );
    expect(verdicts[0].status).toBe('untracked');
  });
});
