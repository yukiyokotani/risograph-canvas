import { describe, expect, it } from "vitest";
import {
  buildCurveLut,
  buildToneLut,
  isIdentityCurves,
  IDENTITY_CURVES,
  IDENTITY_POINTS,
  type CurvePoint,
} from "./curve";

describe("buildCurveLut", () => {
  it("端点だけなら恒等", () => {
    const lut = buildCurveLut(IDENTITY_POINTS);
    for (let i = 0; i < 256; i++) {
      expect(lut[i]).toBeCloseTo(i / 255, 5);
    }
  });

  it("点を必ず通る", () => {
    const points: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.8 },
      { x: 1, y: 1 },
    ];
    const lut = buildCurveLut(points);
    expect(lut[0]).toBeCloseTo(0, 5);
    expect(lut[128]).toBeCloseTo(0.8, 2);
    expect(lut[255]).toBeCloseTo(1, 5);
  });

  it("極端な点でも単調性が壊れない（階調が逆転しない）", () => {
    // ベジェだとオーバーシュートしがちな配置
    const points: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 0.1, y: 0.9 },
      { x: 0.9, y: 0.95 },
      { x: 1, y: 1 },
    ];
    const lut = buildCurveLut(points);
    for (let i = 1; i < lut.length; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1] - 1e-6);
    }
    for (const v of lut) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("下げるカーブでも単調（減少方向）", () => {
    const lut = buildCurveLut([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.2 },
      { x: 1, y: 1 },
    ]);
    for (let i = 1; i < lut.length; i++) {
      expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1] - 1e-6);
    }
    expect(lut[128]).toBeLessThan(128 / 255);
  });
});

describe("buildToneLut", () => {
  it("恒等カーブなら入力をそのまま返す", () => {
    const lut = buildToneLut(IDENTITY_CURVES);
    expect(lut).toHaveLength(768);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 256; i++) {
        expect(lut[c * 256 + i]).toBe(i);
      }
    }
  });

  it("RGB 一括の後にチャンネル別が掛かる", () => {
    const half: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0.5 },
    ];
    const lut = buildToneLut({ ...IDENTITY_CURVES, rgb: half });
    // 一括で半分になる
    expect(lut[255]).toBeCloseTo(128, -1);
    const both = buildToneLut({ ...IDENTITY_CURVES, rgb: half, r: half });
    // R だけさらに半分
    expect(both[255]).toBeLessThan(lut[255]);
    expect(both[256 + 255]).toBe(lut[256 + 255]);
  });
});

describe("isIdentityCurves", () => {
  it("未設定・恒等は true、点を動かすと false", () => {
    expect(isIdentityCurves(undefined)).toBe(true);
    expect(isIdentityCurves(IDENTITY_CURVES)).toBe(true);
    expect(
      isIdentityCurves({
        ...IDENTITY_CURVES,
        g: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.6 },
          { x: 1, y: 1 },
        ],
      })
    ).toBe(false);
  });
});
