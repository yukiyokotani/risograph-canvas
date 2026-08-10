import { describe, expect, it } from "vitest";
import {
  analyzeSource,
  fingerprintDistance,
  candidateSignature,
  hasNearDuplicateInks,
  mutate,
  renderFingerprint,
  renderQualityScore,
  scoreRender,
  type Candidate,
} from "./discover";
import { INKS } from "../presets";

function solid(width: number, height: number, rgb: [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

describe("Discover source analysis", () => {
  it("keeps multiple dominant hues for a bimodal image", () => {
    const width = 8;
    const height = 8;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const color = x < width / 2 ? [240, 40, 50] : [45, 80, 235];
        data[o] = color[0];
        data[o + 1] = color[1];
        data[o + 2] = color[2];
        data[o + 3] = 255;
      }
    }

    const stats = analyzeSource(data, width, height);
    expect(stats.dominantHues.length).toBeGreaterThanOrEqual(2);
    expect(stats.saturatedRatio).toBeGreaterThan(0.9);
    expect(stats.l10).toBeLessThanOrEqual(stats.l50);
    expect(stats.l50).toBeLessThanOrEqual(stats.l90);
  });
});

describe("Discover rendered similarity", () => {
  it("uses spatial Lab distance to identify same and different renders", () => {
    const black = solid(8, 8, [0, 0, 0]);
    const white = solid(8, 8, [255, 255, 255]);
    const blackFingerprint = renderFingerprint(black, 8, 8);

    expect(fingerprintDistance(blackFingerprint, blackFingerprint)).toBe(0);
    expect(
      fingerprintDistance(blackFingerprint, renderFingerprint(white, 8, 8)),
    ).toBeGreaterThan(50);
  });

  it("scores an unchanged gradient as strongly preserved", () => {
    const width = 8;
    const height = 8;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = Math.round((x / (width - 1)) * 255);
        const o = (y * width + x) * 4;
        data[o] = value;
        data[o + 1] = value;
        data[o + 2] = value;
        data[o + 3] = 255;
      }
    }

    const score = scoreRender(data, data, width, height, 2);
    expect(score.distinction).toBeCloseTo(1, 5);
    expect(score.edgeRetention).toBeCloseTo(1, 5);
    expect(score.rangeRetention).toBeCloseTo(1, 5);
    expect(renderQualityScore(score)).toBeGreaterThan(0.8);
  });
});

describe("Discover similar candidate refill", () => {
  it("keeps producing distinct color and parameter alternatives from a single ink", () => {
    const base: Candidate = {
      id: "base",
      label: "Charcoal",
      category: "single",
      colors: [{ name: "Charcoal", color: "#70747C" }],
      paperColor: "#f5f0e8",
      invert: false,
      separation: 0,
      dotSize: 4,
      density: 1.1,
      inkOpacity: 0.8,
      misregistration: 1,
      highlightCutoff: 0,
      paperTexture: "none",
      halftoneMode: "am",
    };

    const alternatives = mutate(base, 42, 144);
    const signatures = new Set(alternatives.map(candidateSignature));
    expect(signatures.size).toBeGreaterThan(30);
    expect(alternatives.some((candidate) => candidate.colors.length === 2)).toBe(true);
  });
});

describe("Discover ink palette distance", () => {
  it("rejects nearly identical warm inks without rejecting clear harmonies", () => {
    expect(hasNearDuplicateInks([INKS.paprika, INKS.pumpkin])).toBe(true);
    expect(hasNearDuplicateInks([INKS.kelly, INKS.green])).toBe(true);
    expect(hasNearDuplicateInks([INKS.green, INKS.blue])).toBe(false);
    expect(hasNearDuplicateInks([INKS.green, INKS.yellow])).toBe(false);
  });

  it("does not add a near-duplicate third ink in Similar variations", () => {
    const base: Candidate = {
      id: "warm-base",
      label: "Paprika + Blue",
      category: "duo",
      colors: [INKS.paprika, INKS.blue],
      paperColor: "#f5f0e8",
      invert: false,
      separation: 0.5,
      dotSize: 4,
      density: 1.1,
      inkOpacity: 0.8,
      misregistration: 1,
      highlightCutoff: 0,
      paperTexture: "none",
      halftoneMode: "am",
    };

    expect(mutate(base, 7, 96).every((candidate) => !hasNearDuplicateInks(candidate.colors))).toBe(true);
  });
});
