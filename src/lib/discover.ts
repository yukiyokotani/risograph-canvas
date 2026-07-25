/**
 * Discover — 「写真が映える配色＋点設定」を大量ランダム提示して選ばせる機能の純ロジック。
 *
 * 方針:
 *  - 崩壊（元形状が失われる／色が潰れて識別不能）を避けるため、完全ランダムではなく
 *    実インクのプール＋色相ハーモニー＋定番の当たり combo から制約付きで生成する。
 *  - 生成した候補を小さく描画し、「知覚的な区別の保存」= distinction で採点して並べる。
 *    しきい値で機械的に切らず、ランキング＋多様性で上位を見せて人が選ぶ。
 *  - 点設定は AM 固定、dotSize 2–6（中心 2–4）、density 1.0–1.4 に制約（Dot Density は使わない）。
 *
 * 採点ロジックは experiments/discover での検証結果を移植したもの。
 */
import type { StencilColor, PaperTexture, HalftoneMode } from "./stencil";
import type { ToneCurves } from "./curve";
import type { StencilSettings } from "./settings";
import { INKS, PRESETS } from "../presets";
import { hexToRgb, rgbToLab } from "./color";

/**
 * Discover の候補が使う「クリーンなパイプライン固定値」。サムネ描画と適用で同じ値を使い、
 * サムネの見た目と適用後プレビューを一致させる。
 */
export const DISCOVER_FIXED = {
  blackGeneration: 0.7,
  noise: 0,
  // 紙テクスチャは見栄えにほぼ効かないのでランダムに振らず固定（none）
  paperTexture: "none" as const,
  paperTextureAmount: 0.5,
};

/** サムネの内部描画幅。プレビュー基準幅(600)に対する比を renderScale にして見た目を合わせる。 */
export const THUMB_RENDER_WIDTH = 240;
export const PREVIEW_BASE_WIDTH = 600;

/** 足切り用に先に描く「下見」レンダの幅（採点だけに使うので小さくてよい） */
export const SCREEN_RENDER_WIDTH = 88;
/**
 * 候補の足切り基準（experiments/discover で検証した値）。
 * distinction = 元画像で離れている画素ペアが描画でも離れているか（形・ディテールの保存度）。
 * variation = 描画側の平均ペア距離（全体が一色に潰れていないか）。
 * どちらも下回る候補は「何が写っているか分からない」ので Discover には出さない。
 */
export const MIN_DISTINCTION = 0.5;
export const MIN_VARIATION = 8;
/** 同じパレットをグリッドへ出す上限（点設定違いは許容しつつ、同じ配色で埋め尽くさない） */
export const MAX_PER_PALETTE = 3;

// --- 候補の型 ---
export type DiscoverCategory =
  | "current"
  | "curated"
  | "duo"
  | "tri"
  | "single"
  | "surprise";

/** Discover が振る「制御対象パラメータ」。適用時はこれらを丸ごと state へ反映する。 */
export interface Candidate {
  id: string;
  label: string;
  category: DiscoverCategory;
  colors: StencilColor[];
  paperColor: string;
  invert: boolean;
  /** 色分解の強さ 0–1（0=忠実 / 1=グラフィック） */
  separation: number;
  dotSize: number;
  density: number;
  inkOpacity: number;
  misregistration: number;
  highlightCutoff: number;
  paperTexture: PaperTexture;
  halftoneMode: HalftoneMode;
  /**
   * 生成候補は DISCOVER_FIXED を使うので持たない。「今の表示」から作る候補
   * （と、そこから派生した similar）だけが実際の設定値を持ち、サムネと
   * メイン画面の見た目を一致させる。
   */
  blackGeneration?: number;
  noise?: number;
  paperTextureAmount?: number;
  transparentBg?: boolean;
  /** 反転以外のトーンカーブ。持っていれば invert より優先。 */
  curves?: ToneCurves;
}

export interface ScoredCandidate extends Candidate {
  distinction: number;
  variation: number;
}

// ---------------------------------------------------------------------------
// RNG（決定的）— 再生成のたびに seed を進めれば別の一式が得られ、同 seed は再現する。
// ---------------------------------------------------------------------------
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(rng: () => number, arr: readonly T[]): T =>
  arr[Math.floor(rng() * arr.length)];
const rangePick = (rng: () => number, min: number, max: number) =>
  min + rng() * (max - min);
const clamp = (min: number, max: number, v: number) => Math.min(max, Math.max(min, v));
const roundTo = (step: number, v: number) => Math.round(v / step) * step;

// ---------------------------------------------------------------------------
// インクプール（実インクから、生成に使う彩度の高い/はっきりした色を厳選）
// ---------------------------------------------------------------------------
interface PoolInk {
  key: keyof typeof INKS;
  color: StencilColor;
  L: number;
  chroma: number;
  hue: number; // 0..360
}
function toPoolInk(key: keyof typeof INKS): PoolInk {
  const color = INKS[key];
  const { r, g, b } = hexToRgb(color.color);
  const [L, la, lb] = rgbToLab(r, g, b);
  return { key, color, L, chroma: Math.hypot(la, lb), hue: (Math.atan2(lb, la) * 180) / Math.PI };
}
const hueDist = (a: number, b: number) => {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
};

// 彩度が高く色相がはっきりしたインク（デュオ/トリオの主役）
const VIVID_KEYS: (keyof typeof INKS)[] = [
  "blue", "brightRed", "yellow", "teal", "orange", "green", "burgundy", "purple",
  "seaBlue", "lake", "emerald", "turquoise", "kelly", "violet", "orchid", "scarlet",
  "paprika", "pumpkin", "raspberry", "cranberry", "gold",
  "fluorescentPink", "fluorescentBlue", "fluorescentGreen", "fluorescentYellow", "fluorescentOrange",
];
const FLUOR_KEYS: (keyof typeof INKS)[] = [
  "fluorescentPink", "fluorescentBlue", "fluorescentGreen", "fluorescentYellow", "fluorescentOrange",
];
const DARK_KEYS: (keyof typeof INKS)[] = [
  "black", "indigo", "midnight", "federalBlue", "steel", "charcoal", "plum",
];

const VIVID = VIVID_KEYS.map(toPoolInk);
const FLUOR = FLUOR_KEYS.map(toPoolInk);
const DARK = DARK_KEYS.map(toPoolInk);

// 定番の当たり combo（プリセット＋2色掛け合わせの定番）。ink キー配列で保持。
type Combo = { label: string; keys: (keyof typeof INKS)[] };
const INK_KEYS = Object.keys(INKS) as (keyof typeof INKS)[];
const PRESET_COMBOS: Combo[] = Object.values(PRESETS).map((p) => ({
  label: p.name,
  keys: p.colors
    .map((c) => INK_KEYS.find((k) => INKS[k] === c))
    .filter((k): k is keyof typeof INKS => Boolean(k)),
}));
const EXTRA_COMBOS: Combo[] = [
  { label: "Fl. Blue + Fl. Yellow", keys: ["fluorescentBlue", "fluorescentYellow"] },
  { label: "Blue + Fl. Orange", keys: ["blue", "fluorescentOrange"] },
  { label: "Teal + Fl. Pink", keys: ["teal", "fluorescentPink"] },
  { label: "Purple + Yellow", keys: ["purple", "yellow"] },
  { label: "Emerald + Fl. Pink", keys: ["emerald", "fluorescentPink"] },
  { label: "Black + Fl. Pink", keys: ["black", "fluorescentPink"] },
  { label: "Black + Fl. Blue", keys: ["black", "fluorescentBlue"] },
];
const CURATED: Combo[] = [...PRESET_COMBOS, ...EXTRA_COMBOS];

// ---------------------------------------------------------------------------
// ソース解析（彩度と支配的な色相）— 生成のカテゴリ配分とハーモニーの基準に使う。
// ---------------------------------------------------------------------------
export interface SourceStats {
  chroma: number; // 平均 Lab 彩度
  dominantHue: number; // 彩度で重み付けした支配色相
  mono: boolean;
}
export function analyzeSource(px: Uint8ClampedArray, w: number, h: number): SourceStats {
  let cSum = 0, n = 0;
  let hx = 0, hy = 0; // 色相ベクトルの合成（彩度重み）
  const step = Math.max(1, Math.floor((w * h) / 4000)); // 最大 ~4000 サンプル
  for (let i = 0; i < w * h; i += step) {
    const o = i * 4;
    const [, la, lb] = rgbToLab(px[o], px[o + 1], px[o + 2]);
    const c = Math.hypot(la, lb);
    cSum += c; n++;
    hx += la; hy += lb; // 彩度そのものが重みになる（la,lb は彩度スケール）
  }
  const chroma = n ? cSum / n : 0;
  const dominantHue = (Math.atan2(hy, hx) * 180) / Math.PI;
  return { chroma, dominantHue, mono: chroma < 12 };
}

// ---------------------------------------------------------------------------
// インク選択（色相ハーモニー）
// ---------------------------------------------------------------------------
/** target 色相の近くのインクを重み付き抽選（saturated プールから、exclude を除く）。 */
function pickNearHue(
  rng: () => number,
  pool: PoolInk[],
  targetHue: number | null,
  exclude: Set<string>,
): PoolInk {
  const cands = pool.filter((p) => !exclude.has(p.key));
  if (cands.length === 0) return pick(rng, pool);
  const weights = cands.map((p) => {
    if (targetHue === null) return 1;
    // 近いほど高い。彩度も少し優遇。
    return Math.exp(-hueDist(p.hue, targetHue) / 45) * (0.5 + p.chroma / 100);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < cands.length; i++) {
    r -= weights[i];
    if (r <= 0) return cands[i];
  }
  return cands[cands.length - 1];
}

/** 互いに色相の離れた n 色を選ぶ（濁った近似色ペアを避ける）。 */
function pickHarmony(
  rng: () => number,
  pool: PoolInk[],
  n: number,
  baseHue: number | null,
): PoolInk[] {
  const chosen: PoolInk[] = [];
  const exclude = new Set<string>();
  // 1色目: baseHue 付近（colorful ならソース支配色、mono なら任意）
  const anchor = baseHue ?? rng() * 360;
  for (let i = 0; i < n; i++) {
    // n 色を色相環に均等配置した狙い角へ寄せる
    const target = anchor + (360 / n) * i;
    let attempt = pickNearHue(rng, pool, target, exclude);
    // 既選択と色相が近すぎる場合は緩く再抽選（最大数回）
    for (let t = 0; t < 3 && chosen.some((c) => hueDist(c.hue, attempt.hue) < 35); t++) {
      attempt = pickNearHue(rng, pool, target, exclude);
    }
    chosen.push(attempt);
    exclude.add(attempt.key);
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// パラメータ（制約付きランダム）
// ---------------------------------------------------------------------------
const PAPER_CREAM = "#f5f0e8";
const PAPER_DARK = "#1a1a1a";

/**
 * 見栄えに強く効く3つ（点サイズ・濃度・不透明度）は「見て違いが分かる刻み」の
 * 離散値から選ぶ。連続値だと dotSize 3.5 と 3.0 のような差の分からない候補が量産され、
 * グリッドが似たもので埋まってしまうため。
 */
const DOT_SIZES = [2, 3, 4, 5, 6];
const DENSITIES = [0.9, 1.1, 1.3, 1.5];
const OPACITIES = [0.65, 0.75, 0.85, 0.95];

/**
 * 色分解の強さの抽選。写真は忠実側（0 付近）が当たりやすい一方、思い切って
 * グラフィックに倒した絵も Discover の面白さなので、忠実寄りに重みを置きつつ
 * 全域から引く。
 */
function pickSeparation(rng: () => number): number {
  const r = rng();
  if (r < 0.4) return 0;
  if (r < 0.65) return roundTo(0.05, rangePick(rng, 0.15, 0.4));
  if (r < 0.85) return roundTo(0.05, rangePick(rng, 0.45, 0.7));
  return roundTo(0.05, rangePick(rng, 0.75, 1));
}

function randomParams(rng: () => number) {
  const dotSize = pick(rng, DOT_SIZES);
  const density = pick(rng, DENSITIES);
  const inkOpacity = pick(rng, OPACITIES);
  const misregistration = roundTo(0.5, rangePick(rng, 0, 2));
  // ハイライトのクリップは基本 0、たまに軽く効かせる
  const highlightCutoff = rng() < 0.7 ? 0 : roundTo(0.01, rangePick(rng, 0.03, 0.15));
  // paperTexture は固定（DISCOVER_FIXED）なのでここでは振らない
  return {
    separation: pickSeparation(rng),
    dotSize,
    density,
    inkOpacity,
    misregistration,
    highlightCutoff,
    halftoneMode: "am" as const,
  };
}

/**
 * 「今メイン画面に出ている見た目」を Discover の先頭候補にする。
 * 生成候補と違い固定値を使わず、実際の設定をそのまま持たせる
 * （サムネが今の表示と一致し、そこからの similar が意味を持つ）。
 */
export function candidateFromSettings(s: StencilSettings): Candidate {
  return {
    id: "current",
    label: "Current",
    category: "current",
    colors: s.colors,
    paperColor: s.paperColor,
    invert: false,
    separation: s.separation,
    dotSize: s.dotSize,
    density: s.density,
    inkOpacity: s.inkOpacity,
    misregistration: s.misregistration,
    highlightCutoff: s.highlightCutoff,
    paperTexture: s.paperTexture,
    halftoneMode: s.halftoneMode,
    blackGeneration: s.blackGeneration,
    noise: s.noise,
    paperTextureAmount: s.paperTextureAmount,
    transparentBg: s.transparentBg,
    curves: s.curves,
  };
}

/** 同じパレット（＋紙・反転）かどうかの判定キー。同一パレットの出過ぎを抑えるのに使う。 */
export function paletteKey(c: Candidate): string {
  return c.colors.map((x) => x.color).sort().join(",") + "|" + c.paperColor + "|" + c.invert;
}

/**
 * 「見た目が実質同じ」候補をまとめる署名。パレットに加えて、見栄えを左右する
 * 点サイズ・濃度・不透明度まで含める（同じパレットでも点設定が違えば別候補として許容し、
 * 点設定まで同じものだけを重複として弾く）。
 */
export function candidateSignature(c: Candidate): string {
  return `${paletteKey(c)}|${c.separation}|${c.dotSize}|${c.density}|${c.inkOpacity}`;
}

/** StencilColor（アプリの色）から対応する PoolInk を引く（色文字列で照合）。 */
function poolInkFromColor(color: StencilColor): PoolInk {
  const key = INK_KEYS.find((k) => INKS[k].color === color.color) ?? "blue";
  return toPoolInk(key);
}

let idSeq = 0;
function makeCandidate(
  rng: () => number,
  category: DiscoverCategory,
  label: string,
  inks: StencilColor[],
  opts?: { paperColor?: string; invert?: boolean },
): Candidate {
  return {
    id: `c${idSeq++}`,
    label,
    category,
    colors: inks,
    paperColor: opts?.paperColor ?? PAPER_CREAM,
    invert: opts?.invert ?? false,
    paperTexture: DISCOVER_FIXED.paperTexture,
    ...randomParams(rng),
  };
}

// ---------------------------------------------------------------------------
// 候補生成
// ---------------------------------------------------------------------------
export function generateCandidates(
  stats: SourceStats,
  seed: number,
  count = 48,
): Candidate[] {
  const rng = makeRng(seed);
  const out: Candidate[] = [];
  const baseHue = stats.mono ? null : stats.dominantHue;

  // カテゴリ配分（彩度で変える）。mono は単色/サプライズ多め、color はデュオ/トリオ多め。
  const mix = stats.mono
    ? { curated: 0.18, duo: 0.22, tri: 0.08, single: 0.28, surprise: 0.24 }
    : { curated: 0.28, duo: 0.34, tri: 0.16, single: 0.1, surprise: 0.12 };

  const nCurated = Math.round(count * mix.curated);
  const nDuo = Math.round(count * mix.duo);
  const nTri = Math.round(count * mix.tri);
  const nSingle = Math.round(count * mix.single);
  const nSurprise = count - nCurated - nDuo - nTri - nSingle;

  // 定番: シャッフルして先頭から（1ページ内で同じ combo を使い回さない）
  const curatedShuffled = [...CURATED].sort(() => rng() - 0.5);
  for (let i = 0; i < Math.min(nCurated, curatedShuffled.length); i++) {
    const c = curatedShuffled[i];
    out.push(makeCandidate(rng, "curated", c.label, c.keys.map((k) => INKS[k])));
  }
  // デュオ（ハーモニー）
  for (let i = 0; i < nDuo; i++) {
    const inks = pickHarmony(rng, VIVID, 2, baseHue);
    out.push(makeCandidate(rng, "duo", inks.map((p) => p.color.name).join(" + "), inks.map((p) => p.color)));
  }
  // トリオ（ハーモニー）
  for (let i = 0; i < nTri; i++) {
    const inks = pickHarmony(rng, VIVID, 3, baseHue);
    out.push(makeCandidate(rng, "tri", inks.map((p) => p.color.name).join(" + "), inks.map((p) => p.color)));
  }
  // 単色（蛍光 or 暗色 or 支配色相の近く）
  for (let i = 0; i < nSingle; i++) {
    const usePool = rng() < 0.5 ? FLUOR : rng() < 0.5 ? VIVID : DARK;
    const ink = pickNearHue(rng, usePool, baseHue, new Set());
    out.push(makeCandidate(rng, "single", ink.color.name, [ink.color]));
  }
  // サプライズ（蛍光1–2色 on 黒紙 + 反転）
  for (let i = 0; i < nSurprise; i++) {
    const n = rng() < 0.6 ? 1 : 2;
    const inks = pickHarmony(rng, FLUOR, n, baseHue);
    out.push(
      makeCandidate(rng, "surprise", inks.map((p) => p.color.name).join(" + ") + " · black paper", inks.map((p) => p.color), {
        paperColor: PAPER_DARK,
        invert: true,
      }),
    );
  }
  return out;
}

/** SIMILAR strip 用の「base からの差」の格子（近い順）。重複なく系統的に振るのに使う。 */
const NEAR_DOT = [0, -1, 1, -2, 2];
const NEAR_DENSITY = [0, 0.2, -0.2];

/**
 * 選択候補の「近傍」を生成。
 *
 * ランダムに振ると似た組み合わせが偶然固まって strip が重複だらけになるため、
 * 点サイズ×濃度の差分を**重複のない格子**として順に割り当てる（base に近い順）。
 * 3枚に1枚だけ色も少し動かし（同系色への差し替え／色を1つ足す・引く）、
 * 残りはパレットを保ったまま点設定だけを見比べられるようにする。
 * 紙・反転・版ずれ・ハイライトクリップは base のまま（差が分かりにくい軸を振らない）。
 */
export function mutate(base: Candidate, seed: number, count = 24): Candidate[] {
  const rng = makeRng(seed);
  const label = (colors: StencilColor[]) =>
    colors.map((c) => c.name).join(" + ") + (base.invert ? " · black paper" : "");

  const grid: [number, number][] = [];
  for (const dDens of NEAR_DENSITY) {
    for (const dDot of NEAR_DOT) {
      if (dDot === 0 && dDens === 0) continue; // base そのものは strip 先頭に固定済み
      grid.push([dDot, dDens]);
    }
  }

  // 生成候補は dotSize 2–6 / density 0.9–1.5 だが、「今の表示」を base にすると
  // その外側（例: 0.5px の細かい網点）から始まる。base 側へ範囲を広げ、
  // 刻みも base に合わせて縮める（固定 ±1px では細かい網点で差が大きすぎる）。
  const dotStep = base.dotSize <= 2 ? 0.5 : 1;
  const dotLo = Math.min(2, base.dotSize);
  const dotHi = Math.max(6, base.dotSize);
  const densLo = Math.min(0.9, base.density);
  const densHi = Math.max(1.5, base.density);

  const pool = base.category === "surprise" ? FLUOR : VIVID;
  const out: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const [dDot, dDens] = grid[i % grid.length];
    const round = Math.floor(i / grid.length);
    const dotSize = clamp(dotLo, dotHi, roundTo(0.5, base.dotSize + dDot * dotStep));
    const density = clamp(densLo, densHi, roundTo(0.05, base.density + dDens));
    // 格子を 2 周目以降に使うときは不透明度をずらして同じ見た目にならないようにする
    const opacityShift = round === 0 ? 0 : round % 2 === 1 ? 0.1 : -0.1;
    const inkOpacity = clamp(0.6, 0.95, roundTo(0.05, base.inkOpacity + opacityShift));
    // 色分解の強さも近傍で振る（絵の印象が最も変わるので、similar の主役の一つ）
    const separation =
      i % 4 === 3
        ? pickSeparation(rng)
        : clamp(0, 1, roundTo(0.05, base.separation + rangePick(rng, -0.25, 0.25)));

    let colors = base.colors;
    if (i % 3 === 2) {
      // 色も少しだけ動かす（同系色への差し替え → 足す/引く を交互に）
      if (i % 6 === 2 && base.colors.length >= 1) {
        const idx = Math.floor(rng() * base.colors.length);
        const cur = poolInkFromColor(base.colors[idx]);
        const near = pool.filter(
          (p) => p.color.color !== base.colors[idx].color && hueDist(p.hue, cur.hue) < 40,
        );
        if (near.length) {
          const repl = near[Math.floor(rng() * near.length)];
          colors = base.colors.map((c, j) => (j === idx ? repl.color : c));
        }
      } else if (base.colors.length >= 2 && rng() < 0.5) {
        const drop = Math.floor(rng() * base.colors.length);
        colors = base.colors.filter((_, j) => j !== drop);
      } else if (base.colors.length < 3) {
        const used = new Set(base.colors.map((c) => c.color));
        const avail = pool.filter((p) => !used.has(p.color.color));
        if (avail.length) colors = [...base.colors, avail[Math.floor(rng() * avail.length)].color];
      }
    }

    out.push({
      ...base,
      id: `m${idSeq++}`,
      label: label(colors),
      colors,
      separation,
      dotSize,
      density,
      inkOpacity,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 採点（experiments/discover の検証済みロジック）
//  distinction = 元で離れた画素ペアが描画でも離れているか（Lab 距離の相関, 0..1）
//  variation   = 描画側の平均ペア距離（潰れ検出のガード）
//  網点の高周波は ~40px ブロック平均で除いてから測る（= 知覚される実効トーン/色）。
// ---------------------------------------------------------------------------
function downsampleLab(px: Uint8ClampedArray, w: number, h: number, tw = 40): [number, number, number][] {
  const th = Math.max(1, Math.round((h / w) * tw));
  const cells: [number, number, number][] = [];
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * w) / tw), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / tw));
      const y0 = Math.floor((ty * h) / th), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / th));
      let r = 0, g = 0, b = 0, c = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4; r += px[o]; g += px[o + 1]; b += px[o + 2]; c++;
      }
      cells.push(rgbToLab(r / c, g / c, b / c));
    }
  }
  return cells;
}
function pearson(a: number[], b: number[]): number {
  const n = a.length; if (n === 0) return 0;
  let sa = 0, sb = 0; for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da <= 0 || db <= 0 ? 0 : num / Math.sqrt(da * db);
}

export function scoreRender(
  srcPx: Uint8ClampedArray,
  rendPx: Uint8ClampedArray,
  w: number,
  h: number,
): { distinction: number; variation: number } {
  const src = downsampleLab(srcPx, w, h);
  const rend = downsampleLab(rendPx, w, h);
  const n = Math.min(src.length, rend.length);
  const A: number[] = [], B: number[] = [];
  const rng = makeRng(1234); // 採点は決定的に
  let variationSum = 0, vc = 0;
  for (let k = 0; k < 4000; k++) {
    const i = Math.floor(rng() * n), j = Math.floor(rng() * n);
    if (i === j) continue;
    const sd = Math.hypot(src[i][0] - src[j][0], src[i][1] - src[j][1], src[i][2] - src[j][2]);
    const rd = Math.hypot(rend[i][0] - rend[j][0], rend[i][1] - rend[j][1], rend[i][2] - rend[j][2]);
    A.push(sd); B.push(rd); variationSum += rd; vc++;
  }
  return {
    distinction: Math.max(0, pearson(A, B)),
    variation: vc ? variationSum / vc : 0,
  };
}
