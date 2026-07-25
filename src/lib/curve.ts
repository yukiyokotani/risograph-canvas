/**
 * トーンカーブ（分解の手前で入力画像の階調を整える）。
 *
 * 曲線は「制御点を通る単調キュービック（Fritsch–Carlson）」で表す。ベジェだと
 * 引っ張り方によって曲線が非単調になり、トーンが逆転してバンディングが出るが、
 * 単調補間なら「点を必ず通る」「階調は絶対に逆転しない」が保証される。
 *
 * 実際の適用は 256 段の LUT に焼いてから行う。CPU と GPU に同じ LUT を渡せば
 * 実装差が出ないうえ、画素ごとの評価も 1 回のテーブル引きで済む。
 */

/** 制御点（x, y ともに 0–1）。x の昇順で保持する。 */
export interface CurvePoint {
  x: number;
  y: number;
}

/** チャンネルごとの効き具合（0–1）。0 で恒等、1 で設定したカーブそのまま。 */
export interface CurveAmounts {
  rgb: number;
  r: number;
  g: number;
  b: number;
}

/** RGB 一括と各チャンネルのカーブ。両端のみ（または効き 0）は恒等。 */
export interface ToneCurves {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
  /** 省略時は 1（＝カーブをそのまま適用） */
  amounts?: CurveAmounts;
}

export const FULL_AMOUNTS: CurveAmounts = { rgb: 1, r: 1, g: 1, b: 1 };

/** 効き具合を安全に取り出す（未設定・不正値は 1 とみなす） */
export function amountOf(curves: ToneCurves, key: keyof CurveAmounts): number {
  const v = curves.amounts?.[key];
  return typeof v === "number" && v >= 0 && v <= 1 ? v : 1;
}

/** 端点だけの恒等カーブ */
export const IDENTITY_POINTS: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/** 端点を入れ替えた反転カーブ（旧「Invert tones」と同じ） */
export const INVERT_POINTS: CurvePoint[] = [
  { x: 0, y: 1 },
  { x: 1, y: 0 },
];

/** 反転カーブ一式（RGB 一括だけ反転させる） */
export const INVERT_CURVES: ToneCurves = {
  rgb: INVERT_POINTS,
  r: IDENTITY_POINTS,
  g: IDENTITY_POINTS,
  b: IDENTITY_POINTS,
};

export const IDENTITY_CURVES: ToneCurves = {
  rgb: IDENTITY_POINTS,
  r: IDENTITY_POINTS,
  g: IDENTITY_POINTS,
  b: IDENTITY_POINTS,
};

/** すべてのチャンネルが恒等か（＝カーブを適用する必要が無いか） */
export function isIdentityCurves(curves: ToneCurves | undefined): boolean {
  if (!curves) return true;
  const flat = (points: CurvePoint[], key: keyof CurveAmounts) =>
    isIdentityChannel(points) || amountOf(curves, key) === 0;
  return (
    flat(curves.rgb, "rgb") &&
    flat(curves.r, "r") &&
    flat(curves.g, "g") &&
    flat(curves.b, "b")
  );
}

function isIdentityChannel(points: CurvePoint[]): boolean {
  if (points.length !== 2) return false;
  const [a, b] = points;
  return a.x === 0 && a.y === 0 && b.x === 1 && b.y === 1;
}

/**
 * 単調キュービック補間で曲線を評価し、steps 段の LUT（0–1）を返す。
 *
 * Fritsch–Carlson: 各点の傾きを、隣り合う区間の傾きから決めつつ、
 * オーバーシュートしないよう制限する（＝単調性が保たれる）。
 */
export function buildCurveLut(points: CurvePoint[], steps = 256): Float32Array {
  const lut = new Float32Array(steps);
  const pts = [...points].sort((p, q) => p.x - q.x);
  const n = pts.length;
  if (n === 0) {
    for (let i = 0; i < steps; i++) lut[i] = i / (steps - 1);
    return lut;
  }
  if (n === 1) {
    for (let i = 0; i < steps; i++) lut[i] = clamp01(pts[0].y);
    return lut;
  }

  // 区間の傾き
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1].x - pts[i].x;
    dx.push(h);
    slope.push(h > 1e-9 ? (pts[i + 1].y - pts[i].y) / h : 0);
  }

  // 各点の接線（単調性を壊さないよう制限する）
  const m: number[] = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      m[i] = 0; // 折り返し点では傾き 0（オーバーシュート防止）
    } else {
      m[i] = (slope[i - 1] + slope[i]) / 2;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }

  for (let i = 0; i < steps; i++) {
    const x = i / (steps - 1);
    lut[i] = clamp01(evaluate(pts, dx, m, x));
  }
  return lut;
}

function evaluate(
  pts: CurvePoint[],
  dx: number[],
  m: number[],
  x: number
): number {
  const n = pts.length;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[n - 1].x) return pts[n - 1].y;
  let k = 0;
  while (k < n - 2 && x > pts[k + 1].x) k++;
  const h = dx[k];
  if (h <= 1e-9) return pts[k].y;
  const t = (x - pts[k].x) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  // エルミート基底
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return (
    h00 * pts[k].y +
    h10 * h * m[k] +
    h01 * pts[k + 1].y +
    h11 * h * m[k + 1]
  );
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * RGB 一括と各チャンネルのカーブを合成し、チャンネルごとの 256 段 LUT（0–255）を返す。
 * 一括カーブを先に通してからチャンネル別を通す（Photoshop 等と同じ順序）。
 */
export function buildToneLut(curves: ToneCurves): Uint8Array {
  // 効き具合は「恒等とカーブの補間」。0 で素通し、1 でカーブそのまま。
  const withAmount = (lut: Float32Array, amount: number) => {
    if (amount >= 1) return lut;
    const out = new Float32Array(lut.length);
    for (let i = 0; i < lut.length; i++) {
      const identity = i / (lut.length - 1);
      out[i] = identity + (lut[i] - identity) * amount;
    }
    return out;
  };
  const rgb = withAmount(buildCurveLut(curves.rgb), amountOf(curves, "rgb"));
  const per = [
    withAmount(buildCurveLut(curves.r), amountOf(curves, "r")),
    withAmount(buildCurveLut(curves.g), amountOf(curves, "g")),
    withAmount(buildCurveLut(curves.b), amountOf(curves, "b")),
  ];
  const out = new Uint8Array(256 * 3);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < 256; i++) {
      const afterRgb = rgb[i];
      const idx = Math.round(afterRgb * 255);
      out[c * 256 + i] = Math.round(per[c][idx] * 255);
    }
  }
  return out;
}
