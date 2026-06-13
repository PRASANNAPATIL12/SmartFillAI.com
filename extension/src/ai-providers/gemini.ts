import {
  GoogleGenerativeAI,
  type GenerativeModel,
  type Content,
  HarmCategory,
  HarmBlockThreshold,
} from '@google/generative-ai';
import type { IAIProvider, ChatParams, ChatResponse, ChatChunk } from './types';

// Pricing per 1M tokens (June 2026)
// Gemini 1.5 Flash is free up to generous limits; Pro is paid.
const GEMINI_PRICING: Record<string, { input: number; output: number }> = {
  'gemini-1.5-flash':      { input: 0.075, output: 0.30 },
  'gemini-1.5-flash-8b':   { input: 0.0375, output: 0.15 },
  'gemini-1.5-pro':        { input: 3.50, output: 10.50 },
  'gemini-2.0-flash':      { input: 0.10,  output: 0.40 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.30 },
};

export const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash';

// Safety settings — keep permissive for professional content
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
];

export class GeminiProvider implements IAIProvider {
  readonly name = 'gemini' as const;
  readonly displayName = 'Google Gemini';

  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const model = this.getModel(GEMINI_DEFAULT_MODEL);
      await model.generateContent('ping');
      return true;
    } catch {
      return false;
    }
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const modelName = params.model ?? GEMINI_DEFAULT_MODEL;
    const model = this.getModel(modelName, params);

    const { history, lastUserMessage } = this.buildHistory(params);

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(lastUserMessage);
    const response = result.response;

    const content = response.text();
    const usage = response.usageMetadata;

    const promptTokens = usage?.promptTokenCount ?? this.countTokens(lastUserMessage);
    const completionTokens = usage?.candidatesTokenCount ?? this.countTokens(content);

    return {
      content,
      model: modelName,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      cost: this.calcCost(modelName, promptTokens, completionTokens),
    };
  }

  async *chatStream(params: ChatParams): AsyncIterableIterator<ChatChunk> {
    const modelName = params.model ?? GEMINI_DEFAULT_MODEL;
    const model = this.getModel(modelName, params);

    const { history, lastUserMessage } = this.buildHistory(params);

    const chat = model.startChat({ history });
    const result = await chat.sendMessageStream(lastUserMessage);

    let accumulated = '';
    for await (const chunk of result.stream) {
      const delta = chunk.text();
      accumulated += delta;
      yield { delta, done: false, accumulated };
    }

    yield { delta: '', done: true, accumulated };
  }

  countTokens(text: string): number {
    // ~4 chars per token
    return Math.ceil(text.length / 4);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private getModel(modelName: string, params?: ChatParams): GenerativeModel {
    const config: Parameters<GoogleGenerativeAI['getGenerativeModel']>[0] = {
      model: modelName,
      safetySettings: SAFETY_SETTINGS,
      generationConfig: {
        temperature: params?.temperature ?? 0.7,
        maxOutputTokens: params?.maxTokens ?? 2048,
        stopSequences: params?.stop,
        responseMimeType:
          params?.responseFormat === 'json_object' ? 'application/json' : 'text/plain',
      },
    };

    // System instruction goes into the model config for Gemini
    if (params?.system) {
      config.systemInstruction = params.system;
    }

    return this.genAI.getGenerativeModel(config);
  }

  /**
   * Gemini uses a "history" array + a final user message.
   * We extract the last user message and convert the rest to history.
   */
  private buildHistory(params: ChatParams): { history: Content[]; lastUserMessage: string } {
    const messages = params.messages.filter(m => m.role !== 'system');

    if (messages.length === 0) {
      throw new Error('GeminiProvider: at least one user message required');
    }

    // Last message must be from the user
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== 'user') {
      throw new Error('GeminiProvider: last message must be from user');
    }

    const history: Content[] = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    return {
      history,
      lastUserMessage: lastMsg.content,
    };
  }

  private calcCost(model: string, promptTok: number, completionTok: number): number {
    const rates = GEMINI_PRICING[model] ?? GEMINI_PRICING[GEMINI_DEFAULT_MODEL];
    return (promptTok / 1_000_000) * rates.input + (completionTok / 1_000_000) * rates.output;
  }
}
