/**
 * AI Provider Tests
 *
 * These tests mock the actual API clients so they run offline without API keys.
 * Integration tests (real API calls) go in tests/ folder.
 */

import { GroqProvider } from '../groq';
import { GeminiProvider } from '../gemini';
import { AIProviderFactory } from '../factory';
import { getProviderConfig, setProviderConfig, setAPIKey, getAPIKey } from '../config';
import { logCost, getTotalCost, getCostByProvider, getMonthlyCost } from '../cost-tracker';

// ── Mock Groq SDK ─────────────────────────────────────────────────────────────
jest.mock('groq-sdk', () => {
  return jest.fn().mockImplementation(() => ({
    models: {
      list: jest.fn().mockResolvedValue({ data: [] }),
    },
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{ message: { content: 'Hello from GROQ' }, finish_reason: 'stop' }],
          model: 'llama-3.3-70b-versatile',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      },
    },
  }));
});

// ── Mock Gemini SDK ──────────────────────────────────────────────────────────
jest.mock('@google/generative-ai', () => {
  const mockChat = {
    sendMessage: jest.fn().mockResolvedValue({
      response: {
        text: () => 'Hello from Gemini',
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    }),
    sendMessageStream: jest.fn().mockReturnValue({
      stream: (async function* () {
        yield { text: () => 'Hello' };
        yield { text: () => ' from Gemini' };
      })(),
    }),
  };

  const mockModel = {
    generateContent: jest.fn().mockResolvedValue({ response: { text: () => 'pong' } }),
    startChat: jest.fn().mockReturnValue(mockChat),
  };

  return {
    GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
      getGenerativeModel: jest.fn().mockReturnValue(mockModel),
    })),
    HarmCategory: {
      HARM_CATEGORY_HARASSMENT: 'HARM_CATEGORY_HARASSMENT',
      HARM_CATEGORY_HATE_SPEECH: 'HARM_CATEGORY_HATE_SPEECH',
      HARM_CATEGORY_SEXUALLY_EXPLICIT: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      HARM_CATEGORY_DANGEROUS_CONTENT: 'HARM_CATEGORY_DANGEROUS_CONTENT',
    },
    HarmBlockThreshold: {
      BLOCK_ONLY_HIGH: 'BLOCK_ONLY_HIGH',
    },
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// GroqProvider
// ─────────────────────────────────────────────────────────────────────────────

describe('GroqProvider', () => {
  let provider: GroqProvider;

  beforeEach(() => {
    provider = new GroqProvider('test-key');
  });

  it('reports as available (mock returns success)', async () => {
    expect(await provider.isAvailable()).toBe(true);
  });

  it('chat() returns content and usage', async () => {
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Say hi' }],
    });

    expect(result.content).toBe('Hello from GROQ');
    expect(result.usage.totalTokens).toBe(15);
    expect(result.cost).toBeGreaterThanOrEqual(0);
    expect(result.model).toBe('llama-3.3-70b-versatile');
  });

  it('chatStream() yields chunks', async () => {
    // Redefine mock to yield streaming chunks
    const Groq = jest.requireMock('groq-sdk') as jest.Mock;
    Groq.mockImplementation(() => ({
      models: { list: jest.fn().mockResolvedValue({}) },
      chat: {
        completions: {
          create: jest.fn().mockReturnValue({
            [Symbol.asyncIterator]: async function* () {
              yield { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] };
              yield { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] };
            },
          }),
        },
      },
    }));

    const streamProvider = new GroqProvider('test-key');
    const chunks: string[] = [];

    for await (const chunk of streamProvider.chatStream({
      messages: [{ role: 'user', content: 'Count to 2' }],
    })) {
      chunks.push(chunk.delta);
    }

    expect(chunks.join('')).toBe('Hello world');
  });

  it('countTokens() returns a positive number', () => {
    expect(provider.countTokens('Hello world, this is a test.')).toBeGreaterThan(0);
  });

  it('handles system prompt by prepending as system message', async () => {
    const Groq = jest.requireMock('groq-sdk') as jest.Mock;
    let capturedMessages: any[] = [];

    Groq.mockImplementation(() => ({
      models: { list: jest.fn().mockResolvedValue({}) },
      chat: {
        completions: {
          create: jest.fn().mockImplementation(async (params: any) => {
            capturedMessages = params.messages;
            return {
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              model: 'llama-3.3-70b-versatile',
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            };
          }),
        },
      },
    }));

    const p = new GroqProvider('test-key');
    await p.chat({
      system: 'Be concise.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[0].content).toBe('Be concise.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GeminiProvider
// ─────────────────────────────────────────────────────────────────────────────

describe('GeminiProvider', () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    provider = new GeminiProvider('test-key');
  });

  it('reports as available (mock returns success)', async () => {
    expect(await provider.isAvailable()).toBe(true);
  });

  it('chat() returns content and usage', async () => {
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'Say hi' }],
    });

    expect(result.content).toBe('Hello from Gemini');
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
    expect(result.cost).toBeGreaterThanOrEqual(0);
  });

  it('chatStream() yields chunks and accumulates', async () => {
    const chunks: string[] = [];
    let lastAccumulated = '';

    for await (const chunk of provider.chatStream({
      messages: [{ role: 'user', content: 'Greet me' }],
    })) {
      if (chunk.delta) chunks.push(chunk.delta);
      lastAccumulated = chunk.accumulated;
    }

    expect(chunks).toContain('Hello');
    expect(lastAccumulated).toContain('Hello');
  });

  it('throws if last message is not from user', async () => {
    await expect(
      provider.chat({
        messages: [{ role: 'assistant', content: 'I said something' }],
      })
    ).rejects.toThrow('last message must be from user');
  });

  it('countTokens() returns a positive number', () => {
    expect(provider.countTokens('A longer test sentence for token counting.')).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config (getProviderConfig / setProviderConfig / API keys)
// ─────────────────────────────────────────────────────────────────────────────

describe('Config', () => {
  it('returns default config when nothing is stored', async () => {
    const config = await getProviderConfig();
    expect(config.provider).toBe('gemini');
    expect(config.trackCost).toBe(true);
  });

  it('persists and reads back config changes', async () => {
    await setProviderConfig({ provider: 'groq' });
    const config = await getProviderConfig();
    expect(config.provider).toBe('groq');
  });

  it('merges partial config updates', async () => {
    await setProviderConfig({ provider: 'groq', trackCost: true });
    await setProviderConfig({ defaultModel: 'llama-3.1-8b-instant' });

    const config = await getProviderConfig();
    expect(config.provider).toBe('groq');
    expect(config.defaultModel).toBe('llama-3.1-8b-instant');
    expect(config.trackCost).toBe(true);
  });

  it('stores and retrieves API key (roundtrip)', async () => {
    await setAPIKey('groq', 'gsk_test_key_123');
    const retrieved = await getAPIKey('groq');
    expect(retrieved).toBe('gsk_test_key_123');
  });

  it('returns undefined when no key is stored', async () => {
    const key = await getAPIKey('gemini');
    expect(key).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cost Tracker
// ─────────────────────────────────────────────────────────────────────────────

describe('Cost Tracker', () => {
  it('logs a cost entry and returns total', async () => {
    await logCost({
      provider: 'groq',
      operation: 'essay_generate',
      model: 'llama-3.3-70b-versatile',
      promptTokens: 1000,
      completionTokens: 500,
      cost: 0.001,
    });

    const total = await getTotalCost();
    expect(total).toBeCloseTo(0.001);
  });

  it('aggregates cost by provider', async () => {
    await logCost({ provider: 'groq', operation: 'resume_parse', model: 'llama-3.3-70b-versatile', promptTokens: 100, completionTokens: 50, cost: 0.0005 });
    await logCost({ provider: 'gemini', operation: 'key_suggest', model: 'gemini-2.0-flash', promptTokens: 50, completionTokens: 20, cost: 0.0002 });

    const byProvider = await getCostByProvider();
    expect(byProvider.groq).toBeCloseTo(0.0005);
    expect(byProvider.gemini).toBeCloseTo(0.0002);
  });

  it('getMonthlyCost() only includes this month entries', async () => {
    // Past entry (Jan 2020)
    await logCost({ provider: 'groq', operation: 'key_suggest', model: 'llama-3.3-70b-versatile', promptTokens: 100, completionTokens: 50, cost: 99.99 });
    // Modify timestamp of the past entry
    const result = await chrome.storage.local.get('ai_cost_log_v1');
    const log = result['ai_cost_log_v1'] as any[];
    log[0].timestamp = new Date('2020-01-15').getTime();
    await chrome.storage.local.set({ ai_cost_log_v1: log });

    // Current entry
    await logCost({ provider: 'gemini', operation: 'essay_generate', model: 'gemini-2.0-flash', promptTokens: 50, completionTokens: 20, cost: 0.01 });

    const monthly = await getMonthlyCost();
    expect(monthly).toBeCloseTo(0.01);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AIProviderFactory
// ─────────────────────────────────────────────────────────────────────────────

describe('AIProviderFactory', () => {
  beforeEach(() => {
    AIProviderFactory.refresh();
  });

  it('creates a GroqProvider when provider=groq with env key', async () => {
    await setProviderConfig({ provider: 'groq' });
    // No key in storage — falls back to import.meta.env (mocked in setup.ts)
    // Factory reads import.meta.env.VITE_GROQ_API_KEY
    const provider = await AIProviderFactory.getProvider();
    expect(provider.name).toBe('groq');
  });

  it('creates a GeminiProvider after switching config', async () => {
    await setAPIKey('gemini', 'test-gemini-key');
    await setProviderConfig({ provider: 'gemini' });
    AIProviderFactory.refresh();

    const provider = await AIProviderFactory.getProvider();
    expect(provider.name).toBe('gemini');
  });

  it('refresh() forces re-creation on next call', async () => {
    await setProviderConfig({ provider: 'groq' });
    const p1 = await AIProviderFactory.getProvider();

    AIProviderFactory.refresh();
    await setAPIKey('gemini', 'test-gemini-key');
    await setProviderConfig({ provider: 'gemini' });

    const p2 = await AIProviderFactory.getProvider();
    expect(p1.name).toBe('groq');
    expect(p2.name).toBe('gemini');
  });
});
