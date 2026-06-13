import type { ProfileEntry, SyncQueueItem } from '@shared/types';
import { getSession } from './auth-manager';
import { getAuthClient } from './supabase-client';
import {
  getAllEntries,
  getSyncQueue,
  clearSyncQueue,
  replaceAll,
} from './profile-store';

const TABLE = 'profile_entries';

// ── Column mapping ─────────────────────────────────────────────────────────────
// Our ProfileEntry uses camelCase userId; the DB column is user_id.

type DbRow = Omit<ProfileEntry, 'userId' | 'embedding'> & { user_id: string };

function toRow(entry: ProfileEntry): DbRow {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { userId, embedding: _emb, ...rest } = entry;
  return { ...rest, user_id: userId };
}

function fromRow(row: DbRow): ProfileEntry {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { user_id, ...rest } = row;
  return { ...rest, userId: user_id };
}

// ── Push (local queue → Supabase) ─────────────────────────────────────────────

export async function pushSyncQueue(): Promise<{ pushed: number; failed: number }> {
  const session = await getSession();
  if (!session) return { pushed: 0, failed: 0 };

  const queue = await getSyncQueue();
  if (queue.length === 0) return { pushed: 0, failed: 0 };

  const client = await getAuthClient(session);
  let pushed = 0;
  let failed = 0;

  for (const item of queue) {
    try {
      await pushItem(client, item, session.userId);
      pushed++;
    } catch {
      failed++;
    }
  }

  // Clear the queue only if all ops succeeded — retry on next tick if any failed
  if (failed === 0) {
    await clearSyncQueue();
  }

  return { pushed, failed };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pushItem(client: any, item: SyncQueueItem, userId: string): Promise<void> {
  const { op, entryId, data } = item;

  if (op === 'add' && data) {
    const row = toRow({ ...data, userId } as ProfileEntry);
    const { error } = await client.from(TABLE).upsert(row);
    if (error) throw error;

  } else if (op === 'update' && data) {
    // data only contains the patch fields — no userId, no embedding
    const { error } = await client
      .from(TABLE)
      .update({ ...data, updated_at: Date.now() })
      .eq('id', entryId)
      .eq('user_id', userId);
    if (error) throw error;

  } else if (op === 'delete') {
    const { error } = await client
      .from(TABLE)
      .delete()
      .eq('id', entryId)
      .eq('user_id', userId);
    if (error) throw error;
  }
}

// ── Pull (Supabase → local) ───────────────────────────────────────────────────

export async function pullFromCloud(): Promise<{ pulled: number }> {
  const session = await getSession();
  if (!session) return { pulled: 0 };

  const client = await getAuthClient(session);

  const { data: rows, error } = await client
    .from(TABLE)
    .select('*')
    .eq('user_id', session.userId);

  if (error) throw error;
  if (!rows || rows.length === 0) return { pulled: 0 };

  const remote = (rows as DbRow[]).map(fromRow);

  // Merge: preserve local-only fields (embedding, use_count, last_used)
  const local = await getAllEntries();
  const localMap = new Map(local.map(e => [e.id, e]));

  const merged = remote.map(remoteEntry => {
    const existing = localMap.get(remoteEntry.id);
    return {
      ...remoteEntry,
      use_count: existing?.use_count ?? remoteEntry.use_count,
      last_used: existing?.last_used ?? remoteEntry.last_used,
      embedding: existing?.embedding,
    };
  });

  await replaceAll(merged);
  return { pulled: merged.length };
}
