import { logger } from '../../core/logger.js';

export interface OpenRouterTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface OpenRouterToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface OpenRouterResult {
  message: OpenRouterMessage;
  toolCalls: OpenRouterToolCall[];
  finishReason: string | null;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const WRITE_CODE_DOC_TOOL: OpenRouterTool = {
  type: 'function',
  function: {
    name: 'write_code_doc',
    description:
      'Commit repo-scoped documentation describing what this code does. Do not restate platform spec.',
    parameters: {
      type: 'object',
      properties: {
        codeDoc: {
          type: 'string',
          description: 'Plain-language explanation of what this code does in the repository.',
        },
      },
      required: ['codeDoc'],
    },
  },
};

export const RESOLVE_SPEC_LINKS_TOOL: OpenRouterTool = {
  type: 'function',
  function: {
    name: 'resolve_spec_links',
    description:
      'Search the read-only platform spec index for canonical pages related to this code.',
    parameters: {
      type: 'object',
      properties: {
        searchTerms: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords to search the platform spec link index.',
        },
      },
      required: ['searchTerms'],
    },
  },
};

export const isOpenRouterConfigured = (): boolean =>
  !!process.env.OPENROUTER_API_KEY?.trim();

export const resolveDocModel = (): string =>
  process.env.NEXUS_DOC_MODEL?.trim() || 'openrouter/free';

export const callOpenRouter = async (
  messages: OpenRouterMessage[],
  tools?: OpenRouterTool[],
): Promise<OpenRouterResult> => {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const body: Record<string, unknown> = {
    model: resolveDocModel(),
    messages,
  };
  if (tools?.length) body.tools = tools;

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://nexus.beskid-lang.org',
      'X-Title': 'Beskid Nexus',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown error');
    throw new Error(`OpenRouter error (${response.status}): ${text.slice(0, 500)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string;
      message?: OpenRouterMessage;
    }>;
  };

  const choice = payload.choices?.[0];
  const message = choice?.message ?? { role: 'assistant' as const, content: '' };
  const toolCalls: OpenRouterToolCall[] = [];

  for (const call of message.tool_calls ?? []) {
    if (call.type !== 'function') continue;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch (err) {
      logger.warn({ err, tool: call.function.name }, 'Failed to parse OpenRouter tool args');
    }
    toolCalls.push({ id: call.id, name: call.function.name, arguments: args });
  }

  return {
    message,
    toolCalls,
    finishReason: choice?.finish_reason ?? null,
  };
};
