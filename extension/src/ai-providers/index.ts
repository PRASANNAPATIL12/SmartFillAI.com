/**
 * AI Provider public surface.
 * Import everything you need from here — never from sub-files directly.
 *
 * Usage:
 *   import { AIProviderFactory, setProviderConfig, setAPIKey } from '@/ai-providers';
 */

export type {
  IAIProvider,
  ChatParams,
  ChatMessage,
  ChatResponse,
  ChatChunk,
  ProviderConfig,
  AIProviderName,
  AIOperation,
  CostLogEntry,
} from './types';

export { DEFAULT_PROVIDER_CONFIG } from './types';

export { GroqProvider, GROQ_DEFAULT_MODEL } from './groq';
export { GeminiProvider, GEMINI_DEFAULT_MODEL } from './gemini';

export { AIProviderFactory } from './factory';

export {
  getProviderConfig,
  setProviderConfig,
  getAPIKey,
  setAPIKey,
  removeAPIKey,
} from './config';

export {
  logCost,
  getTotalCost,
  getCostByProvider,
  getCostByOperation,
  getMonthlyCost,
  clearCostLog,
} from './cost-tracker';
