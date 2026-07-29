/**
 * @code-review/rag — the OPTIONAL retrieval experiment (task 7.6), a separate
 * package exactly like scope-ts so the engine keeps its zero-runtime-dependency
 * rule. The engine consumes only the `Retriever` interface (RunDeps.retriever,
 * behind the `rag` config flag, default OFF).
 *
 * WHAT SHIPS HERE: a deterministic in-memory retriever — documents (house
 * rules, ADRs, past findings) are chunked, embedded via an injectable
 * `Embedder`, and ranked by cosine similarity. `HashEmbedder` is the built-in
 * deterministic embedder (hashed bag-of-words, no network, no model), which
 * doubles as the test mock and as a genuinely usable offline baseline.
 *
 * HONEST STATUS — why sqlite-vec is NOT wired in (task 7.6 allows this
 * explicitly): sqlite-vec rides on a native SQLite module (better-sqlite3 →
 * node-gyp build, or the sqlite-vec loadable extension binary per platform).
 * For this local, solo project the corpus is a handful of markdown files and
 * past findings — it fits in memory, and a brute-force cosine scan over a few
 * hundred chunks is microseconds. What native sqlite-vec WOULD add:
 *   - a persistent on-disk index (no re-embedding on every process start),
 *   - sub-linear ANN-style scaling to tens of thousands of chunks,
 *   - SQL-side filtering (e.g. `WHERE source LIKE 'adr/%'`) fused with the
 *     vector scan.
 * None of that pays for a native build here. To upgrade later: `nub add
 * better-sqlite3 sqlite-vec` in THIS package and implement `Retriever` over a
 * `vec0` virtual table — the engine seam does not change. Likewise, a real
 * embedding model can replace HashEmbedder behind the same `Embedder`
 * interface. See docs/state-and-incremental.md.
 */
import type { RetrievedChunk, Retriever } from "@code-review/engine";

/** A document to index: house rules, an ADR, a past finding, etc. */
export interface RagDocument {
  /** Where the text came from, shown as the chunk label (e.g. "adr/0003.md"). */
  source: string;
  text: string;
}

/** Embeds texts into fixed-size vectors. Injectable so tests stay offline. */
export interface Embedder {
  embed(texts: readonly string[]): Promise<number[][]>;
}

export const EMBEDDING_DIM = 256;

/** FNV-1a 32-bit hash (dependency-free, deterministic). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic hashed bag-of-words embedder: each token bumps one of
 * EMBEDDING_DIM buckets; the vector is L2-normalized. No network, no model —
 * lexical-overlap similarity, which is honest about what it is: a baseline
 * (and the test mock). A real embedding model slots in behind `Embedder`.
 */
export class HashEmbedder implements Embedder {
  constructor(private readonly dim: number = EMBEDDING_DIM) {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(this.dim).fill(0);
      for (const token of text.toLowerCase().match(/[a-z0-9_$./-]+/g) ?? []) {
        vector[fnv1a(token) % this.dim] += 1;
      }
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      return norm === 0 ? vector : vector.map((v) => v / norm);
    });
  }
}

/** Cosine similarity of two same-length vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Split a document into paragraph-grouped chunks of at most `maxChars`. */
export function chunkText(text: string, maxChars: number): string[] {
  const paragraphs = text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length > maxChars && current.length > 0) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const DEFAULT_CHUNK_CHARS = 800;

interface IndexedChunk {
  source: string;
  text: string;
  vector: number[];
}

/**
 * The in-memory cosine-similarity Retriever the engine consumes. Fully
 * deterministic given a deterministic embedder: stable chunking, stable
 * scores, stable index-order tie-breaking.
 */
export class InMemoryRetriever implements Retriever {
  private readonly chunks: IndexedChunk[] = [];

  constructor(
    private readonly embedder: Embedder = new HashEmbedder(),
    private readonly chunkChars: number = DEFAULT_CHUNK_CHARS,
  ) {}

  /** Chunk + embed documents into the index. Returns the new chunk count. */
  async index(docs: readonly RagDocument[]): Promise<number> {
    const pending: Array<{ source: string; text: string }> = [];
    for (const doc of docs) {
      for (const text of chunkText(doc.text, this.chunkChars)) {
        pending.push({ source: doc.source, text });
      }
    }
    const vectors = await this.embedder.embed(pending.map((p) => p.text));
    for (let i = 0; i < pending.length; i++) {
      this.chunks.push({ ...pending[i], vector: vectors[i] });
    }
    return this.chunks.length;
  }

  async retrieve(query: string, topK: number): Promise<RetrievedChunk[]> {
    if (this.chunks.length === 0 || topK <= 0) return [];
    const [queryVector] = await this.embedder.embed([query]);
    return this.chunks
      .map((chunk, i) => ({ chunk, i, score: cosineSimilarity(queryVector, chunk.vector) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, topK)
      .map(({ chunk, score }) => ({ source: chunk.source, text: chunk.text, score }));
  }
}
