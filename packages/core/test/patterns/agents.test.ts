import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  CallModelRequest,
  Context,
  LLMResponse,
  Tool,
  ToolExecutionContext,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { tool } from '../../src/builders/tool-builder';
import type { HydrationContext } from '../../src/builders/workflow-hydrator';
import { hydrateNode } from '../../src/builders/workflow-hydrator';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { AgentRegistry } from '../../src/patterns/agent-nodes';
import { agentNodeHydrators } from '../../src/patterns/agent-nodes';
import type { Agent } from '../../src/patterns/agents';
import { asTool, defineAgent, handoff, quorum, teammate } from '../../src/patterns/agents';
import { WorkflowNodeSchema } from '../../src/schemas/workflow';
import { makeFunctionCall, sleep, textOnlyResponse } from '../_helpers';

/**
 * Scripted callModel that routes by the request's resolved model id.
 *
 * Mimics the real model loop's tool execution: any function_call items in a
 * scripted response are executed against the request's tools, so tools with
 * side effects — like handoff's transfer tools writing `ctx.state` — behave as
 * they would in production. Every request is recorded in `calls` so a test can
 * assert what each agent actually saw.
 */
function byModel(script: Record<string, () => LLMResponse>): {
  calls: CallModelRequest[];
  fn: (request: CallModelRequest) => Promise<LLMResponse>;
} {
  const calls: CallModelRequest[] = [];
  return {
    calls,
    fn: async (request: CallModelRequest): Promise<LLMResponse> => {
      calls.push(request);
      const make = script[request.model];
      if (!make) {
        throw new Error(`no scripted response for model ${request.model}`);
      }
      const response = make();
      for (const item of response.items) {
        if (item.type !== 'function_call') {
          continue;
        }
        const matched = request.tools?.find((candidate) => candidate.name === item.name);
        if (matched && request.ctx) {
          await matched.execute(JSON.parse(item.arguments), makeToolCtx(request.ctx));
        }
      }
      return response;
    },
  };
}

/**
 * Minimal `ToolExecutionContext` for driving a tool directly from a test.
 * Only `ctx` and `harness` are load-bearing for the agent patterns; the rest
 * satisfies the contract.
 */
function makeToolCtx(ctx: Context, harness?: AgentHarness): ToolExecutionContext {
  const layerAccessor = {
    get: () => undefined,
    set: () => {},
  };
  return frameworkCast<ToolExecutionContext>({
    ctx,
    harness,
    fs: harness?.fs,
    shell: harness?.shell,
    context: layerAccessor,
    // Deprecated alias — the same accessor, as buildToolExecutionContext does.
    memory: layerAccessor,
    assembledView: [],
    lastStepMeta: null,
  });
}

function makeAgentHydrationContext(agents?: AgentRegistry): HydrationContext {
  return {
    tools: new Map<string, Tool>(),
    executeStep: async (_step, input) => frameworkCast(input),
    nodeHydrators: agentNodeHydrators(agents ?? new Map()),
  };
}

const researcher = defineAgent({
  name: 'researcher',
  description: 'Finds facts.',
  model: 'test/researcher',
});

const writer = defineAgent({
  name: 'writer',
  description: 'Writes prose.',
  model: 'test/writer',
});

describe('defineAgent', () => {
  it('compiles once — the step object is stable and reused', () => {
    expect(researcher.step.kind).toBe('loop');
    expect(researcher.step).toBe(researcher.step);
    expect(researcher.step.id).toBe('agent:researcher');
  });

  it('rejects names that cannot be tool/wire names', () => {
    expect(() =>
      defineAgent({
        name: 'bad name!',
        description: 'x',
        model: 'test/m',
      }),
    ).toThrow('must match');
  });
});

describe('asTool (agents as tools / orchestrator)', () => {
  it('runs the agent in an isolated child context and returns its final text', async () => {
    const model = byModel({
      'test/researcher': () => textOnlyResponse('42 is the answer'),
    });
    const harness = new AgentHarness({
      name: 'orchestrator',
      params: {},
      _testCallModel: model.fn,
    });
    const ctx = harness.createContext();
    const agentTool = asTool(researcher);
    expect(agentTool.name).toBe('researcher');

    const result = await agentTool.execute(
      {
        task: 'what is the answer?',
      },
      makeToolCtx(ctx, harness),
    );
    expect(result).toBe('42 is the answer');
    // Isolation: the parent context's log must NOT contain the child's turn.
    expect(ctx.itemLog.items.length).toBe(0);
  });
});

describe('quorum', () => {
  const a = defineAgent({
    name: 'a',
    description: 'panelist',
    model: 'test/a',
  });
  const b = defineAgent({
    name: 'b',
    description: 'panelist',
    model: 'test/b',
  });
  const c = defineAgent({
    name: 'c',
    description: 'panelist',
    model: 'test/c',
  });
  const panel = [
    a,
    b,
    c,
  ];

  it('majority vote picks the most common (normalized) answer', async () => {
    const model = byModel({
      'test/a': () => textOnlyResponse('Paris'),
      'test/b': () => textOnlyResponse('  paris  '),
      'test/c': () => textOnlyResponse('Lyon'),
    });
    const harness = new AgentHarness({
      name: 'panel',
      params: {},
      _testCallModel: model.fn,
    });
    const result = await harness.run(
      quorum(panel, {
        vote: {
          kind: 'majority',
        },
      }),
      'capital of France?',
      harness.createContext(),
    );
    // Normalization decides the winner, but the ORIGINAL casing is returned.
    expect(result).toBe('Paris');
  });

  it("'all' vote returns labeled sections from every agent", async () => {
    const model = byModel({
      'test/a': () => textOnlyResponse('alpha view'),
      'test/b': () => textOnlyResponse('beta view'),
      'test/c': () => textOnlyResponse('gamma view'),
    });
    const harness = new AgentHarness({
      name: 'panel',
      params: {},
      _testCallModel: model.fn,
    });
    const result = await harness.run(
      quorum(panel, {
        vote: {
          kind: 'all',
        },
      }),
      'opinions?',
      harness.createContext(),
    );
    expect(result).toContain('## a');
    expect(result).toContain('beta view');
    expect(result).toContain('## c');
  });

  it('judge vote fans out then reduces via the judge agent', async () => {
    const judge = defineAgent({
      name: 'judge',
      description: 'Scores candidates.',
      model: 'test/judge',
    });
    const model = byModel({
      'test/a': () => textOnlyResponse('draft A'),
      'test/b': () => textOnlyResponse('draft B'),
      'test/c': () => textOnlyResponse('draft C'),
      'test/judge': () => textOnlyResponse('B is best: final answer B'),
    });
    const harness = new AgentHarness({
      name: 'panel',
      params: {},
      _testCallModel: model.fn,
    });
    const result = await harness.run(
      quorum(panel, {
        vote: {
          kind: 'judge',
          judge,
        },
      }),
      'write a tagline',
      harness.createContext(),
    );
    expect(result).toContain('final answer B');
    // The judge saw labeled candidates.
    const judgeCall = model.calls.find((r) => r.model === 'test/judge');
    assert(judgeCall !== undefined);
    expect(JSON.stringify(judgeCall.items)).toContain('Candidate from a');
  });

  it('a failed panelist degrades the quorum instead of failing it', async () => {
    const model = byModel({
      'test/a': () => textOnlyResponse('yes'),
      'test/b': () => {
        throw new Error('panelist b crashed');
      },
      'test/c': () => textOnlyResponse('yes'),
    });
    const harness = new AgentHarness({
      name: 'panel',
      params: {},
      _testCallModel: model.fn,
    });
    const result = await harness.run(
      quorum(panel, {
        vote: {
          kind: 'majority',
        },
      }),
      'proceed?',
      harness.createContext(),
    );
    expect(result).toBe('yes');
  });

  it('requires at least one agent', () => {
    expect(() =>
      quorum([], {
        vote: {
          kind: 'first',
        },
      }),
    ).toThrow('at least one agent');
  });
});

describe('handoff (routing swarm)', () => {
  it('transfer tool swaps the active agent; conversation continues under the peer', async () => {
    let triageCalls = 0;
    const model = byModel({
      'test/triage': () => {
        triageCalls++;
        if (triageCalls === 1) {
          // First turn: triage decides to hand off to billing.
          return {
            items: [
              makeFunctionCall(
                'transfer_to_billing',
                JSON.stringify({
                  reason: 'billing question',
                }),
              ),
            ],
            usage: {
              inputTokens: 10,
              outputTokens: 5,
            },
          };
        }
        return textOnlyResponse('triage should not answer again');
      },
      'test/billing': () => textOnlyResponse('Refund issued.'),
    });

    const triage = defineAgent({
      name: 'triage',
      description: 'Routes requests.',
      model: 'test/triage',
    });
    const billing = defineAgent({
      name: 'billing',
      description: 'Handles billing.',
      model: 'test/billing',
    });

    const harness = new AgentHarness({
      name: 'swarm',
      params: {},
      _testCallModel: model.fn,
    });
    const result = await harness.run(
      handoff([
        triage,
        billing,
      ]),
      'I was double-charged',
      harness.createContext(),
    );
    expect(result).toBe('Refund issued.');
    const billingCall = model.calls.find((r) => r.model === 'test/billing');
    assert(billingCall !== undefined);
    // The billing turn saw the original conversation (shared log).
    expect(JSON.stringify(billingCall.items)).toContain('double-charged');
    // And the billing turn's instructions identify the active agent.
    expect(billingCall.instructions).toContain('You are billing');
  });

  it('requires at least two agents', () => {
    expect(() =>
      handoff([
        researcher,
      ]),
    ).toThrow('at least two');
  });

  it('rejects an entry agent that is not in the swarm', () => {
    expect(() =>
      handoff(
        [
          researcher,
          writer,
        ],
        {
          entry: 'ghost',
        },
      ),
    ).toThrow('is not in the swarm');
  });
});

describe('teammate (named background workers)', () => {
  it('runs detached, reports status, and delivers the result', async () => {
    const model = byModel({
      'test/researcher': () => textOnlyResponse('background research complete'),
    });
    const harness = new AgentHarness({
      name: 'main',
      params: {},
      _testCallModel: model.fn,
    });
    const ctx = harness.createContext();
    const worker = teammate(researcher, 'research the topic', {
      harness,
      ctx,
    });
    expect(worker.name).toBe('researcher');
    const result = await worker.result(5_000);
    expect(result).toContain('background research complete');
    expect(worker.status()).toBe('completed');
    // Parent log untouched by the teammate's work.
    expect(ctx.itemLog.items.length).toBe(0);
  });

  it('surfaces failures on the outbox instead of throwing into the parent', async () => {
    const model = byModel({
      'test/writer': () => {
        throw new Error('writer exploded');
      },
    });
    const harness = new AgentHarness({
      name: 'main',
      params: {},
      _testCallModel: model.fn,
    });
    const ctx = harness.createContext();
    const worker = teammate(writer, 'write a poem', {
      harness,
      ctx,
    });
    await sleep(50);
    expect(worker.status()).toBe('failed');
    const note = harness.tryRecv(worker.outbox, ctx);
    assert(note !== null);
    expect(note).toContain('[writer failed]');
  });
});

describe('composition: orchestrator with agent tools + a regular tool', () => {
  it('an llm agent can call both a plain tool and an agent tool in one pool', async () => {
    const calc = tool({
      name: 'calc',
      description: 'Adds two numbers',
      input: z.object({
        a: z.number(),
        b: z.number(),
      }),
      output: z.number(),
      execute: async (args) => args.a + args.b,
    });
    const pool: Tool[] = [
      frameworkCast<Tool>(calc),
      asTool(researcher),
    ];
    expect(pool.map((t) => t.name)).toEqual([
      'calc',
      'researcher',
    ]);
    // Both expose Zod input schemas — the unified pool treats them identically.
    expect(
      pool[1].input.safeParse({
        task: 'find x',
      }).success,
    ).toBe(true);
  });
});

describe('JSON runtime: agent node kinds', () => {
  const agents = new Map<string, Agent>([
    [
      'researcher',
      researcher,
    ],
    [
      'writer',
      writer,
    ],
  ]);

  it('hydrates an agent-tool node into an llm step whose pool includes the agents', () => {
    const ctx = makeAgentHydrationContext(agents);
    const node = WorkflowNodeSchema.parse({
      kind: 'agent-tool',
      id: 'orchestrate',
      instructions: 'Delegate to your agents.',
      agents: [
        'researcher',
        'writer',
      ],
    });
    const hydrated = hydrateNode(node, ctx);
    expect(hydrated.kind).toBe('llm');
    assert(hydrated.kind === 'llm');
    const tools = frameworkCast<Tool[]>(hydrated.tools);
    expect(tools.map((t) => t.name)).toEqual([
      'researcher',
      'writer',
    ]);
  });

  it('hydrates a handoff node into a routing loop', () => {
    const ctx = makeAgentHydrationContext(agents);
    const node = WorkflowNodeSchema.parse({
      kind: 'handoff',
      id: 'swarm',
      agents: [
        'researcher',
        'writer',
      ],
    });
    expect(hydrateNode(node, ctx).kind).toBe('loop');
  });

  it('hydrates a quorum node into a settle fork', () => {
    const ctx = makeAgentHydrationContext(agents);
    const node = WorkflowNodeSchema.parse({
      kind: 'quorum',
      id: 'panel',
      agents: [
        'researcher',
        'writer',
      ],
      vote: {
        kind: 'majority',
      },
    });
    expect(hydrateNode(node, ctx).kind).toBe('fork');
  });

  it('hydrates a judge-vote quorum node into a loop that ends with the judge turn', () => {
    const judge = defineAgent({
      name: 'reviewer',
      description: 'Picks the best candidate.',
      model: 'test/reviewer',
    });
    const ctx = makeAgentHydrationContext(
      new Map<string, Agent>([
        ...agents,
        [
          'reviewer',
          judge,
        ],
      ]),
    );
    const node = WorkflowNodeSchema.parse({
      kind: 'quorum',
      id: 'judged-panel',
      agents: [
        'researcher',
        'writer',
      ],
      vote: {
        kind: 'judge',
        judge: 'reviewer',
        criteria: 'Prefer the most concise answer.',
      },
    });
    const hydrated = hydrateNode(node, ctx);
    expect(hydrated.kind).toBe('loop');
    assert(hydrated.kind === 'loop');
    expect(hydrated.steps.map((s) => s.kind)).toEqual([
      'fork',
      'llm',
    ]);
  });

  it('unknown agent references fail hydration with a typed config error', () => {
    const node = WorkflowNodeSchema.parse({
      kind: 'handoff',
      id: 'bad',
      agents: [
        'ghost',
        'phantom',
      ],
    });
    expect(() => hydrateNode(node, makeAgentHydrationContext())).toThrow(
      "Agent 'ghost' referenced in workflow is not registered",
    );
  });
});

describe('structured agent output', () => {
  it('forwards a Zod schema into the compiled llm step', () => {
    const structured = defineAgent({
      name: 'extractor',
      description: 'Extracts fields.',
      model: 'test/extractor',
      output: z.object({
        city: z.string(),
      }),
    });
    const llmStep = structured.step.steps[0];
    expect(llmStep.kind).toBe('llm');
    assert(llmStep.kind === 'llm');
    expect(llmStep.output).toBeDefined();
  });

  it('asTool serializes a structured result for the calling model', async () => {
    const structured = defineAgent({
      name: 'extractor2',
      description: 'Extracts fields.',
      model: 'test/extractor2',
      output: z.object({
        city: z.string(),
      }),
    });
    const model = byModel({
      'test/extractor2': () =>
        textOnlyResponse(
          JSON.stringify({
            city: 'Paris',
          }),
        ),
    });
    const harness = new AgentHarness({
      name: 'orchestrator',
      params: {},
      _testCallModel: model.fn,
    });
    const result = await asTool(structured).execute(
      {
        task: 'which city?',
      },
      makeToolCtx(harness.createContext(), harness),
    );
    expect(result).toBe(
      JSON.stringify({
        city: 'Paris',
      }),
    );
  });
});
