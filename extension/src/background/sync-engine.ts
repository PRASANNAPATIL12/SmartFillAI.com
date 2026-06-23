import type { ProfileEntry, SyncQueueItem } from '@shared/types';
import { getSession } from './auth-manager';
import { getAuthClient } from './supabase-client';
import {
  getAllEntries,
  getSyncQueue,
  clearSyncQueue,
  replaceAll,
} from './profile-store';
import {
  getAllFormFingerprints,
  putFormFingerprint,
  getFormFingerprint,
} from '@/storage/idb';
import type { FormFingerprint } from '../content-script/form-fingerprinter';

const TABLE = 'profile_entries';
const FINGERPRINT_TABLE = 'form_fingerprints';

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

// ── Form-fingerprint sync (Phase AD.3) ────────────────────────────────────────
//
// Whole-state sync — fingerprints are small (≤3 KB each, ≤~100 per user
// typical) and change rarely, so an incremental queue isn't worth its cost.
// Each cycle uploads every local fingerprint via upsert; merges on pull use
// `lastUsedAt` as the tiebreaker so the more-recently-touched side wins.

interface FormFingerprintRow {
  user_id: string;
  key: string;
  ats_id: string;
  payload: FormFingerprint;
  updated_at: number;
}

/**
 * Upload every locally-known LEARNED fingerprint to Supabase via upsert.
 *
 * Phase AE.2 — template fingerprints (`source: 'template'`) are seeded
 * identically on every device from the bundled ATS_TEMPLATES, so pushing
 * them would mean N users × M templates duplicate rows in the cloud for no
 * benefit. We skip them here. A template is promoted to `source: 'learned'`
 * on the first real fill (via mergeFingerprint) — from that point on it
 * syncs normally.
 */
export async function pushFormFingerprints(): Promise<{ pushed: number; failed: number }> {
  const session = await getSession();
  if (!session) return { pushed: 0, failed: 0 };

  const all = await getAllFormFingerprints();
  // Filter out unpromoted templates. Old persisted rows without a `source`
  // field default to 'learned' so they still sync (no migration needed).
  const syncable = all.filter(fp => (fp.source ?? 'learned') !== 'template');
  if (syncable.length === 0) return { pushed: 0, failed: 0 };

  const client = await getAuthClient(session);
  const rows: FormFingerprintRow[] = syncable.map(fp => ({
    user_id:    session.userId,
    key:        fp.key,
    ats_id:     fp.atsId,
    payload:    fp,
    updated_at: fp.lastUsedAt,
  }));

  // Single batch upsert — Supabase handles the (user_id, key) primary-key conflict.
  const { error } = await client.from(FINGERPRINT_TABLE).upsert(rows, {
    onConflict: 'user_id,key',
  });
  if (error) return { pushed: 0, failed: rows.length };
  return { pushed: rows.length, failed: 0 };
}

/**
 * Pull every fingerprint for this user from Supabase. Merge into local IDB:
 * for each row, if local has a newer lastUsedAt the local copy wins (the
 * device that filled most recently has the better picture). Otherwise the
 * cloud copy is written in.
 */
export async function pullFormFingerprints(): Promise<{ pulled: number }> {
  const session = await getSession();
  if (!session) return { pulled: 0 };

  const client = await getAuthClient(session);
  const { data: rows, error } = await client
    .from(FINGERPRINT_TABLE)
    .select('*')
    .eq('user_id', session.userId);

  if (error) throw error;
  if (!rows || rows.length === 0) return { pulled: 0 };

  let pulled = 0;
  for (const row of rows as FormFingerprintRow[]) {
    const remote = row.payload;
    // Defensive: validate the payload has the fields we expect before writing.
    if (!remote || typeof remote !== 'object' || !remote.key || !Array.isArray(remote.fields)) {
      continue;
    }
    const local = await getFormFingerprint(remote.key);
    if (local && local.lastUsedAt >= remote.lastUsedAt) continue; // local wins
    await putFormFingerprint(remote);
    pulled++;
  }
  return { pulled };
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
