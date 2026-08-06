/**
 * agents.ts — the Agent noun and the multi-agent patterns built on it.
 *
 * Every popular multi-agent shape reduces to "an agent participating as a
 * first-class value": callable as a tool (orchestrator/sub-agents),
 * transferable-to (handoff/swarm), fan-out-able and votable (quorum/panel/
 * advisors), or addressable in the background (teammate). None of these need
 * a new Step kind — an `AgentDef` COMPILES to the existing primitives
 * (loop + llm + spawn + fork + channel), so everything here nests inside
 * fork/branch/loop/JSON workflows like any other step and inherits the
 * runtime's context assembly, durability, tracing, and cache behavior.
 */

import type { ContextConfig, ContextData, ContextLayer } from '@noetic-tools/context';
import type {
  Channel,
  Context,
  DetachedHandle,
  Lazy,
  SettleResult,
  Step,
  StepLoop,
  StepSpawn,
  Tool,
  ToolExecutionContext,
  Until,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { channel } from '../builders/channel-builder';
import { fork } from '../builders/control-flow-builders';
import { loop } from '../builders/loop-builder';
import { spawn } from '../builders/spawn-builder';
import { step } from '../builders/step-builders';
import { tool } from '../builders/tool-builder';
import { any } from '../until/combinators';
import { until } from '../until/predicates';

//#region defineAgent

/** @public A reusable agent definition — the noun the multi-agent patterns share. */
export interface AgentDef {
  /** Unique, tool-name-safe identifier (letters, digits, `_`, `-`). */
  name: string;
  /** What this agent is for — becomes the tool description in `asTool` and the transfer rationale in `handoff`. */
  description: string;
  model: Lazy<string, ContextData>;
  instructions?: Lazy<string | undefined, ContextData>;
  tools?: Tool[];
  /** Agent-local context layers (spawn-isolated when run via asTool/quorum/teammate). */
  context?: ContextConfig | ContextLayer[];
  /** Termination predicate. Default: `any(noToolCalls, maxSteps(10))`. */
  until?: Until;
  /** Hard iteration ceiling for the agent's loop. Default 25. */
  maxIterations?: number;
  /**
   * Structured output: the agent's final text is JSON-parsed and validated
   * against this schema by its llm step. `asTool` then returns the JSON
   * string of the validated value.
   */
  output?: ZodType;
}

/** @public A compiled agent: the definition plus its memoized executable step. */
export interface Agent extends AgentDef {
  /** The agent's ReAct loop, compiled once and reused by every pattern. */
  readonly step: StepLoop<ContextData, string, string>;
}

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Default per-turn step ceiling before an agent's loop re-evaluates. */
const DEFAULT_AGENT_MAX_STEPS = 10;

/** Default hard iteration cap on an agent's own loop. */
const DEFAULT_AGENT_MAX_ITERATIONS = 25;

/** Default hard iteration cap on a handoff swarm's routing loop. */
const DEFAULT_SWARM_MAX_ITERATIONS = 50;

/** Default step ceiling for one swarm conversation. */
const DEFAULT_SWARM_MAX_STEPS = 30;

/**
 * Compiles an `AgentDef` into a reusable `Agent`.
 *
 * The step is built once — patterns that embed the same agent in many places
 * share one step object, so tool-conversion caches and the unified-tool walk
 * see stable identities.
 *
 * @public
 * @param def - Name, description, model, and the optional tools/context/limits the agent runs with.
 * @returns The definition plus its memoized `step` (a `loop` over one `llm` step).
 * @throws `Error` if `name` is not a valid tool/wire name (`/^[a-zA-Z0-9_-]{1,64}$/`).
 */
export function defineAgent(def: AgentDef): Agent {
  if (!AGENT_NAME_RE.test(def.name)) {
    throw new Error(
      `defineAgent: name ${JSON.stringify(def.name)} must match ${AGENT_NAME_RE} (it becomes a tool/wire name).`,
    );
  }
  const agentStep = loop<ContextData, string, string>({
    id: `agent:${def.name}`,
    steps: [
      step.llm<ContextData, string, string>({
        id: `agent:${def.name}:llm`,
        model: def.model,
        instructions: def.instructions,
        tools: def.tools,
        // A hydrated agent step is typed `<string, string>` (the pattern
        // boundary erases the schema's output type); the runtime still returns
        // the validated value, which `asTool` serializes for its caller.
        ...(def.output
          ? {
              output: frameworkCast<ZodType<string>>(def.output),
            }
          : {}),
      }),
    ],
    until: def.until ?? any(until.noToolCalls(), until.maxSteps(DEFAULT_AGENT_MAX_STEPS)),
    maxIterations: def.maxIterations ?? DEFAULT_AGENT_MAX_ITERATIONS,
  });
  return {
    ...def,
    step: agentStep,
  };
}

/** Wrap an agent's loop in an isolated spawn (fresh ItemLog + agent-local context). */
function isolated(agent: Agent, idSuffix: string): StepSpawn<ContextData, string, string> {
  return spawn<ContextData, string, string>({
    id: `agent:${agent.name}:${idSuffix}`,
    child: agent.step,
    ...(agent.context
      ? {
          context: agent.context,
        }
      : {}),
  });
}

/**
 * Resolve a `Lazy` agent field against the live context.
 *
 * Deliberately a local 4-liner rather than the interpreter's exported
 * `resolveLazy`: patterns may consume the interpreter, but keeping the
 * pattern layer's import graph free of it keeps `agents.ts` composed purely
 * of builders.
 */
async function resolveLazyValue<T>(
  value: Lazy<T, ContextData> | undefined,
  ctx: Context<ContextData>,
): Promise<T> {
  if (typeof value !== 'function') {
    return frameworkCast<T>(value);
  }
  const getter = frameworkCast<(c: Context<ContextData>) => T | Promise<T>>(value);
  return await getter(ctx);
}

//#endregion

//#region asTool — agents as tools (orchestrator / sub-agents)

/** @public Options for exposing an agent as a callable tool. */
export interface AsToolOptions {
  /** Override the tool name (default: the agent's name). */
  name?: string;
  /** Override the tool description (default: the agent's description). */
  description?: string;
  /**
   * Run detached: the tool returns immediately with a task id, the agent works
   * in the background, and its result is delivered to `resultChannel` (or
   * discarded if none is given). Pair with a loop `inbox` for async delegation.
   */
  detached?: boolean;
  /** Channel that receives `"[<agent> done] <result>"` when a detached run settles. */
  resultChannel?: Channel<string>;
}

/** Zod input every agent-as-tool accepts: one self-contained task string. */
function agentTaskInput(): ZodType<{
  task: string;
}> {
  return z.object({
    task: z.string().describe('The task or question for this agent, with all context it needs.'),
  });
}

/** The detached form: fire the agent onto its own thread, report the task id. */
function detachedAgentTool(agent: Agent, opts: AsToolOptions): Tool {
  const resultChannel = opts.resultChannel;
  return frameworkCast<Tool>(
    tool({
      name: opts.name ?? agent.name,
      description: `${opts.description ?? agent.description} (Runs in the background; returns a task id immediately. The result arrives as a message when ready.)`,
      input: agentTaskInput(),
      output: z.string(),
      execute: async (
        args: {
          task: string;
        },
        toolCtx: ToolExecutionContext,
      ) => {
        const handle: DetachedHandle<string> = toolCtx.harness.detachedSpawn(
          isolated(agent, 'detached'),
          args.task,
          toolCtx.ctx,
          {
            // A fresh per-delegation thread keeps the worker's transcript
            // out of the parent's session log.
            threadId: `${agent.name}-${crypto.randomUUID().slice(0, 8)}`,
          },
        );
        if (resultChannel) {
          void handle
            .await()
            .then((result) =>
              toolCtx.harness.send(resultChannel, `[${agent.name} done] ${result}`, toolCtx.ctx),
            )
            .catch((e: unknown) =>
              toolCtx.harness.send(
                resultChannel,
                `[${agent.name} failed] ${e instanceof Error ? e.message : String(e)}`,
                toolCtx.ctx,
              ),
            );
        }
        return `Started background agent '${agent.name}' (task ${handle.id}).`;
      },
    }),
  );
}

/**
 * Exposes an agent as a `Tool`.
 *
 * The calling model sees a function named after the agent; invoking it runs
 * the agent to completion in an ISOLATED child context (fresh history,
 * agent-local context layers, own token/cost roll-up) and returns its final
 * text. This is the orchestrator pattern:
 *
 * ```ts
 * step.llm({ id: 'lead', model, tools: [asTool(researcher), asTool(coder)] })
 * ```
 *
 * @public
 * @param agent - The compiled agent to expose.
 * @param opts.name - Override the tool name (default: the agent's name).
 * @param opts.description - Override the tool description (default: the agent's description).
 * @param opts.detached - Return immediately with a task id and run the agent in the background.
 * @param opts.resultChannel - Channel a detached run reports its result on.
 * @returns A `Tool` whose input is `{ task: string }` and whose output is the agent's final text.
 */
export function asTool(agent: Agent, opts?: AsToolOptions): Tool {
  if (opts?.detached) {
    return detachedAgentTool(agent, opts);
  }

  return frameworkCast<Tool>(
    tool({
      name: opts?.name ?? agent.name,
      description: opts?.description ?? agent.description,
      input: agentTaskInput(),
      output: z.string(),
      execute: async (
        args: {
          task: string;
        },
        toolCtx: ToolExecutionContext,
      ) => {
        const result = await toolCtx.harness.run(
          isolated(agent, 'as-tool'),
          args.task,
          toolCtx.ctx,
        );
        // A structured-output agent returns the validated value; serialize it
        // for the calling model. Plain agents return their final text as-is.
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    }),
  );
}

//#endregion

//#region handoff — routing swarm

/** @public Options for a handoff swarm. */
export interface HandoffOptions {
  /** Agent that owns the conversation first. Default: the first of `agents`. */
  entry?: string;
  /** Loop termination. Default: `any(untilNoTransfer, maxSteps(30))`. */
  until?: Until;
  maxIterations?: number;
}

interface SwarmState {
  activeAgent?: string;
}

/** Prefix every generated transfer tool shares — also the handoff loop's stop signal. */
const TRANSFER_TOOL_PREFIX = 'transfer_to_';

/** Read the swarm's routing state off the live context, without creating it. */
function readSwarmState(ctx: Context<ContextData>): SwarmState {
  return frameworkCast<SwarmState>(ctx.state ?? {});
}

/**
 * Read the swarm's routing state, creating it if the execution has none yet.
 *
 * `Context.state` is the sanctioned per-execution scratch space and survives
 * loop iterations, which is what makes the active-agent swap visible to the
 * next iteration's `Lazy` getters.
 */
function writableSwarmState(ctx: Context): SwarmState {
  const existing = ctx.state;
  if (existing === undefined || existing === null) {
    const created: SwarmState = {};
    ctx.state = created;
    return created;
  }
  return frameworkCast<SwarmState>(existing);
}

/**
 * Build each agent's `transfer_to_<peer>` tools, keyed by the owning agent.
 *
 * Executing one writes the peer's name onto `ctx.state`, which the loop's
 * `Lazy` model/instructions/tools getters read on the next iteration.
 */
function buildTransferTools(agents: ReadonlyArray<Agent>): Map<string, Tool[]> {
  const transferTools = new Map<string, Tool[]>();
  for (const agent of agents) {
    const peers = agents.filter((a) => a.name !== agent.name);
    transferTools.set(
      agent.name,
      peers.map((peer) =>
        frameworkCast<Tool>(
          tool({
            name: `${TRANSFER_TOOL_PREFIX}${peer.name}`,
            description: `Hand the conversation to ${peer.name}: ${peer.description}. Use when the request is better handled by them. The full conversation carries over.`,
            input: z.object({
              reason: z.string().describe('Why this agent should take over.'),
            }),
            output: z.string(),
            execute: async (
              args: {
                reason: string;
              },
              toolCtx: ToolExecutionContext,
            ) => {
              writableSwarmState(toolCtx.ctx).activeAgent = peer.name;
              return `Transferred to ${peer.name} (${args.reason}). They will continue from here.`;
            },
          }),
        ),
      ),
    );
  }
  return transferTools;
}

/**
 * The active agent's tool-round loop runs to completion under ONE model (the
 * `Lazy` fields resolve once per llm-step execution), so the swap happens at
 * the LOOP boundary: continue when this iteration transferred, stop when the
 * active agent finished a turn without transferring.
 */
const untilNoTransfer: Until = (snapshot) => {
  const transferred = (snapshot.lastStepMeta?.toolCalls ?? []).some((c) =>
    c.name.startsWith(TRANSFER_TOOL_PREFIX),
  );
  if (transferred) {
    return {
      stop: false,
      reason: 'handoff in progress',
    };
  }
  return {
    stop: true,
    reason: 'active agent answered without transferring',
  };
};

/**
 * Creates a routing swarm over a set of agents.
 *
 * Every agent gets a `transfer_to_<peer>` tool for each of its peers. Calling
 * one ends the current agent's round and the SAME conversation continues under
 * the target agent's model/instructions/tools — the swap is a `Lazy`
 * resolution against `ctx.state`, and history carries over because all agents
 * share the loop's ItemLog. This is the OpenAI Swarm / Agents-SDK handoff
 * pattern as a plain `StepLoop`.
 *
 * @public
 * @param agents - The swarm members (at least two).
 * @param opts.entry - Name of the agent that owns the conversation first. Default: the first agent.
 * @param opts.until - Loop termination. Default: stop when the active agent answers without transferring, or at 30 steps.
 * @param opts.maxIterations - Hard iteration cap. Default 50.
 * @returns A `StepLoop` that routes one conversation across the swarm.
 * @throws `Error` if fewer than two agents are given, or if `entry` names a non-member.
 */
export function handoff(
  agents: ReadonlyArray<Agent>,
  opts?: HandoffOptions,
): StepLoop<ContextData, string, string> {
  if (agents.length < 2) {
    throw new Error('handoff: at least two agents are required.');
  }
  const byName = new Map(
    agents.map((a) => [
      a.name,
      a,
    ]),
  );
  const entry = opts?.entry ?? agents[0].name;
  if (!byName.has(entry)) {
    throw new Error(`handoff: entry agent ${JSON.stringify(entry)} is not in the swarm.`);
  }

  const readActive = (ctx: Context<ContextData>): Agent => {
    const active = readSwarmState(ctx).activeAgent ?? entry;
    return byName.get(active) ?? frameworkCast<Agent>(byName.get(entry));
  };

  const transferTools = buildTransferTools(agents);

  return loop<ContextData, string, string>({
    id: `handoff:${agents.map((a) => a.name).join('-')}`,
    steps: [
      step.llm<ContextData, string, string>({
        id: 'handoff:llm',
        // The whole swap is Lazy resolution against the live context: the
        // active agent's identity/tools change per iteration while the
        // conversation history stays in the one shared log.
        model: (ctx) => resolveLazyValue(readActive(ctx).model, ctx),
        instructions: async (ctx) => {
          const active = readActive(ctx);
          const base = await resolveLazyValue(active.instructions, ctx);
          return [
            `You are ${active.name}: ${active.description}`,
            base,
          ]
            .filter(Boolean)
            .join('\n\n');
        },
        tools: (ctx) => {
          const active = readActive(ctx);
          return [
            ...(active.tools ?? []),
            ...(transferTools.get(active.name) ?? []),
          ];
        },
      }),
    ],
    until: opts?.until ?? any(untilNoTransfer, until.maxSteps(DEFAULT_SWARM_MAX_STEPS)),
    // The previous agent's closing text is loop output, not the next agent's
    // input — blank it so it is not re-appended as a user message.
    prepareNext: () => '',
    maxIterations: opts?.maxIterations ?? DEFAULT_SWARM_MAX_ITERATIONS,
  });
}

//#endregion

//#region quorum — panels, advisors, consensus

/** @public How a quorum reduces N candidate answers to one result. */
export type QuorumVote =
  | {
      kind: 'majority';
      /** Normalize before comparing (default: trim + lowercase). */
      normalize?: (answer: string) => string;
    }
  | {
      kind: 'judge';
      /** The agent that scores/picks among candidates. */
      judge: Agent;
      /** Extra guidance appended to the judge prompt. */
      criteria?: string;
    }
  | {
      kind: 'first';
    }
  | {
      kind: 'all';
      /** Join candidates (default: labeled sections). */
      merge?: (answers: ReadonlyArray<QuorumCandidate>) => string;
    };

/** @public Options for a quorum. */
export interface QuorumOptions {
  vote: QuorumVote;
  /** Max agents running concurrently. */
  concurrency?: number;
}

/** @public One panelist's answer, as the vote strategies see it. */
export interface QuorumCandidate {
  agent: string;
  answer: string;
}

/** Instruction block prepended to every judge turn, above the caller's criteria. */
const JUDGE_INSTRUCTIONS =
  'You are judging candidate answers to the same task. Evaluate them and produce the single best final answer (you may synthesize).';

/**
 * Collect the fulfilled paths into candidates.
 *
 * `settle` results are index-ordered against the `paths` array, so position
 * recovers the agent name; `stepId` is the fallback if that ever changes.
 */
function collectCandidates(
  results: ReadonlyArray<SettleResult<string>>,
  agents: ReadonlyArray<Agent>,
): QuorumCandidate[] {
  const candidates: QuorumCandidate[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value !== undefined) {
      candidates.push({
        agent: agents[i]?.name ?? r.stepId,
        answer: typeof r.value === 'string' ? r.value : JSON.stringify(r.value),
      });
    }
  });
  return candidates;
}

/** Tally normalized answers and return the ORIGINAL text of the most common one. */
function majorityAnswer(
  candidates: ReadonlyArray<QuorumCandidate>,
  normalize: (answer: string) => string,
): string {
  const tally = new Map<
    string,
    {
      count: number;
      answer: string;
    }
  >();
  for (const c of candidates) {
    const key = normalize(c.answer);
    const entry = tally.get(key);
    if (entry) {
      entry.count++;
      continue;
    }
    tally.set(key, {
      count: 1,
      answer: c.answer,
    });
  }
  let best:
    | {
        count: number;
        answer: string;
      }
    | undefined;
  for (const entry of tally.values()) {
    if (!best || entry.count > best.count) {
      best = entry;
    }
  }
  return frameworkCast<{
    answer: string;
  }>(best).answer;
}

function reduceCandidates(candidates: ReadonlyArray<QuorumCandidate>, vote: QuorumVote): string {
  switch (vote.kind) {
    case 'first':
      return candidates[0].answer;
    case 'majority':
      return majorityAnswer(candidates, vote.normalize ?? ((a) => a.trim().toLowerCase()));
    case 'all': {
      const merge =
        vote.merge ??
        ((answers: ReadonlyArray<QuorumCandidate>) =>
          answers.map((a) => `## ${a.agent}\n${a.answer}`).join('\n\n'));
      return merge(candidates);
    }
    case 'judge':
      // The judge path reduces in its own LLM step; the fork merge just labels
      // candidates for the judge prompt.
      return candidates.map((a) => `## Candidate from ${a.agent}\n${a.answer}`).join('\n\n');
  }
}

/**
 * Fans a task out to N agents in isolated contexts and reduces their answers
 * with a vote strategy.
 *
 * Panels, advisor boards, and self-consistency are all this shape:
 *
 * ```ts
 * quorum([a, b, c], { vote: { kind: 'majority' } })
 * quorum([a, b, c], { vote: { kind: 'judge', judge: reviewer } })
 * ```
 *
 * Built on `fork('settle')`: one failed agent degrades the panel instead of
 * failing it; if every agent fails, the step throws.
 *
 * @public
 * @param agents - The panel (at least one agent).
 * @param opts.vote - How to reduce the candidates: `majority`, `first`, `all`, or `judge`.
 * @param opts.concurrency - Max agents running simultaneously. Default: unbounded.
 * @returns A `Step` — a settle `fork` for the non-judge votes, a `loop` (fork then judge turn) for `judge`.
 * @throws `Error` if `agents` is empty. The merge throws at execution time if every agent failed.
 */
export function quorum(
  agents: ReadonlyArray<Agent>,
  opts: QuorumOptions,
): Step<ContextData, string, string> {
  if (agents.length === 0) {
    throw new Error('quorum: at least one agent is required.');
  }
  const names = agents.map((a) => a.name).join('-');

  const forkStep = fork<ContextData, string, string>({
    id: `quorum:${names}`,
    mode: 'settle',
    ...(opts.concurrency !== undefined
      ? {
          concurrency: opts.concurrency,
        }
      : {}),
    paths: () => agents.map((a) => isolated(a, 'quorum')),
    merge: (results) => {
      const candidates = collectCandidates(results, agents);
      if (candidates.length === 0) {
        throw new Error(`quorum:${names}: every agent failed.`);
      }
      return reduceCandidates(candidates, opts.vote);
    },
  });

  if (opts.vote.kind !== 'judge') {
    return forkStep;
  }

  // Judge vote: fan out, then one judge turn over the labeled candidates.
  const judge = opts.vote.judge;
  const criteria = opts.vote.criteria;
  return loop<ContextData, string, string>({
    id: `quorum:${names}:judged`,
    steps: [
      forkStep,
      step.llm<ContextData, string, string>({
        id: `quorum:${names}:judge`,
        model: judge.model,
        instructions: async (ctx) => {
          const base = await resolveLazyValue(judge.instructions, ctx);
          return [
            base,
            JUDGE_INSTRUCTIONS,
            criteria ? `Judging criteria: ${criteria}` : undefined,
          ]
            .filter(Boolean)
            .join('\n\n');
        },
        tools: judge.tools,
      }),
    ],
    until: until.maxSteps(1),
    maxIterations: 1,
  });
}

//#endregion

//#region teammate — named background workers

/** @public A running background teammate: addressable, pollable, awaitable. */
export interface Teammate {
  readonly name: string;
  /** Queue a message; delivered when the teammate's loop parks on its inbox. */
  send(message: string): Promise<void>;
  /** Current run status. */
  status(): 'running' | 'completed' | 'failed';
  /** Await the teammate's final result. */
  result(timeout?: number): Promise<string>;
  /** The channel the teammate reports results/notifications on. */
  readonly outbox: Channel<string>;
}

/** Ms the teammate's loop waits on its inbox before parking. */
const TEAMMATE_PARK_TIMEOUT = 50;

/**
 * Launches an agent as a named background teammate.
 *
 * Detached execution on its own thread (nothing pollutes the parent session
 * log), an inbox channel the parent can `send()` follow-ups to, and an outbox
 * carrying its result. This is the "background teammates" shape (coding-agent
 * subagents, a CLI's `/team`) as ~30 lines of composition.
 *
 * A crashing teammate never throws into the parent: the failure arrives on the
 * outbox as `[<name> failed] <message>` and `status()` reports `'failed'`.
 *
 * @public
 * @param agent - The compiled agent to run in the background.
 * @param task - The teammate's initial task.
 * @param toolCtx - A harness + context pair, so this is callable from a tool body or from host code.
 * @returns A `Teammate` handle: `send`, `status`, `result`, and the `outbox` channel.
 */
export function teammate(
  agent: Agent,
  task: string,
  toolCtx: Pick<ToolExecutionContext, 'harness' | 'ctx'>,
): Teammate {
  const inbox = channel<string>(`${agent.name}-inbox-${crypto.randomUUID().slice(0, 8)}`, {
    schema: z.string(),
    mode: 'queue',
  });
  const outbox = channel<string>(`${agent.name}-outbox-${crypto.randomUUID().slice(0, 8)}`, {
    schema: z.string(),
    mode: 'queue',
  });

  // The teammate's loop parks on its inbox when it would otherwise stop, so
  // a parent `send()` wakes it with the new message as a developer item.
  const teammateStep = loop<ContextData, string, string>({
    id: `teammate:${agent.name}`,
    steps: [
      agent.step,
    ],
    until: until.noToolCalls(),
    inbox,
    parkTimeout: TEAMMATE_PARK_TIMEOUT,
  });

  const handle = toolCtx.harness.detachedSpawn(
    spawn<ContextData, string, string>({
      id: `teammate:${agent.name}:spawn`,
      child: teammateStep,
      ...(agent.context
        ? {
            context: agent.context,
          }
        : {}),
    }),
    task,
    toolCtx.ctx,
    {
      threadId: `teammate-${agent.name}-${crypto.randomUUID().slice(0, 8)}`,
    },
  );

  void handle
    .await()
    .then((result) => toolCtx.harness.send(outbox, String(result), toolCtx.ctx))
    .catch((e: unknown) =>
      toolCtx.harness.send(
        outbox,
        `[${agent.name} failed] ${e instanceof Error ? e.message : String(e)}`,
        toolCtx.ctx,
      ),
    );

  return {
    name: agent.name,
    outbox,
    send: (message: string) => toolCtx.harness.send(inbox, message, toolCtx.ctx),
    status: () => handle.status,
    result: (timeout?: number) => handle.await(timeout).then(String),
  };
}

//#endregion
