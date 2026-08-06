/**
 * Regression pin for `ContextInput`.
 *
 * `ContextConfig<TLayers>` is invariant in `TLayers` — its phantom `_shape`
 * field carries the type parameter in an invariant position — so the concrete
 * `ContextConfig<readonly [WorkingMemoryContextLayer]>` that `context()` infers
 * is NOT assignable to the defaulted `ContextConfig<readonly ContextLayer[]>`.
 * Any entry point that spells its parameter `ContextConfig | ContextLayer[]`
 * therefore rejects the `context()` builder's own output.
 *
 * Every case below passes a `context([...])` result — with a real layer, so the
 * inferred tuple is non-trivial and `_shape` is not `Record<string, never>` —
 * straight into `spawn`, `provide`, `react`, and the `StepSpawn`/`StepProvide`
 * literals. If any of those sites reverts to the `ContextConfig`-based union
 * these calls stop compiling with TS2322, failing `bun run typecheck` (this
 * directory is inside the package tsconfig's `test/**\/*.ts` include).
 *
 * The bodies also assert at runtime that the config's layers reach the built
 * step, so the pin fails loudly if the interpreter's `hasLayersField`
 * discrimination stops unwrapping `{ layers }`.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextInput, ContextLayer } from '@noetic-tools/context';
import { workingMemoryContext } from '@noetic-tools/context';
import type { Step, StepProvide, StepSpawn } from '@noetic-tools/types';
import { context } from '../../src/builders/context-builder';
import { provide } from '../../src/builders/provide-builder';
import { spawn } from '../../src/builders/spawn-builder';
import { step } from '../../src/builders/step-builders';
import { react } from '../../src/patterns/react';

function makeChild(): Step<unknown, string, string> {
  return step.run<unknown, string, string>({
    id: 'child',
    execute: async (input: string) => input,
  });
}

/**
 * Reads whichever `ContextInput` member was supplied back into a flat list.
 * Discriminates with the same `!Array.isArray` shape the interpreter uses:
 * `'layers' in value` alone does not narrow away the `ReadonlyArray` member.
 */
function hasLayersField(input: ContextInput): input is {
  readonly layers: readonly ContextLayer[];
} {
  return !Array.isArray(input) && 'layers' in input;
}

function layersOf(input: ContextInput): readonly ContextLayer[] {
  if (hasLayersField(input)) {
    return input.layers;
  }
  return input;
}

describe('ContextInput accepts the context() builder output', () => {
  it('spawn({ context: context([...]) }) compiles and carries the layers', () => {
    const config = context([
      workingMemoryContext(),
    ]);

    const spawned = spawn({
      id: 'spawn-with-config',
      child: makeChild(),
      context: config,
    });

    assert(spawned.context);
    expect(layersOf(spawned.context).map((layer) => layer.id)).toEqual([
      'working-context',
    ]);
  });

  it('provide({ context: context([...]) }) compiles and carries the layers', () => {
    const config = context([
      workingMemoryContext(),
    ]);

    const provided = provide({
      id: 'provide-with-config',
      child: makeChild(),
      context: config,
    });

    expect(layersOf(provided.context).map((layer) => layer.id)).toEqual([
      'working-context',
    ]);
  });

  it('react({ context: context([...]) }) compiles and wraps the loop in a spawn', () => {
    const config = context([
      workingMemoryContext(),
    ]);

    const reactStep = react({
      model: 'test-model',
      tools: [],
      context: config,
    });

    expect(reactStep.kind).toBe('spawn');
    assert(reactStep.kind === 'spawn');
    assert(reactStep.context);
    expect(layersOf(reactStep.context).map((layer) => layer.id)).toEqual([
      'working-context',
    ]);
  });

  it('the deprecated `memory` spelling takes a config too', () => {
    const config = context([
      workingMemoryContext(),
    ]);

    const spawned = spawn({
      id: 'spawn-with-deprecated-memory',
      child: makeChild(),
      memory: config,
    });

    assert(spawned.context);
    expect(layersOf(spawned.context).map((layer) => layer.id)).toEqual([
      'working-context',
    ]);
  });

  it('StepSpawn and StepProvide literals accept a config directly', () => {
    const config = context([
      workingMemoryContext(),
    ]);
    const child = makeChild();

    const spawnStep: StepSpawn<unknown, string, string> = {
      kind: 'spawn',
      id: 'literal-spawn',
      child,
      context: config,
    };
    const provideStep: StepProvide<unknown, string, string> = {
      kind: 'provide',
      id: 'literal-provide',
      child,
      context: config,
    };

    assert(spawnStep.context);
    expect(layersOf(spawnStep.context)).toHaveLength(1);
    expect(layersOf(provideStep.context)).toHaveLength(1);
  });

  it('a bare readonly layer array is still accepted', () => {
    const layers: readonly ContextLayer[] = [
      workingMemoryContext(),
    ];

    const spawned = spawn({
      id: 'spawn-with-readonly-array',
      child: makeChild(),
      context: layers,
    });

    assert(spawned.context);
    expect(layersOf(spawned.context).map((layer) => layer.id)).toEqual([
      'working-context',
    ]);
  });
});
