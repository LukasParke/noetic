import { describe, expect, it } from 'bun:test';
import type { LLMResponse } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { makeMessage } from '../_helpers';

interface MockModelResponse {
  id: string;
  status: string;
  output: unknown[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** Records the `tools` array handed to the SDK on each call. */
class ToolRecordingClient {
  readonly toolBatches: unknown[][] = [];

  callModel(request: { tools?: unknown[] }): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<MockModelResponse>;
  } {
    this.toolBatches.push(request.tools ?? []);
    return {
      async *getFullResponsesStream() {},
      getResponse: async () =>
        frameworkCast<MockModelResponse>({
          id: `resp-${this.toolBatches.length}`,
          status: 'completed',
          output: [
            {
              id: 'm1',
              status: 'completed',
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'done',
                },
              ],
            },
          ],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
          },
        }),
    };
  }
}

describe('per-Tool SDK conversion cache', () => {
  const echoTool = tool({
    name: 'echo',
    description: 'Echo a message',
    input: z.object({
      message: z.string(),
    }),
    output: z.string(),
    execute: async (args) => args.message,
  });

  async function callOnce(harness: AgentHarness): Promise<LLMResponse> {
    return harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'go'),
      ],
      tools: [
        echoTool,
      ],
      ctx: harness.createContext(),
    });
  }

  it('hands the SDK the identical converted definition object across calls', async () => {
    const client = new ToolRecordingClient();
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    frameworkCast<{
      client: ToolRecordingClient;
    }>(harness).client = client;

    await callOnce(harness);
    await callOnce(harness);

    expect(client.toolBatches.length).toBe(2);
    const [first, second] = client.toolBatches;
    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    // Same Tool instance ⇒ same cached SDK definition, not a re-serialization.
    // Byte-stable tools segment is what provider prompt caches match on.
    expect(second[0]).toBe(first[0]);
  });

  it('is keyed per Tool instance, so a distinct tool converts separately', async () => {
    const other = tool({
      name: 'other',
      description: 'A different tool',
      input: z.object({
        n: z.number(),
      }),
      output: z.string(),
      execute: async () => 'ok',
    });
    const client = new ToolRecordingClient();
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    frameworkCast<{
      client: ToolRecordingClient;
    }>(harness).client = client;

    await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'go'),
      ],
      tools: [
        echoTool,
        other,
      ],
      ctx: harness.createContext(),
    });

    const batch = client.toolBatches[0];
    expect(batch.length).toBe(2);
    expect(batch[0]).not.toBe(batch[1]);
  });

  it('preserves the caller-supplied tool order on a partial cache hit', async () => {
    // `echoTool` is already cached by the suite above; `fresh` is a miss. The
    // rebuild path must still emit them in the order the caller passed.
    const fresh = tool({
      name: 'fresh',
      description: 'Never converted before',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
    });
    const client = new ToolRecordingClient();
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    frameworkCast<{
      client: ToolRecordingClient;
    }>(harness).client = client;

    await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'go'),
      ],
      tools: [
        fresh,
        echoTool,
      ],
      ctx: harness.createContext(),
    });

    const names = client.toolBatches[0].map(
      (t) =>
        frameworkCast<{
          function: {
            name: string;
          };
        }>(t).function.name,
    );
    expect(names).toEqual([
      'fresh',
      'echo',
    ]);
  });
});
