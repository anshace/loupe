import { describe, expect, it } from "vitest";
import { brierScore, cohensKappa, expectedCalibrationError, kappaLabel } from "./calibration.mjs";

describe("brierScore (#30)", () => {
  it("is 0 for perfectly confident correct predictions", () => {
    expect(brierScore([{ confidence: 1, correct: true }, { confidence: 0, correct: false }])).toBe(0);
  });

  it("is 1 for confidently wrong predictions", () => {
    expect(brierScore([{ confidence: 1, correct: false }, { confidence: 0, correct: true }])).toBe(1);
  });

  it("is 0.25 for a constant 0.5 guess regardless of outcome", () => {
    expect(brierScore([{ confidence: 0.5, correct: true }, { confidence: 0.5, correct: false }])).toBe(0.25);
  });

  it("ignores pairs with no numeric confidence and returns null when empty", () => {
    expect(brierScore([{ correct: true }])).toBeNull();
    expect(brierScore([])).toBeNull();
  });
});

describe("expectedCalibrationError (#30)", () => {
  it("is 0 when confidence matches accuracy in every bin", () => {
    // Two items at 0.5 confidence, exactly one correct → bin accuracy 0.5.
    const out = expectedCalibrationError([{ confidence: 0.5, correct: true }, { confidence: 0.5, correct: false }], 10);
    expect(out.ece).toBe(0);
  });

  it("measures the gap when the model is overconfident", () => {
    // Both at 0.9 confidence but both wrong → |acc 0 − conf 0.9| = 0.9.
    const out = expectedCalibrationError([{ confidence: 0.9, correct: false }, { confidence: 0.9, correct: false }], 10);
    expect(out.ece).toBe(0.9);
  });

  it("places confidence exactly 1.0 in the last bin (no phantom bin)", () => {
    const out = expectedCalibrationError([{ confidence: 1, correct: true }], 10);
    expect(out.ece).toBe(0);
    expect(out.bins).toHaveLength(1);
    expect(out.bins[0].bin).toBe(9);
  });

  it("returns null for an empty set", () => {
    expect(expectedCalibrationError([], 10)).toBeNull();
  });
});

describe("cohensKappa (#30)", () => {
  it("is 1 for identical labelings with mixed labels", () => {
    const out = cohensKappa(["keep", "drop", "keep"], ["keep", "drop", "keep"]);
    expect(out.kappa).toBe(1);
  });

  it("corrects for chance: full agreement on a single constant label is defined as 1", () => {
    const out = cohensKappa(["keep", "keep"], ["keep", "keep"]);
    expect(out.kappa).toBe(1);
    expect(out.pe).toBe(1);
  });

  it("is ~0 for chance-level agreement", () => {
    // A alternates, B alternates oppositely → 0 raw agreement, pe=0.5 → kappa -1.
    const out = cohensKappa(["keep", "drop", "keep", "drop"], ["drop", "keep", "drop", "keep"]);
    expect(out.po).toBe(0);
    expect(out.kappa).toBeLessThan(0);
  });

  it("returns null for empty or mismatched arrays", () => {
    expect(cohensKappa([], [])).toBeNull();
    expect(cohensKappa(["a"], ["a", "b"])).toBeNull();
  });
});

describe("kappaLabel (#30)", () => {
  it("maps kappa onto the Landis–Koch bands", () => {
    expect(kappaLabel(-0.1)).toBe("poor");
    expect(kappaLabel(0.1)).toBe("slight");
    expect(kappaLabel(0.5)).toBe("moderate");
    expect(kappaLabel(0.9)).toBe("almost-perfect");
  });
});
