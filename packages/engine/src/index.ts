/**
 * Review engine — pure, trigger-agnostic library.
 *
 * This package must never import from @actions/*, webhook frameworks, or any
 * other trigger technology. Adapters (Action, App/Worker) call into it with a
 * PR identity, an auth token, and config; the engine returns structured
 * results. The adapter performs all GitHub mutations (LLM proposes, code
 * disposes — design decision 8).
 */

export * from "./types";
export * from "./diff";
export * from "./noise";
export * from "./sizeCap";
export * from "./model";
export * from "./prompt";
export * from "./guardrail";
export * from "./clamp";
export * from "./publish";
export * from "./gate";
export * from "./config";
export * from "./suppress";
export * from "./dedupe";
export * from "./summary";
export * from "./cost";
export * from "./scope";
export * from "./agentic";
export * from "./verify";
export * from "./escalate";
export * from "./state";
export * from "./incremental";
export * from "./runlog";
export * from "./retrieve";
export * from "./run";

export * from "./stats";
