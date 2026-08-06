/**
 * agent-nodes.ts — the JSON-workflow half of the agent patterns.
 *
 * The `agent-tool` / `handoff` / `quorum` node kinds hydrate into the patterns
 * from `agents.ts`, which means their hydrators need the pattern builders. The
 * hydrator itself lives one layer below (`builders/`) and must not import back
 * up, so these hydrators are contributed to it instead: pass
 * `nodeHydrators: agentNodeHydrators(agents)` on the `HydrationContext` and the
 * three kinds become available at any depth of the document.
 *
 * Agents are NAMED references in JSON. A compiled `Agent` carries closures
 * (Lazy model/instruction getters, tool `execute` bodies), so — exactly like
 * sub-harness adapters — definitions are supplied at hydration time and never
 * embedded in the document.
 */

import type { ContextData } from '@noetic-tools/context';
import type { Step } from '@noetic-tools/types';
import { frameworkCast, NoeticConfigError } from '@noetic-tools/types';
import { step } from '../builders/step-builders';
import type { HydrationContext, NodeHydrator } from '../builders/workflow-hydrator';
import { resolveTools } from '../builders/workflow-hydrator';
import type { WorkflowNode } from '../schemas/workflow';
import type { Agent, QuorumOptions } from './agents';
import { asTool, handoff, quorum } from './agents';

//#region Types

/** @public Compiled agents keyed by the name JSON workflow nodes reference them by. */
export type AgentRegistry = ReadonlyMap<string, Agent>;

//#endregion

//#region Helpers

/** Default orchestrator model when an `agent-tool` node names none. */
const DEFAULT_ORCHESTRATOR_MODEL = 'openai/gpt-4o';

function resolveAgents(names: ReadonlyArray<string>, agents: AgentRegistry): Agent[] {
  return names.map((name) => {
    const resolved = agents.get(name);
    if (!resolved) {
      throw new NoeticConfigError({
        code: 'UNKNOWN_AGENT_REFERENCE',
        message: `Agent '${name}' referenced in workflow is not registered.`,
        hint: `Pass compiled agents via nodeHydrators: agentNodeHydrators(new Map([['${name}', defineAgent({...})]])). Available: ${
          [
            ...agents.keys(),
          ].join(', ') || '(none)'
        }`,
      });
    }
    return resolved;
  });
}

/** Resolve one agent by name (the judge slot of a `quorum` node). */
function resolveAgent(name: string, agents: AgentRegistry): Agent {
  return resolveAgents(
    [
      name,
    ],
    agents,
  )[0];
}

//#endregion

//#region Node Hydrators

function hydrateAgentToolNode(
  node: WorkflowNode,
  ctx: HydrationContext,
  agents: AgentRegistry,
): Step<ContextData, string, string> {
  if (node.kind !== 'agent-tool') {
    return frameworkCast(undefined);
  }
  const agentTools = resolveAgents(node.agents, agents).map((a) => asTool(a));
  const plainTools = resolveTools(node.tools, ctx.tools);
  return step.llm<ContextData, string, string>({
    id: node.id,
    model: node.model ?? DEFAULT_ORCHESTRATOR_MODEL,
    instructions: node.instructions,
    tools: [
      ...plainTools,
      ...agentTools,
    ],
  });
}

function hydrateHandoffNode(
  node: WorkflowNode,
  agents: AgentRegistry,
): Step<ContextData, string, string> {
  if (node.kind !== 'handoff') {
    return frameworkCast(undefined);
  }
  return handoff(resolveAgents(node.agents, agents), {
    ...(node.entry !== undefined
      ? {
          entry: node.entry,
        }
      : {}),
    ...(node.maxIterations !== undefined
      ? {
          maxIterations: node.maxIterations,
        }
      : {}),
  });
}

/** Map a `quorum` node's declared vote onto the pattern's vote union. */
function resolveQuorumVote(
  vote: Extract<
    WorkflowNode,
    {
      kind: 'quorum';
    }
  >['vote'],
  agents: AgentRegistry,
): QuorumOptions['vote'] {
  if (vote.kind !== 'judge') {
    return {
      kind: vote.kind,
    };
  }
  return {
    kind: 'judge',
    judge: resolveAgent(vote.judge, agents),
    ...(vote.criteria !== undefined
      ? {
          criteria: vote.criteria,
        }
      : {}),
  };
}

function hydrateQuorumNode(
  node: WorkflowNode,
  agents: AgentRegistry,
): Step<ContextData, string, string> {
  if (node.kind !== 'quorum') {
    return frameworkCast(undefined);
  }
  return quorum(resolveAgents(node.agents, agents), {
    vote: resolveQuorumVote(node.vote, agents),
    ...(node.concurrency !== undefined
      ? {
          concurrency: node.concurrency,
        }
      : {}),
  });
}

//#endregion

//#region Public API

/**
 * Builds the `nodeHydrators` map that teaches the JSON workflow runtime the
 * three agent node kinds.
 *
 * ```ts
 * const agents = new Map([['researcher', defineAgent({ … })]]);
 * hydrateWorkflow(doc, { tools, executeStep, nodeHydrators: agentNodeHydrators(agents) });
 * ```
 *
 * @public
 * @param agents - Compiled agents keyed by the name the document references.
 * @returns Hydrators for `agent-tool`, `handoff`, and `quorum`, ready to pass as `HydrationContext.nodeHydrators`.
 */
export function agentNodeHydrators(agents: AgentRegistry): ReadonlyMap<string, NodeHydrator> {
  return new Map<string, NodeHydrator>([
    [
      'agent-tool',
      (node, ctx) => hydrateAgentToolNode(node, ctx, agents),
    ],
    [
      'handoff',
      (node) => hydrateHandoffNode(node, agents),
    ],
    [
      'quorum',
      (node) => hydrateQuorumNode(node, agents),
    ],
  ]);
}

//#endregion
