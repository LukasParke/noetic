import { describe, expect, test } from 'bun:test';
import type { Step, SubHarness, SubHarnessKind, SubHarnessSession } from '@noetic-tools/core';
import { isServerToolSpec, spawn, step, tool } from '@noetic-tools/core';
import { z } from 'zod';
import { discoverFields } from '../../src/optimization/field-discovery';
import { applyCandidate } from '../../src/optimization/mutator';

function mockSubHarness(kind: SubHarnessKind): SubHarness {
  return {
    specificationVersion: 'harness-v1',
    harnessId: kind,
    async doStart(): Promise<SubHarnessSession> {
      return {
        sessionId: 's',
        isResume: false,
        async doPromptTurn() {
          return {
            items: [],
            text: '',
          };
        },
        async doStop() {
          return {
            harnessId: kind,
            sessionId: 's',
            state: null,
          };
        },
      };
    },
  };
}

function getLlmInstructions(s: Step): string | undefined {
  if (s.kind !== 'llm') {
    throw new Error(`Expected llm step, got ${s.kind}`);
  }
  const { instructions } = s;
  if (typeof instructions === 'function') {
    throw new Error(
      'Expected eager string instructions on llm step, got function-form Lazy getter',
    );
  }
  return instructions;
}

function getLlmModel(s: Step): string {
  if (s.kind !== 'llm') {
    throw new Error(`Expected llm step, got ${s.kind}`);
  }
  const { model } = s;
  if (typeof model === 'function') {
    throw new Error('Expected eager string model on llm step, got function-form Lazy getter');
  }
  return model;
}

/** First client tool of an llm step, with its optimizable name/description. */
function getFirstClientTool(s: Step): {
  name: string;
  description: string;
} {
  if (s.kind !== 'llm' || !Array.isArray(s.tools)) {
    throw new Error('Expected an llm step with an eager tool array');
  }
  const first = s.tools[0];
  if (first === undefined || isServerToolSpec(first)) {
    throw new Error('Expected a client tool at index 0');
  }
  return {
    name: first.name,
    description: first.description,
  };
}

function getSpawnChild(s: Step): Step {
  if (s.kind !== 'spawn') {
    throw new Error(`Expected spawn step, got ${s.kind}`);
  }
  return s.child;
}

describe('applyCandidate', () => {
  test('replaces instructions in StepLLM', () => {
    const llmStep = step.llm({
      id: 'my-llm',
      model: 'test-model',
      instructions: 'Original prompt',
    });

    const result = applyCandidate(llmStep, {
      'my-llm.instructions': 'Optimized prompt',
    });

    expect(result.kind).toBe('llm');
    expect(getLlmInstructions(result)).toBe('Optimized prompt');
  });

  test('does not mutate the original step', () => {
    const llmStep = step.llm({
      id: 'my-llm',
      model: 'test-model',
      instructions: 'Original prompt',
    });

    applyCandidate(llmStep, {
      'my-llm.instructions': 'Optimized prompt',
    });

    expect(llmStep.instructions).toBe('Original prompt');
  });

  test('replaces instructions in nested StepSpawn > StepLLM', () => {
    const llmStep = step.llm({
      id: 'inner-llm',
      model: 'test-model',
      instructions: 'Inner original',
    });

    const spawnStep = spawn({
      id: 'outer-spawn',
      child: llmStep,
    });

    const result = applyCandidate(spawnStep, {
      'outer-spawn.inner-llm.instructions': 'Inner optimized',
    });

    expect(result.kind).toBe('spawn');
    const child = getSpawnChild(result);
    expect(getLlmInstructions(child)).toBe('Inner optimized');
  });

  test('preserves fields not in the candidate map', () => {
    const llmStep = step.llm({
      id: 'my-llm',
      model: 'test-model',
      instructions: 'Keep this',
    });

    const result = applyCandidate(llmStep, {});

    expect(result.kind).toBe('llm');
    expect(getLlmInstructions(result)).toBe('Keep this');
    expect(getLlmModel(result)).toBe('test-model');
  });

  test('clones run step without error', () => {
    const runStep = step.run({
      id: 'my-run',
      execute: async (input: unknown) => input,
    });

    const result = applyCandidate(runStep, {});

    expect(result.kind).toBe('run');
    expect(result.id).toBe('my-run');
    expect(result).not.toBe(runStep);
  });

  // Regression: when `main` added sub-harness steps (`claude-code`, `codex`,
  // `opencode`, `pi`) to the `Step` union, `cloneAndReplace` stopped being
  // exhaustive and tsc failed with TS2366. At runtime the missing cases also
  // returned `undefined` for any sub-harness step the optimizer touched.
  // Lock in the pass-through behavior for all four kinds.
  describe('sub-harness step kinds (regression)', () => {
    const SUB_HARNESS_BUILDERS = [
      {
        kind: 'claude-code' as const,
        build: () =>
          step.claudeCode({
            id: 'cc',
            harness: mockSubHarness('claude-code'),
            prompt: 'do a thing',
          }),
      },
      {
        kind: 'codex' as const,
        build: () =>
          step.codex({
            id: 'cx',
            harness: mockSubHarness('codex'),
            prompt: 'do a thing',
          }),
      },
      {
        kind: 'opencode' as const,
        build: () =>
          step.opencode({
            id: 'oc',
            harness: mockSubHarness('opencode'),
            prompt: 'do a thing',
          }),
      },
      {
        kind: 'pi' as const,
        build: () =>
          step.pi({
            id: 'pi',
            harness: mockSubHarness('pi'),
            prompt: 'do a thing',
          }),
      },
    ];

    for (const { kind, build } of SUB_HARNESS_BUILDERS) {
      test(`clones ${kind} step without throwing or returning undefined`, () => {
        const original = build();
        const result: Step | undefined = applyCandidate(original, {});

        expect(result).toBeDefined();
        expect(result.kind).toBe(kind);
        expect(result.id).toBe(original.id);
      });
    }
  });
});

describe('index-keyed tool paths (G2)', () => {
  test("a tool rename does not orphan the tool's other candidate fields", () => {
    const searchTool = tool({
      name: 'search',
      description: 'original description',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
    });
    const llm = step.llm({
      id: 'agent',
      model: 't/m',
      instructions: 'base',
      tools: [
        searchTool,
      ],
    });

    // Discovery keys by index, so paths survive a rename.
    const fields = discoverFields(llm);
    const paths = fields.map((f) => f.path);
    expect(paths).toContain('agent.tools.0.name');
    expect(paths).toContain('agent.tools.0.description');

    // A candidate that BOTH renames the tool and rewrites its description:
    // with name-keyed paths the description lookup missed after the rename.
    const mutated = applyCandidate(llm, {
      'agent.tools.0.name': 'find_docs',
      'agent.tools.0.description': 'improved description',
    });
    const mutatedTool = getFirstClientTool(mutated);
    expect(mutatedTool.name).toBe('find_docs');
    expect(mutatedTool.description).toBe('improved description');

    // Applying the same candidate to the ALREADY-mutated tree (as each GEPA
    // round does) must be stable — the index key still resolves.
    const twice = applyCandidate(mutated, {
      'agent.tools.0.description': 'round-two description',
    });
    expect(getFirstClientTool(twice).description).toBe('round-two description');
  });
});
