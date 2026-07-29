/**
 * Retrieval interface for the OPTIONAL RAG experiment (task 7.6).
 *
 * The engine only defines the `Retriever` seam and the prompt rendering;
 * implementations live OUTSIDE the engine (packages/rag — in-memory cosine
 * similarity today, sqlite-vec documented as the native upgrade) and are
 * injected via `RunDeps.retriever`, gated by `EngineConfig.rag` (default
 * OFF). Retrieved text is injected as clearly-labeled SUPPLEMENTARY context
 * ({{RETRIEVED_CONTEXT}}) — reference material, never instructions.
 */
import type { DiffFile } from "./diff";

export interface RetrievedChunk {
  /** Where the chunk came from (e.g. "HOUSE_RULES.md", "adr/0003.md"). */
  source: string;
  text: string;
  /** Similarity score, higher is more relevant. */
  score: number;
}

export interface Retriever {
  retrieve(query: string, topK: number): Promise<RetrievedChunk[]>;
}

export const DEFAULT_RETRIEVAL_TOP_K = 4;

/**
 * Deterministic retrieval query from the reviewed diff: changed paths plus
 * hunk headers (enclosing-scope hints). No model output involved.
 */
export function buildRetrievalQuery(files: readonly DiffFile[]): string {
  const parts: string[] = [];
  for (const file of files) {
    parts.push(file.path);
    for (const hunk of file.hunks) {
      if (hunk.header.trim().length > 0) parts.push(hunk.header.trim());
    }
  }
  return parts.join("\n");
}

/** Render retrieved chunks for the {{RETRIEVED_CONTEXT}} placeholder. */
export function renderRetrievedContext(chunks: readonly RetrievedChunk[]): string {
  if (chunks.length === 0) return "(none)";
  return chunks
    .map((c) => `### ${c.source} (score ${c.score.toFixed(2)})\n${c.text.trim()}`)
    .join("\n\n");
}
