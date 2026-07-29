/**
 * Embeds prompts/reviewer-v7.md into src/generated/promptTemplate.ts.
 *
 * The Workers runtime has no filesystem, so the engine's loadPromptTemplate
 * (node:fs) cannot run there; the worker instead injects the template via
 * RunDeps.promptTemplate. The generated file is checked in; re-run this
 * script (nub run embed-prompt in packages/worker, or it runs automatically
 * before `nub run dev:worker`) whenever the prompt file changes.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const promptPath = resolve(here, "..", "..", "..", "prompts", "reviewer-v7.md");
const outPath = resolve(here, "..", "src", "generated", "promptTemplate.ts");

const template = readFileSync(promptPath, "utf8");
const banner =
  "// AUTO-GENERATED from prompts/reviewer-v7.md by scripts/embed-prompt.mjs — DO NOT EDIT.\n" +
  "// Regenerate with: node packages/worker/scripts/embed-prompt.mjs\n";

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${banner}export const REVIEWER_PROMPT_TEMPLATE: string = ${JSON.stringify(template)};\n`);
console.log(`embedded ${promptPath} -> ${outPath} (${template.length} chars)`);
