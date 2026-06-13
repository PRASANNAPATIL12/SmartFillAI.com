import Groq from 'groq-sdk';
import type { IAIProvider, ChatParams, ChatResponse, ChatChunk } from './types';

// Pricing per 1M tokens (June 2026)
const GROQ_PRICING: Record<string, { input: number; output: number }> = {
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant':    { input: 0.05, output: 0.08 },
  'mixtral-8x7b-32768':      { input: 0.24, output: 0.24 },
  'gemma2-9b-it':            { input: 0.20, output: 0.20 },
};

export const GROQ_DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export class GroqProvider implements IAIProvider {
  readonly name = 'groq' as const;
  readonly displayName = 'GROQ (Llama 3.3)';

  private client: Groq;

  constructor(apiKey: string) {
    this.client = new Groq({
      apiKey,
      dangerouslyAllowBrowser: true,
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const model = params.model ?? GROQ_DEFAULT_MODEL;

    const response = await this.client.chat.completions.create({
      model,
      messages: this.buildMessages(params),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      stop: params.stop,
      response_format:
        params.responseFormat === 'json_object'
          ? { type: 'json_object' }
          : undefined,
    });

    const content = response.choices[0]?.message?.content ?? '';
    const usage = response.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return {
      content,
      model: response.model,
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      },
      cost: this.calcCost(model, usage.prompt_tokens, usage.completion_tokens),
    };
  }

  async *chatStream(params: ChatParams): AsyncIterableIterator<ChatChunk> {
    const model = params.model ?? GROQ_DEFAULT_MODEL;

    const stream = await this.client.chat.completions.create({
      model,
      messages: this.buildMessages(params),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      stream: true,
    });

    let accumulated = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      accumulated += delta;
      const done = chunk.choices[0]?.finish_reason != null;
      yield { delta, done, accumulated };
    }
  }

  countTokens(text: string): number {
    // ~4 chars per token for English
    return Math.ceil(text.length / 4);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private buildMessages(params: ChatParams): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const msgs: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    if (params.system) {
      msgs.push({ role: 'system', content: params.system });
    }

    for (const m of params.messages) {
      if (m.role === 'system') {
        msgs.push({ role: 'system', content: m.content });
      } else if (m.role === 'user') {
        msgs.push({ role: 'user', content: m.content });
      } else {
        msgs.push({ role: 'assistant', content: m.content });
      }
    }

    return msgs;
  }

  private calcCost(model: string, promptTok: number, completionTok: number): number {
    const rates = GROQ_PRICING[model] ?? GROQ_PRICING[GROQ_DEFAULT_MODEL];
    return (promptTok / 1_000_000) * rates.input + (completionTok / 1_000_000) * rates.output;
  }
}
