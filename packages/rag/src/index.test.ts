import { describe, expect, it } from "vitest";
import { HashEmbedder, InMemoryRetriever, chunkText, cosineSimilarity } from "./index";

describe("HashEmbedder", () => {
  it("is deterministic and L2-normalized", async () => {
    const embedder = new HashEmbedder();
    const [a1] = await embedder.embed(["validate input with zod"]);
    const [a2] = await embedder.embed(["validate input with zod"]);
    expect(a1).toEqual(a2);
    const norm = Math.sqrt(a1.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("gives overlapping texts higher similarity than unrelated ones", async () => {
    const embedder = new HashEmbedder();
    const [query, related, unrelated] = await embedder.embed([
      "api handler input validation zod",
      "All API handlers must validate input with zod schemas",
      "The office coffee machine needs descaling",
    ]);
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  it("embeds empty text to a zero vector without NaN", async () => {
    const [v] = await new HashEmbedder().embed([""]);
    expect(v.every((x) => x === 0)).toBe(true);
  });
});

describe("chunkText", () => {
  it("groups paragraphs up to the char cap, splitting at boundaries", () => {
    const text = "one\n\ntwo\n\nthree";
    expect(chunkText(text, 1000)).toEqual(["one\n\ntwo\n\nthree"]);
    expect(chunkText(text, 9)).toEqual(["one\n\ntwo", "three"]);
  });

  it("returns no chunks for blank input", () => {
    expect(chunkText("\n\n  \n", 100)).toEqual([]);
  });
});

describe("InMemoryRetriever", () => {
  const DOCS = [
    { source: "adr/0001-zod.md", text: "All API handlers must validate input with zod schemas." },
    { source: "HOUSE_RULES.md", text: "We intentionally use magic numbers in tests." },
    { source: "past-findings.md", text: "SQL injection risk when building queries by string concatenation." },
  ];

  it("ranks the most relevant document first and respects topK", async () => {
    const retriever = new InMemoryRetriever(new HashEmbedder());
    await retriever.index(DOCS);

    const top = await retriever.retrieve("src/api/users.ts handler validate input zod", 2);
    expect(top).toHaveLength(2);
    expect(top[0].source).toBe("adr/0001-zod.md");
    expect(top[0].score).toBeGreaterThan(top[1].score);
  });

  it("is deterministic across calls", async () => {
    const retriever = new InMemoryRetriever(new HashEmbedder());
    await retriever.index(DOCS);
    const a = await retriever.retrieve("sql query concatenation", 3);
    const b = await retriever.retrieve("sql query concatenation", 3);
    expect(a).toEqual(b);
    expect(a[0].source).toBe("past-findings.md");
  });

  it("returns [] on an empty index or non-positive topK", async () => {
    const empty = new InMemoryRetriever(new HashEmbedder());
    expect(await empty.retrieve("anything", 4)).toEqual([]);
    const filled = new InMemoryRetriever(new HashEmbedder());
    await filled.index(DOCS);
    expect(await filled.retrieve("anything", 0)).toEqual([]);
  });

  it("chunks long documents and labels every chunk with its source", async () => {
    const retriever = new InMemoryRetriever(new HashEmbedder(), 12);
    const count = await retriever.index([{ source: "long.md", text: "alpha beta\n\ngamma delta\n\nepsilon" }]);
    expect(count).toBeGreaterThan(1);
    const all = await retriever.retrieve("gamma", 10);
    expect(all.every((c) => c.source === "long.md")).toBe(true);
  });
});
