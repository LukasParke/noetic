import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { executeToolCall } from '../../src/adapters/openrouter';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';

function makeHarness(): AgentHarness {
  return new AgentHarness({
    name: 'test',
    params: {},
  });
}

const echoTool = tool({
  name: 'echo',
  description: 'Echo a message n times',
  input: z.object({
    message: z.string(),
    times: z.number().int().min(1),
  }),
  output: z.string(),
  execute: async (args) => args.message.repeat(args.times),
});

describe('executeToolCall argument validation', () => {
  it('validates model-provided args against the Zod input schema (T1)', async () => {
    const harness = makeHarness();
    const ctx = harness.createContext();
    const result = await executeToolCall({
      toolName: 'echo',
      args: {
        message: 'hi',
        times: 'three', // wrong type — must be rejected BEFORE execute runs
      },
      tools: [
        echoTool,
      ],
      context: ctx,
      harness,
    });
    expect(result.error).toBe(true);
    expect(result.output).toContain('invalid arguments');
    expect(result.output).toContain('times');
  });

  it('reports the failing path for a nested argument', async () => {
    const nestedTool = tool({
      name: 'search',
      description: 'Paginated search',
      input: z.object({
        filter: z.object({
          page: z.number(),
        }),
      }),
      output: z.string(),
      execute: async () => 'ok',
    });
    const harness = makeHarness();
    const ctx = harness.createContext();
    const result = await executeToolCall({
      toolName: 'search',
      args: {
        filter: {
          page: 'first',
        },
      },
      tools: [
        nestedTool,
      ],
      context: ctx,
      harness,
    });
    expect(result.error).toBe(true);
    expect(result.output).toContain('filter.page');
  });

  it('passes coerced/validated args through to execute', async () => {
    const harness = makeHarness();
    const ctx = harness.createContext();
    const result = await executeToolCall({
      toolName: 'echo',
      args: {
        message: 'ab',
        times: 2,
      },
      tools: [
        echoTool,
      ],
      context: ctx,
      harness,
    });
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('abab');
  });

  it('uses a pre-resolved tool without re-scanning (T3)', async () => {
    const harness = makeHarness();
    const ctx = harness.createContext();
    const result = await executeToolCall({
      toolName: 'echo',
      args: {
        message: 'x',
        times: 1,
      },
      tools: [], // deliberately empty — resolution must come from resolvedTool
      resolvedTool: echoTool,
      context: ctx,
      harness,
    });
    expect(result.output).toBe('x');
  });

  it('still validates args when the tool arrives pre-resolved', async () => {
    const harness = makeHarness();
    const ctx = harness.createContext();
    const result = await executeToolCall({
      toolName: 'echo',
      args: {
        message: 'x',
        times: 0, // violates .min(1)
      },
      tools: [],
      resolvedTool: echoTool,
      context: ctx,
      harness,
    });
    expect(result.error).toBe(true);
    expect(result.output).toContain('invalid arguments');
  });
});
