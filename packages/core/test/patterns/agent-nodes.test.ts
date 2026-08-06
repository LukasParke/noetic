// The agent node kinds (`agent-tool` / `handoff` / `quorum`) reach the JSON
// runtime through `HydrationContext.nodeHydrators` rather than the built-in
// registry, because their builders live in the pattern layer. These cases pin
// that seam: the kinds must be unknown until an agent registry is supplied,
// available at any document depth once it is, and unable to shadow a built-in.

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Tool } from '@noetic-tools/types';
import { frameworkCast, isNoeticConfigError } from '@noetic-tools/types';
import type { HydrationContext } from '../../src/builders/workflow-hydrator';
import { hydrateNode, hydrateWorkflow } from '../../src/builders/workflow-hydrator';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { AgentRegistry } from '../../src/patterns/agent-nodes';
import { agentNodeHydrators } from '../../src/patterns/agent-nodes';
import { defineAgent } from '../../src/patterns/agents';
import { parseAndRunWorkflow } from '../../src/patterns/dynamic-workflow';
import type { WorkflowNode } from '../../src/schemas/workflow';
import { validateWorkflow } from '../../src/schemas/workflow';
import { createScriptedCallModel, makeLLMResponse } from '../_helpers';

const scout = defineAgent({
  name: 'scout',
  description: 'Gathers context.',
  model: 'test/scout',
});

const drafter = defineAgent({
  name: 'drafter',
  description: 'Writes the draft.',
  model: 'test/drafter',
});

const REGISTRY: AgentRegistry = new Map([
  [
    'scout',
    scout,
  ],
  [
    'drafter',
    drafter,
  ],
]);

function makeCtx(agents?: AgentRegistry): HydrationContext {
  return {
    tools: new Map<string, Tool>(),
    executeStep: async (_step, input) => frameworkCast(input),
    ...(agents
      ? {
          nodeHydrators: agentNodeHydrators(agents),
        }
      : {}),
  };
}

describe('agent node kinds are contributed, not built in', () => {
  it('an agent node kind is unknown when no hydrators are contributed', () => {
    const node: WorkflowNode = {
      kind: 'handoff',
      id: 'swarm',
      agents: [
        'scout',
        'drafter',
      ],
    };
    try {
      hydrateNode(node, makeCtx());
      throw new Error('expected hydration to fail');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_NODE_KIND');
    }
  });

  it('the unknown-kind hint lists contributed kinds alongside the built-ins', () => {
    const node = frameworkCast<WorkflowNode>({
      kind: 'not-a-kind',
      id: 'x',
    });
    try {
      hydrateNode(node, makeCtx(REGISTRY));
      throw new Error('expected hydration to fail');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.hint).toContain('llm');
      expect(e.hint).toContain('quorum');
    }
  });

  it('a contributed hydrator cannot shadow a built-in kind', () => {
    const ctx: HydrationContext = {
      ...makeCtx(REGISTRY),
      nodeHydrators: new Map([
        [
          'llm',
          () => {
            throw new Error('a contributed hydrator must not win over a built-in');
          },
        ],
      ]),
    };
    const node: WorkflowNode = {
      kind: 'llm',
      id: 'plain',
      instructions: 'hello',
    };
    expect(hydrateNode(node, ctx).kind).toBe('llm');
  });

  it('contributed kinds resolve at any depth, not only at the root', () => {
    const doc = validateWorkflow({
      version: 1,
      root: {
        kind: 'sequence',
        id: 'outer',
        steps: [
          {
            kind: 'spawn',
            id: 'isolate',
            child: {
              kind: 'quorum',
              id: 'deep-panel',
              agents: [
                'scout',
                'drafter',
              ],
              vote: {
                kind: 'first',
              },
            },
          },
        ],
      },
    });
    // Reaching a nested contributed kind proves the map threads down with the
    // rest of the hydration context.
    expect(hydrateWorkflow(doc, makeCtx(REGISTRY)).kind).toBe('run');
  });

  it('a judge that is not on the panel still has to be registered', () => {
    const node: WorkflowNode = {
      kind: 'quorum',
      id: 'panel',
      agents: [
        'scout',
      ],
      vote: {
        kind: 'judge',
        judge: 'nobody',
      },
    };
    try {
      hydrateNode(node, makeCtx(REGISTRY));
      throw new Error('expected hydration to fail');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('UNKNOWN_AGENT_REFERENCE');
      // The hint names what IS registered so a planner can repair the document.
      expect(e.hint).toContain('scout');
    }
  });
});

describe('parseAndRunWorkflow agent registry', () => {
  it('runs a handoff document end to end when agents are supplied', async () => {
    const harness = new AgentHarness({
      name: 'agent-nodes-test',
      params: {},
      _testCallModel: createScriptedCallModel([
        makeLLMResponse('scout answered without transferring'),
      ]),
    });
    const result = await parseAndRunWorkflow({
      json: {
        version: 1,
        root: {
          kind: 'handoff',
          id: 'swarm',
          agents: [
            'scout',
            'drafter',
          ],
        },
      },
      harness,
      ctx: harness.createContext(),
      tools: [],
      input: 'kick off',
      agents: REGISTRY,
    });
    expect(result).toBe('scout answered without transferring');
  });

  it('rejects an agent node when the registry is omitted', async () => {
    const harness = new AgentHarness({
      name: 'agent-nodes-test',
      params: {},
      _testCallModel: createScriptedCallModel([
        makeLLMResponse('unused'),
      ]),
    });
    await expect(
      parseAndRunWorkflow({
        json: {
          version: 1,
          root: {
            kind: 'handoff',
            id: 'swarm-unregistered',
            agents: [
              'scout',
              'drafter',
            ],
          },
        },
        harness,
        ctx: harness.createContext(),
        tools: [],
      }),
    ).rejects.toThrow('Unknown workflow node kind');
  });
});
