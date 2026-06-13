/**
 * Shared types used across extension and backend
 */

// ============================================================================
// Profile & Entries
// ============================================================================

export interface ProfileEntry {
  /** Unique ID */
  id: string;

  /** User ID (from auth) */
  userId: string;

  /** Canonical key (e.g., 'email', 'phone_number', 'linkedin_url') */
  canonical_key: string;

  /** Display label shown in UI */
  display_label: string;

  /** Alternative names for this entry */
  aliases: string[];

  /** The actual value (encrypted if sensitive) */
  value: string;

  /** Category for organization (contact, identity, education, work, etc.) */
  category: string;

  /** How was this entry created? */
  source: 'manual' | 'learned' | 'resume';

  /** Is this sensitive data? (SSN, government ID, etc.) */
  sensitive: boolean;

  /** Embedding vector (computed locally, NOT synced to cloud) */
  embedding?: number[];

  /** Timestamps */
  created_at: number;
  updated_at: number;
  last_used?: number;

  /** Usage statistics */
  use_count: number;
}

export interface Profile {
  entries: ProfileEntry[];
  version: number;
  last_sync: number;
}

// ============================================================================
// Field Signature & Matching
// ============================================================================

export interface FieldSignature {
  /** Text of associated <label> element (resolved from all label sources) */
  label: string;

  /** Placeholder attribute */
  placeholder: string;

  /** Name attribute */
  name: string;

  /** ID attribute */
  id: string;

  /** aria-label attribute */
  ariaLabel: string;

  /** autocomplete attribute (HTML5 standard — most reliable signal) */
  autocomplete: string;

  /** Input type (text, email, tel, textarea, select, etc.) */
  inputType: string;

  /** maxLength attribute (null if not set) */
  maxLength: number | null;

  /** Text content of surrounding elements */
  surroundingText: string;

  /** DOM element reference (not serializable, only in content script) */
  element?: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}

export type MatchStatus = 'MATCHED' | 'ESSAY' | 'UNKNOWN' | 'SKIP';

export interface MatchResult {
  /** Match status */
  status: MatchStatus;

  /** If MATCHED: which profile entry to use */
  profileEntryId?: string;

  /** Confidence score (0-1) */
  confidence?: number;

  /** Why this decision was made (for debugging/learning) */
  reason?: string;

  /** Which step in waterfall matched */
  matchStep?: number;
}

// ============================================================================
// Field Cache (Domain-Specific)
// ============================================================================

export interface FieldCacheEntry {
  /** Hash of domain + field signature */
  fingerprint: string;

  /** Which profile entry matched */
  profileEntryId: string;

  /** Confidence from original match */
  confidence: number;

  /** How many times we've used this cache entry successfully */
  useCount: number;

  /** Last used timestamp */
  lastUsed: number;
}

// ============================================================================
// Resume
// ============================================================================

export interface Resume {
  id: string;
  userId: string;
  label: string; // "Software Engineer Resume 2026"
  storagePath: string; // Supabase Storage path
  parsedText: string; // Extracted text (cached locally)
  isDefault: boolean;
  createdAt: number;
}

export interface ResumeParseResult {
  personal: {
    name?: string;
    email?: string;
    phone?: string;
    linkedin?: string;
    github?: string;
    portfolio?: string;
    location?: string;
  };
  education: Array<{
    institution: string;
    degree: string;
    year: string;
    gpa?: string;
  }>;
  work_experience: Array<{
    company: string;
    role: string;
    duration: string;
    highlights: string[];
  }>;
  skills: string[];
  certifications: string[];
}

// ============================================================================
// Essay
// ============================================================================

export interface EssayHistory {
  id: string;
  userId: string;
  questionText: string;
  answerText: string;
  pageDomain: string;
  companyHint?: string;
  createdAt: number;
}

// ============================================================================
// Settings
// ============================================================================

export interface UserSettings {
  /** Auto-save learned fields? */
  autoSave: boolean;

  /** Cloud sync enabled? */
  cloudSync: boolean;

  /** Sync frequency */
  syncFrequency: 'realtime' | '5min' | '30min' | 'manual';

  /** Show ghost text hints? */
  showGhostText: boolean;

  /** Sensitive domain blocking enabled? */
  blockSensitiveDomains: boolean;

  /** Per-domain overrides */
  domainOverrides: Record<string, {
    enabled: boolean;
    autoFill: boolean;
  }>;

  /** AI provider configuration */
  aiProvider: {
    provider: 'groq' | 'gemini';
    defaultModel?: string;
  };
}

// ============================================================================
// Auth Session
// ============================================================================

export interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  expiresAt: number; // Unix timestamp ms
}

// ============================================================================
// Activity Log
// ============================================================================

export type ActivityEventType = 'autofill' | 'essay_generate' | 'profile_learn' | 'sync';

export interface ActivityLogEntry {
  id: string;
  userId: string;
  eventType: ActivityEventType;
  domain?: string;
  fieldCount?: number;
  aiUsed: boolean;
  createdAt: number;
}

// ============================================================================
// Sync Queue (For Offline Changes)
// ============================================================================

export type SyncOperation = 'add' | 'update' | 'delete';

export interface SyncQueueItem {
  op: SyncOperation;
  entryId: string;
  data?: Partial<ProfileEntry>;
  timestamp: number;
}

// ============================================================================
// Chrome Storage Keys
// ============================================================================

export const STORAGE_KEYS = {
  PROFILE: 'profile_v1',
  SETTINGS: 'settings_v1',
  SESSION: 'session_v1',
  SYNC_META: 'sync_meta_v1',
  ESSAY_DRAFTS: 'essay_drafts_v1',
  AI_CONFIG: 'ai_provider_config_v1',
  AI_COST_LOG: 'ai_cost_log_v1',
  FIELD_CACHE: 'field_cache_v1',
  SYNC_QUEUE: 'sync_queue_v1',
} as const;

// ============================================================================
// Messages (Background ↔ Content Script ↔ Popup)
// ============================================================================

export type MessageType =
  // Health / diagnostics
  | 'PING'
  | 'GET_PROVIDER'
  // Profile CRUD
  | 'GET_PROFILE'
  | 'ADD_ENTRY'
  | 'UPDATE_ENTRY'
  | 'DELETE_ENTRY'
  | 'RECORD_USE'
  | 'UPDATE_PROFILE'   // bulk replace (used by sync engine)
  // Settings
  | 'GET_SETTINGS'
  | 'UPDATE_SETTINGS'
  // AI cost
  | 'GET_AI_COST'
  // ML / Step 5
  | 'STEP5_MATCH'
  | 'CACHE_FIELD_MATCH'
  | 'COMPUTE_EMBEDDINGS'
  // Deferred (Tasks 4-8)
  | 'MATCH_FIELDS'
  | 'FILL_FIELD'
  | 'FILL_ALL'
  | 'LEARN_FIELD'
  | 'GENERATE_ESSAY'
  | 'PARSE_RESUME'
  | 'SYNC_NOW';

export interface Message<T = any> {
  type: MessageType;
  payload: T;
}

export interface MessageResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================================================
// Utility Types
// ============================================================================

export type Timestamp = number; // Unix timestamp in milliseconds

export type UUID = string; // UUID v4

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };
