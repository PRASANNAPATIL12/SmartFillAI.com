/**
 * MiniLM-L6-v2 sentence embedder.
 * Runs in the background service worker — no DOM access needed.
 *
 * The @xenova/transformers library is loaded via dynamic import() so it
 * forms a separate Rollup chunk that is fetched only when the first
 * computeEmbedding() call is made, keeping the service-worker critical path
 * fast. The pipeline instance is then cached for the SW's lifetime.
 *
 * Configuration (applied on first load, before pipeline init):
 *   - numThreads=1 / proxy=false: prevents spawning web workers
 *     (service workers cannot create workers)
 *   - useBrowserCache=true: caches model files via Cache API
 *     (avoids re-downloading the 22 MB model on every SW wake)
 */

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pipe = (text: string, opts: object) => Promise<{ data: Float32Array }>;

let _pipe:    Pipe | null          = null;
let _loading: Promise<Pipe> | null = null;

async function loadEmbedder(): Promise<Pipe> {
  try {
    // Dynamic import defers the 828 KB transformers bundle until first use.
    const { pipeline, env } = await import('@xenova/transformers');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (env as any).backends.onnx.wasm.numThreads = 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (env as any).backends.onnx.wasm.proxy = false;
    env.useBrowserCache = true;
    const p = await pipeline('feature-extraction', MODEL_ID);
    _pipe    = p as unknown as Pipe;
    _loading = null;
    return _pipe;
  } catch (err) {
    _loading = null;
    throw err;
  }
}

async function getEmbedder(): Promise<Pipe> {
  if (_pipe)    return _pipe;
  if (_loading) return _loading;
  _loading = loadEmbedder();
  return _loading;
}

/**
 * Compute a 384-dimensional normalised embedding for the given text.
 * Throws if the model fails to load or inference fails.
 */
export async function computeEmbedding(text: string): Promise<number[]> {
  const embedder = await getEmbedder();
  const output   = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/** Cosine similarity between two equal-length normalised vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom < 1e-10 ? 0 : dot / denom;
}

/** Pre-warm the embedder so the model is ready before the first real request. */
export async function warmUp(): Promise<void> {
  await getEmbedder();
}
