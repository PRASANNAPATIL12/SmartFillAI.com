# AI Provider Abstraction Layer Specification

## Overview
This module provides a **provider-agnostic interface** for AI calls. The entire extension uses this abstraction, never calling AI APIs directly. This allows switching between GROQ, OpenAI, Anthropic, local models, or any future provider with **zero business logic changes**.

---

## Design Principles

1. **Interface-first:** All providers implement `IAIProvider`
2. **Config-driven:** Switch providers via one config change
3. **Fallback support:** Primary provider down? Use fallback automatically
4. **Type-safe:** Full TypeScript support for request/response
5. **Error handling:** Unified error types across providers
6. **Cost tracking:** Log token usage per provider

---

## Core Interface

### `IAIProvider`

Location: `extension/src/ai-providers/types.ts`

```typescript
/**
 * Provider-agnostic AI interface
 * All AI providers must implement this
 */
export interface IAIProvider {
  /** Provider name (e.g., 'groq', 'openai', 'anthropic') */
  name: string;

  /** Provider display name for UI */
  displayName: string;

  /** Is this provider available? (checks API key, network, etc.) */
  isAvailable(): Promise<boolean>;

  /**
   * Non-streaming chat completion
   * Used for: resume parsing, field classification, key suggestions
   */
  chat(params: ChatParams): Promise<ChatResponse>;

  /**
   * Streaming chat completion
   * Used for: essay generation (user sees words appear live)
   */
  chatStream(params: ChatParams): AsyncIterableIterator<ChatChunk>;

  /**
   * Generate embeddings for text
   * OPTIONAL: Most providers don't need this (we use local MiniLM)
   * Only implement if provider has better/faster embeddings
   */
  embed?(text: string | string[]): Promise<EmbedResponse>;

  /**
   * Get token count for text (for cost estimation)
   */
  countTokens(text: string): number;
}
```

---

## Shared Types

```typescript
// extension/src/ai-providers/types.ts

export interface ChatParams {
  /** System prompt (optional, some providers don't support it) */
  system?: string;

  /** User messages */
  messages: ChatMessage[];

  /** Model name (provider-specific, e.g., 'llama-3.3-70b-versatile' for GROQ) */
  model?: string;

  /** Temperature (0-2, default 0.7) */
  temperature?: number;

  /** Max tokens to generate */
  maxTokens?: number;

  /** Stop sequences */
  stop?: string[];

  /** JSON mode (force structured output) */
  responseFormat?: 'text' | 'json_object';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  /** Generated text */
  content: string;

  /** Model used */
  model: string;

  /** Token usage */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  /** Cost in USD (calculated based on provider pricing) */
  cost: number;

  /** Raw provider response (for debugging) */
  raw?: any;
}

export interface ChatChunk {
  /** Incremental text (word or phrase) */
  delta: string;

  /** Is this the final chunk? */
  done: boolean;

  /** Accumulated text so far */
  accumulated?: string;
}

export interface EmbedResponse {
  /** Embedding vector(s) */
  embeddings: number[][];

  /** Model used */
  model: string;

  /** Token usage */
  usage: {
    totalTokens: number;
  };
}

export type AIProviderName = 'groq' | 'openai' | 'anthropic' | 'local' | 'custom';

export interface ProviderConfig {
  /** Which provider to use */
  provider: AIProviderName;

  /** API key (encrypted in chrome.storage) */
  apiKey?: string;

  /** Base URL (for custom providers or local models) */
  baseUrl?: string;

  /** Default model */
  defaultModel?: string;

  /** Fallback provider if primary fails */
  fallbackProvider?: AIProviderName;

  /** Enable cost tracking? */
  trackCost?: boolean;
}
```

---

## Provider Implementations

### 1. GroqProvider (Default)

Location: `extension/src/ai-providers/groq.ts`

**Why GROQ:**
- Fastest inference (low latency for UX)
- Competitive pricing
- Llama 3.3 70B available
- Simple REST API

**Implementation:**
```typescript
import Groq from 'groq-sdk';
import { IAIProvider, ChatParams, ChatResponse, ChatChunk } from './types';

export class GroqProvider implements IAIProvider {
  name = 'groq';
  displayName = 'GROQ (Llama 3.3)';
  
  private client: Groq;
  private defaultModel = 'llama-3.3-70b-versatile';

  constructor(apiKey: string) {
    this.client = new Groq({ apiKey, dangerouslyAllowBrowser: true });
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Quick health check: list models
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: params.model || this.defaultModel,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      stop: params.stop,
      response_format: params.responseFormat === 'json_object' 
        ? { type: 'json_object' } 
        : undefined,
    });

    const content = response.choices[0]?.message?.content || '';
    const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return {
      content,
      model: response.model,
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      },
      cost: this.calculateCost(usage.prompt_tokens, usage.completion_tokens),
      raw: response,
    };
  }

  async *chatStream(params: ChatParams): AsyncIterableIterator<ChatChunk> {
    const stream = await this.client.chat.completions.create({
      model: params.model || this.defaultModel,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      stream: true,
    });

    let accumulated = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      accumulated += delta;

      yield {
        delta,
        done: chunk.choices[0]?.finish_reason !== null,
        accumulated,
      };
    }
  }

  countTokens(text: string): number {
    // Rough estimate: ~4 chars per token for English
    return Math.ceil(text.length / 4);
  }

  private calculateCost(promptTokens: number, completionTokens: number): number {
    // GROQ pricing (as of June 2026): $0.50/1M input, $0.80/1M output for Llama 3.3 70B
    const inputCost = (promptTokens / 1_000_000) * 0.50;
    const outputCost = (completionTokens / 1_000_000) * 0.80;
    return inputCost + outputCost;
  }
}
```

---

### 2. OpenAIProvider

Location: `extension/src/ai-providers/openai.ts`

**Why OpenAI:**
- GPT-4 for complex reasoning
- Most mature API
- Widely supported

**Implementation:**
```typescript
import OpenAI from 'openai';
import { IAIProvider, ChatParams, ChatResponse, ChatChunk } from './types';

export class OpenAIProvider implements IAIProvider {
  name = 'openai';
  displayName = 'OpenAI (GPT-4)';
  
  private client: OpenAI;
  private defaultModel = 'gpt-4o-mini'; // Cheaper, faster for most tasks

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
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
    const response = await this.client.chat.completions.create({
      model: params.model || this.defaultModel,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      stop: params.stop,
      response_format: params.responseFormat === 'json_object'
        ? { type: 'json_object' }
        : undefined,
    });

    const content = response.choices[0]?.message?.content || '';
    const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    return {
      content,
      model: response.model,
      usage: {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      },
      cost: this.calculateCost(response.model, usage.prompt_tokens, usage.completion_tokens),
      raw: response,
    };
  }

  async *chatStream(params: ChatParams): AsyncIterableIterator<ChatChunk> {
    const stream = await this.client.chat.completions.create({
      model: params.model || this.defaultModel,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      stream: true,
    });

    let accumulated = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      accumulated += delta;

      yield {
        delta,
        done: chunk.choices[0]?.finish_reason !== null,
        accumulated,
      };
    }
  }

  countTokens(text: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(text.length / 4);
  }

  private calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    // OpenAI pricing (as of June 2026)
    const pricing: Record<string, { input: number; output: number }> = {
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
    };

    const rates = pricing[model] || pricing['gpt-4o-mini'];
    const inputCost = (promptTokens / 1_000_000) * rates.input;
    const outputCost = (completionTokens / 1_000_000) * rates.output;
    return inputCost + outputCost;
  }
}
```

---

### 3. AnthropicProvider

Location: `extension/src/ai-providers/anthropic.ts`

**Why Anthropic:**
- Claude for best reasoning quality
- Long context windows
- Haiku for fast/cheap classification

**Implementation:**
```typescript
import Anthropic from '@anthropic-ai/sdk';
import { IAIProvider, ChatParams, ChatResponse, ChatChunk } from './types';

export class AnthropicProvider implements IAIProvider {
  name = 'anthropic';
  displayName = 'Anthropic (Claude)';
  
  private client: Anthropic;
  private defaultModel = 'claude-3-5-haiku-20241022'; // Fast & cheap

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  }

  async isAvailable(): Promise<boolean> {
    try {
      // No models.list() in Anthropic SDK, just try a minimal request
      await this.client.messages.create({
        model: this.defaultModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const response = await this.client.messages.create({
      model: params.model || this.defaultModel,
      system: params.system,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
      stop_sequences: params.stop,
    });

    const content = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const usage = response.usage;

    return {
      content,
      model: response.model,
      usage: {
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
        totalTokens: usage.input_tokens + usage.output_tokens,
      },
      cost: this.calculateCost(response.model, usage.input_tokens, usage.output_tokens),
      raw: response,
    };
  }

  async *chatStream(params: ChatParams): AsyncIterableIterator<ChatChunk> {
    const stream = await this.client.messages.stream({
      model: params.model || this.defaultModel,
      system: params.system,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
    });

    let accumulated = '';
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        const delta = chunk.delta.text;
        accumulated += delta;

        yield {
          delta,
          done: false,
          accumulated,
        };
      }
    }

    yield { delta: '', done: true, accumulated };
  }

  countTokens(text: string): number {
    // Anthropic's rough estimate: ~4 chars per token
    return Math.ceil(text.length / 4);
  }

  private calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    // Anthropic pricing (as of June 2026)
    const pricing: Record<string, { input: number; output: number }> = {
      'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
      'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00 },
      'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
    };

    const rates = pricing[model] || pricing['claude-3-5-haiku-20241022'];
    const inputCost = (promptTokens / 1_000_000) * rates.input;
    const outputCost = (completionTokens / 1_000_000) * rates.output;
    return inputCost + outputCost;
  }
}
```

---

### 4. LocalProvider (Ollama, LM Studio, etc.)

Location: `extension/src/ai-providers/local.ts`

**Why Local:**
- Privacy-first (no data leaves device)
- No API costs
- Offline support
- Slow inference (GPU required)

**Implementation:**
```typescript
import { IAIProvider, ChatParams, ChatResponse, ChatChunk } from './types';

export class LocalProvider implements IAIProvider {
  name = 'local';
  displayName = 'Local Model (Ollama)';
  
  private baseUrl: string;
  private defaultModel = 'llama3.2'; // Ollama model name

  constructor(baseUrl = 'http://localhost:11434') {
    this.baseUrl = baseUrl;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model || this.defaultModel,
        messages: params.messages,
        stream: false,
        options: {
          temperature: params.temperature ?? 0.7,
          num_predict: params.maxTokens ?? 2048,
        },
      }),
    });

    const data = await response.json();
    const content = data.message?.content || '';

    return {
      content,
      model: data.model,
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
      cost: 0, // Local = free
      raw: data,
    };
  }

  async *chatStream(params: ChatParams): AsyncIterableIterator<ChatChunk> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model || this.defaultModel,
        messages: params.messages,
        stream: true,
        options: {
          temperature: params.temperature ?? 0.7,
          num_predict: params.maxTokens ?? 2048,
        },
      }),
    });

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';

    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          const delta = data.message?.content || '';
          accumulated += delta;

          yield {
            delta,
            done: data.done || false,
            accumulated,
          };
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
```

---

## Provider Factory

Location: `extension/src/ai-providers/factory.ts`

**Purpose:** Single source of truth for creating providers.

```typescript
import { IAIProvider, ProviderConfig, AIProviderName } from './types';
import { GroqProvider } from './groq';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { LocalProvider } from './local';
import { getProviderConfig } from './config';

export class AIProviderFactory {
  private static instance: AIProvider | null = null;

  /**
   * Get the configured AI provider (singleton)
   * Reads from chrome.storage, creates provider instance
   */
  static async getProvider(): Promise<IAIProvider> {
    if (this.instance) {
      // Check if provider is still available
      const available = await this.instance.isAvailable();
      if (available) return this.instance;
    }

    // Create new provider instance
    const config = await getProviderConfig();
    this.instance = this.createProvider(config);
    return this.instance;
  }

  /**
   * Create provider instance from config
   */
  private static createProvider(config: ProviderConfig): IAIProvider {
    switch (config.provider) {
      case 'groq':
        if (!config.apiKey) throw new Error('GROQ API key required');
        return new GroqProvider(config.apiKey);

      case 'openai':
        if (!config.apiKey) throw new Error('OpenAI API key required');
        return new OpenAIProvider(config.apiKey);

      case 'anthropic':
        if (!config.apiKey) throw new Error('Anthropic API key required');
        return new AnthropicProvider(config.apiKey);

      case 'local':
        return new LocalProvider(config.baseUrl);

      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  /**
   * Force refresh provider (e.g., after config change)
   */
  static refresh(): void {
    this.instance = null;
  }
}
```

---

## Configuration Management

Location: `extension/src/ai-providers/config.ts`

```typescript
import { ProviderConfig, AIProviderName } from './types';

const CONFIG_KEY = 'ai_provider_config_v1';
const DEFAULT_CONFIG: ProviderConfig = {
  provider: 'groq',
  defaultModel: 'llama-3.3-70b-versatile',
  fallbackProvider: 'openai',
  trackCost: true,
};

/**
 * Get current AI provider configuration
 */
export async function getProviderConfig(): Promise<ProviderConfig> {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  return result[CONFIG_KEY] || DEFAULT_CONFIG;
}

/**
 * Update AI provider configuration
 */
export async function setProviderConfig(config: Partial<ProviderConfig>): Promise<void> {
  const current = await getProviderConfig();
  const updated = { ...current, ...config };
  await chrome.storage.local.set({ [CONFIG_KEY]: updated });
}

/**
 * Get API key for a provider (decrypted)
 */
export async function getAPIKey(provider: AIProviderName): Promise<string | undefined> {
  const key = `ai_api_key_${provider}`;
  const result = await chrome.storage.local.get(key);
  
  if (!result[key]) return undefined;

  // Decrypt (basic XOR with runtime ID)
  return decryptKey(result[key]);
}

/**
 * Set API key for a provider (encrypted)
 */
export async function setAPIKey(provider: AIProviderName, apiKey: string): Promise<void> {
  const key = `ai_api_key_${provider}`;
  const encrypted = encryptKey(apiKey);
  await chrome.storage.local.set({ [key]: encrypted });
}

function encryptKey(key: string): string {
  // Simple XOR encryption with chrome.runtime.id
  const runtimeId = chrome.runtime.id;
  return btoa(
    key.split('').map((char, i) => 
      String.fromCharCode(char.charCodeAt(0) ^ runtimeId.charCodeAt(i % runtimeId.length))
    ).join('')
  );
}

function decryptKey(encrypted: string): string {
  const runtimeId = chrome.runtime.id;
  return atob(encrypted)
    .split('')
    .map((char, i) => 
      String.fromCharCode(char.charCodeAt(0) ^ runtimeId.charCodeAt(i % runtimeId.length))
    )
    .join('');
}
```

---

## Usage Examples

### Resume Parsing

```typescript
import { AIProviderFactory } from './ai-providers/factory';

async function parseResume(resumeText: string) {
  const provider = await AIProviderFactory.getProvider();
  
  const response = await provider.chat({
    system: 'Extract structured profile data from this resume as JSON.',
    messages: [
      {
        role: 'user',
        content: `Resume:\n\n${resumeText}\n\nExtract: name, email, phone, education, work_experience, skills.`,
      },
    ],
    responseFormat: 'json_object',
    maxTokens: 2048,
  });

  return JSON.parse(response.content);
}
```

### Essay Generation (Streaming)

```typescript
import { AIProviderFactory } from './ai-providers/factory';

async function* generateEssay(question: string, resumeContext: string) {
  const provider = await AIProviderFactory.getProvider();

  for await (const chunk of provider.chatStream({
    system: 'You are a professional career coach. Write compelling essay answers.',
    messages: [
      {
        role: 'user',
        content: `Question: ${question}\n\nMy background:\n${resumeContext}\n\nWrite a 200-300 word answer.`,
      },
    ],
    temperature: 0.8,
    maxTokens: 500,
  })) {
    yield chunk.delta;
  }
}
```

### Field Classification

```typescript
import { AIProviderFactory } from './ai-providers/factory';

async function classifyFields(unknownFields: FieldSignature[]) {
  const provider = await AIProviderFactory.getProvider();

  const response = await provider.chat({
    messages: [
      {
        role: 'user',
        content: `Given these form fields, what are they?\n\n${JSON.stringify(unknownFields)}\n\nReturn JSON: { field_id: canonical_key }`,
      },
    ],
    responseFormat: 'json_object',
    temperature: 0.3,
    maxTokens: 500,
  });

  return JSON.parse(response.content);
}
```

---

## Cost Tracking

Location: `extension/src/ai-providers/cost-tracker.ts`

```typescript
interface CostLog {
  timestamp: number;
  provider: string;
  operation: string; // 'resume_parse' | 'essay_generate' | 'field_classify'
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  cost: number;
}

const COST_LOG_KEY = 'ai_cost_log_v1';

export async function logCost(entry: CostLog): Promise<void> {
  const result = await chrome.storage.local.get(COST_LOG_KEY);
  const log: CostLog[] = result[COST_LOG_KEY] || [];
  
  log.push(entry);
  
  // Keep only last 1000 entries
  if (log.length > 1000) {
    log.splice(0, log.length - 1000);
  }
  
  await chrome.storage.local.set({ [COST_LOG_KEY]: log });
}

export async function getTotalCost(since?: number): Promise<number> {
  const result = await chrome.storage.local.get(COST_LOG_KEY);
  const log: CostLog[] = result[COST_LOG_KEY] || [];
  
  const filtered = since 
    ? log.filter(entry => entry.timestamp >= since)
    : log;
  
  return filtered.reduce((sum, entry) => sum + entry.cost, 0);
}

export async function getCostByProvider(): Promise<Record<string, number>> {
  const result = await chrome.storage.local.get(COST_LOG_KEY);
  const log: CostLog[] = result[COST_LOG_KEY] || [];
  
  return log.reduce((acc, entry) => {
    acc[entry.provider] = (acc[entry.provider] || 0) + entry.cost;
    return acc;
  }, {} as Record<string, number>);
}
```

---

## Testing

### Unit Tests

Location: `extension/src/ai-providers/__tests__/providers.test.ts`

```typescript
import { describe, it, expect, beforeAll } from '@jest/globals';
import { GroqProvider } from '../groq';
import { OpenAIProvider } from '../openai';
import { AIProviderFactory } from '../factory';

describe('GroqProvider', () => {
  let provider: GroqProvider;

  beforeAll(() => {
    provider = new GroqProvider(process.env.GROQ_API_KEY!);
  });

  it('should be available with valid API key', async () => {
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it('should complete a chat request', async () => {
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'Say "test successful"' }],
      maxTokens: 10,
    });

    expect(response.content).toContain('test');
    expect(response.usage.totalTokens).toBeGreaterThan(0);
    expect(response.cost).toBeGreaterThan(0);
  });

  it('should stream a chat response', async () => {
    const chunks: string[] = [];

    for await (const chunk of provider.chatStream({
      messages: [{ role: 'user', content: 'Count to 3' }],
      maxTokens: 20,
    })) {
      chunks.push(chunk.delta);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('1');
  });
});

describe('AIProviderFactory', () => {
  it('should create GROQ provider from config', async () => {
    // Mock config
    await chrome.storage.local.set({
      ai_provider_config_v1: {
        provider: 'groq',
        apiKey: 'test-key',
      },
    });

    const provider = await AIProviderFactory.getProvider();
    expect(provider.name).toBe('groq');
  });
});
```

---

## Migration Guide

### Switching from Anthropic (hardcoded) to GROQ

**Before:**
```typescript
// Hardcoded in background.ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function parseResume(text: string) {
  const response = await client.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    // ... rest of params
  });
  // ...
}
```

**After:**
```typescript
// Using abstraction
import { AIProviderFactory } from './ai-providers/factory';

async function parseResume(text: string) {
  const provider = await AIProviderFactory.getProvider();
  
  const response = await provider.chat({
    // ... provider-agnostic params
  });
  // ...
}
```

To switch to GROQ:
```typescript
// In popup settings or config
await setProviderConfig({ provider: 'groq' });
await setAPIKey('groq', 'gsk_xxx...');
```

**Zero code changes in business logic.**

---

## Future Extensions

### 1. Custom Provider (e.g., self-hosted)
```typescript
export class CustomProvider implements IAIProvider {
  constructor(private config: { baseUrl: string; apiKey: string }) {}
  // ... implement interface
}
```

### 2. Multi-Provider Routing
```typescript
// Use GROQ for fast tasks, OpenAI for complex reasoning
const fastProvider = new GroqProvider(apiKey);
const smartProvider = new OpenAIProvider(apiKey);

async function smartClassify(fields: FieldSignature[]) {
  // Try fast first
  const result = await fastProvider.chat({ ... });
  
  if (result.confidence < 0.8) {
    // Fall back to smart
    return await smartProvider.chat({ ... });
  }
  
  return result;
}
```

### 3. Provider Health Monitoring
```typescript
// Auto-switch to fallback if primary is down
export async function getHealthyProvider(): Promise<IAIProvider> {
  const config = await getProviderConfig();
  const primary = AIProviderFactory.createProvider(config);
  
  if (await primary.isAvailable()) {
    return primary;
  }
  
  if (config.fallbackProvider) {
    const fallback = AIProviderFactory.createProvider({
      ...config,
      provider: config.fallbackProvider,
    });
    
    if (await fallback.isAvailable()) {
      return fallback;
    }
  }
  
  throw new Error('No AI provider available');
}
```

---

## Summary

This abstraction layer gives you:

✅ **Flexibility:** Switch providers in one line  
✅ **Type safety:** Full TypeScript support  
✅ **Cost tracking:** Know exactly how much you're spending  
✅ **Offline support:** Local models for privacy-first users  
✅ **Testability:** Mock any provider for unit tests  
✅ **Future-proof:** Add new providers without touching business logic  

**Next step:** Implement this in Task 1.2, then use it throughout the extension.
