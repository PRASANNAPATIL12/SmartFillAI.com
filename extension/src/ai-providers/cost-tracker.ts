import type { CostLogEntry, AIProviderName, AIOperation } from './types';

const COST_KEY = 'ai_cost_log_v1';
const MAX_ENTRIES = 500;

// ============================================================================
// Write
// ============================================================================

export async function logCost(
  entry: Omit<CostLogEntry, 'timestamp'>
): Promise<void> {
  const stored = await getLog();
  stored.push({ ...entry, timestamp: Date.now() });

  // Trim oldest entries
  const trimmed = stored.length > MAX_ENTRIES
    ? stored.slice(stored.length - MAX_ENTRIES)
    : stored;

  await chrome.storage.local.set({ [COST_KEY]: trimmed });
}

// ============================================================================
// Read
// ============================================================================

export async function getTotalCost(sinceMs?: number): Promise<number> {
  const log = await getLog();
  const filtered = sinceMs ? log.filter(e => e.timestamp >= sinceMs) : log;
  return filtered.reduce((sum, e) => sum + e.cost, 0);
}

export async function getCostByProvider(): Promise<Record<AIProviderName, number>> {
  const log = await getLog();
  return log.reduce(
    (acc, e) => {
      acc[e.provider] = (acc[e.provider] ?? 0) + e.cost;
      return acc;
    },
    {} as Record<AIProviderName, number>
  );
}

export async function getCostByOperation(): Promise<Record<AIOperation, number>> {
  const log = await getLog();
  return log.reduce(
    (acc, e) => {
      acc[e.operation] = (acc[e.operation] ?? 0) + e.cost;
      return acc;
    },
    {} as Record<AIOperation, number>
  );
}

/** Cost for this calendar month */
export async function getMonthlyCost(): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return getTotalCost(startOfMonth);
}

export async function clearCostLog(): Promise<void> {
  await chrome.storage.local.remove(COST_KEY);
}

// ============================================================================
// Internal
// ============================================================================

async function getLog(): Promise<CostLogEntry[]> {
  const result = await chrome.storage.local.get(COST_KEY);
  return (result[COST_KEY] as CostLogEntry[] | undefined) ?? [];
}
