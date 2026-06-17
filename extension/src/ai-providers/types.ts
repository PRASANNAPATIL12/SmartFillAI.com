/**
 * AI Provider Abstraction Layer
 * All AI calls in Ditto go through this interface.
 * Switch between GROQ and Gemini via config — zero code changes elsewhere.
 */

// ============================================================================
// Core Interface
// ============================================================================

export interface IAIProvider {
  /** Provider identifier */
  name: AIProviderName;

  /** Human-readable name for UI */
  displayName: string;

  /** Check if provider is reachable (API key valid, network up) */
  isAvailable(): Promise<boolean>;

  /** Non-streaming chat — for parsing, classification, key suggestions */
  chat(params: ChatParams): Promise<ChatResponse>;

  /** Streaming chat — for essay generation (user sees words appear live) */
  chatStream(params: ChatParams): AsyncIterableIterator<ChatChunk>;

  /** Rough token count estimate (for cost display) */
  countTokens(text: string): number;
}

// ============================================================================
// Request / Response Types
// ============================================================================

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatParams {
  /** Conversation messages */
  messages: ChatMessage[];

  /** Optional system prompt (prepended automatically if provider doesn't support it natively) */
  system?: string;

  /** Provider-specific model override (e.g. 'llama-3.3-70b-versatile') */
  model?: string;

  /** 0–2, defaults to 0.7 */
  temperature?: number;

  /** Max tokens to generate */
  maxTokens?: number;

  /** Force JSON output */
  responseFormat?: 'text' | 'json_object';

  /** Stop sequences */
  stop?: string[];
}

export interface ChatResponse {
  /** Generated text */
  content: string;

  /** Model actually used */
  model: string;

  /** Token usage */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  /** Estimated cost in USD */
  cost: number;
}

export interface ChatChunk {
  /** New text fragment */
  delta: string;

  /** Whether this is the last chunk */
  done: boolean;

  /** Cumulative text up to this point */
  accumulated: string;
}

// ============================================================================
// Provider Names & Config
// ============================================================================

export type AIProviderName = 'groq' | 'gemini';

export interface ProviderConfig {
  provider: AIProviderName;

  /** Override the default model for this provider */
  defaultModel?: string;

  /** Fallback if primary provider fails */
  fallbackProvider?: AIProviderName;

  /** Track cost per call in chrome.storage */
  trackCost?: boolean;
}

// Gemini is the primary provider for new LLM-answer features (owner-provided
// key, bundled at build time). GROQ remains available as fallback.
export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  provider: 'gemini',
  trackCost: true,
  fallbackProvider: 'groq',
};

// ============================================================================
// Cost Log (for usage tracking in popup)
// ============================================================================

export interface CostLogEntry {
  timestamp: number;
  provider: AIProviderName;
  operation: AIOperation;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

export type AIOperation =
  | 'resume_parse'
  | 'essay_generate'
  | 'field_classify'
  | 'key_suggest'
  | 'company_research';
