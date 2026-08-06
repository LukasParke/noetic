/**
 * REGRESSION SUITE — prose that the typechecker cannot see.
 *
 * Two classes of drift live in comments, docs tables, and specs, so no compiler
 * catches them. Both were found by review on the OpenRouter port branch:
 *
 *  1. FORK VOCABULARY. The OpenRouter fork spells the tool Step variant
 *     `kind: 'call-tool'`; upstream renamed it to `kind: 'tool'`. A ported
 *     comment in `adapters/openrouter.ts` kept the fork's name, so a maintainer
 *     grepping for the sibling validation path it cites finds only the comment
 *     itself and zero Step definitions — the asymmetry claim becomes
 *     unverifiable, and the comment is the only in-code record of WHY untrusted
 *     model args are validated there.
 *
 *  2. THE `ContextInput` SIGNATURE. `spawn`/`provide`'s `context` field is
 *     `ContextInput`, not `ContextConfig | ContextLayer[]`: `ContextConfig` is
 *     invariant in `TLayers`, so the union rejects the `context()` builder's own
 *     output with TS2345 (pinned at the type level in
 *     `test/context/context-input.test.ts`). Docs that publish the union steer
 *     readers into the exact error the type exists to eliminate.
 *
 * These assertions read the shipped text. They are deliberately grep-shaped
 * rather than parse-shaped: the failure mode is a stale STRING, so matching
 * strings is the check.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

//#region Repo file access

/** Repo-root-relative read, resolved from this test file's own location. */
function readRepoFile(relativeFromRepoRoot: string): string {
  return readFileSync(new URL(`../../../../${relativeFromRepoRoot}`, import.meta.url), 'utf-8');
}

/** The fork's spelling of the tool Step variant's `kind` discriminant. */
const FORK_TOOL_STEP_KIND = 'call-tool';

/** The invariant union that `ContextInput` replaced at every attach site. */
const INVARIANT_UNION = 'ContextConfig \\| ContextLayer[]';

/** Docs pages whose API tables document a `context` field. */
const CONTEXT_DOC_PAGES = [
  'packages/web/content/docs/framework/operators/spawn.mdx',
  'packages/web/content/docs/framework/operators/provide.mdx',
  'packages/web/content/docs/framework/api/step-types.mdx',
  'packages/web/content/docs/framework/patterns/react.mdx',
] as const;

//#endregion

describe('fork vocabulary does not leak into upstream prose', () => {
  it("the tool-arg validation comment cites upstream's `tool` step, not the fork's `call-tool`", () => {
    const source = readRepoFile('packages/core/src/adapters/openrouter.ts');

    // The comment must still exist — it is the only in-code rationale for
    // validating model-supplied args at this boundary.
    expect(source).toContain('executeTool');
    expect(source).toContain('`tool` step path');
    expect(source).not.toContain(FORK_TOOL_STEP_KIND);
  });

  it('the tool Step variant really is spelled `tool` upstream (the comment is checkable)', () => {
    const stepTypes = readRepoFile('packages/types/src/types/step.ts');
    const builders = readRepoFile('packages/core/src/builders/step-builders.ts');

    expect(stepTypes).toContain("kind: 'tool';");
    expect(builders).toContain("kind: 'tool',");
    expect(stepTypes).not.toContain(FORK_TOOL_STEP_KIND);
    expect(builders).not.toContain(FORK_TOOL_STEP_KIND);
  });

  it('the upstreaming notes cite the same step name the code does', () => {
    expect(readRepoFile('UPSTREAMING.md')).not.toContain(FORK_TOOL_STEP_KIND);
  });
});

describe('published docs spell the `context` field as ContextInput', () => {
  for (const page of CONTEXT_DOC_PAGES) {
    it(`${page} does not publish the invariant union`, () => {
      const content = readRepoFile(page);

      expect(content).not.toContain(INVARIANT_UNION);
      // Unescaped spelling too — MDX tables escape the pipe, prose does not.
      expect(content).not.toContain('ContextConfig | ContextLayer[]');
    });
  }

  it("both operator pages' API tables name ContextInput", () => {
    for (const page of [
      'packages/web/content/docs/framework/operators/spawn.mdx',
      'packages/web/content/docs/framework/operators/provide.mdx',
    ]) {
      expect(readRepoFile(page)).toContain('| `ContextInput` |');
    }
  });

  it('spawn.mdx prose describes ContextInput rather than a ContextConfig union', () => {
    const spawnPage = readRepoFile('packages/web/content/docs/framework/operators/spawn.mdx');

    expect(spawnPage).toContain('`ContextInput`');
    expect(spawnPage).not.toContain('a `ContextConfig` object produced by');
  });
});

describe('spec 01 agrees with the Step union it specifies', () => {
  it('the spawn and provide variants both spell context as ContextInput', () => {
    const spec = readRepoFile('specs/01-step-type.md');

    const spawnLine = spec.split('\n').find((line) => line.includes("kind: 'spawn'"));
    const provideLine = spec.split('\n').find((line) => line.includes("kind: 'provide'"));

    expect(spawnLine).toBeDefined();
    expect(provideLine).toBeDefined();
    expect(spawnLine).toContain('context?: ContextInput');
    expect(provideLine).toContain('context: ContextInput');
  });

  it('matches the runtime types the spec describes', () => {
    const stepTypes = readRepoFile('packages/types/src/types/step.ts');

    expect(stepTypes).toContain('context?: ContextInput;');
    expect(stepTypes).toContain('context: ContextInput;');
  });
});
