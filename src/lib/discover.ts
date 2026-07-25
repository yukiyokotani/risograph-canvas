/**
 * Discover — 「写真が映える配色＋点設定」を大量ランダム提示して選ばせる機能の純ロジック。
 *
 * 方針:
 *  - 崩壊（元形状が失われる／色が潰れて識別不能）を避けるため、完全ランダムではなく
 *    実インクのプール＋色相ハーモニー＋定番の当たり combo から制約付きで生成する。
 *  - 生成した候補を小さく描画し、「知覚的な区別の保存」= distinction で採点して並べる。
 *    しきい値で機械的に切らず、ランキング＋多様性で上位を見せて人が選ぶ。
 *  - 点設定は AM 固定。グリッドへ出す値は「見て違いが分かる刻み」だけに絞る
 *    （サムネは renderScale 0.4 なので、dotSize 2 と 3 の差は網点セルで 0.4px しかない）。
 *  - 振り方は画像の性格（明るさのキー・コントラスト・彩度）で変える。暗い写真と
 *    明るい写真では通る領域が正反対で、成立しないパレット型もはっきり違うため。
 *
 * 採点ロジックと各パラメータの当たり領域は experiments/discover（bench.ts の掃引）での
 * 検証結果を移植したもの。
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
// 0.05 刻みの丸めは 2 進小数の誤差が残る（0 + 0.3 → 0.30000000000000004）。
// 署名や重複判定に効くので、ここで刻みの桁に揃えておく。
const roundTo = (step: number, v: number) => +(Math.round(v / step) * step).toFixed(4);

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

/** GCR が効く中立インク（黒を厚めに）。有彩色2色に足して「黒＋2色」を作る。 */
const NEUTRAL_KEYS: (keyof typeof INKS)[] = ["black", "black", "charcoal", "midnight"];
/** 黒紙でだけ活きるインク（明るい色・メタリック）。クリーム紙では消えるので単独では使わない。 */
const LIGHT_KEYS: (keyof typeof INKS)[] = ["white", "silver", "gold"];

const VIVID = VIVID_KEYS.map(toPoolInk);
const FLUOR = FLUOR_KEYS.map(toPoolInk);
const DARK = DARK_KEYS.map(toPoolInk);
const NEUTRAL = NEUTRAL_KEYS.map(toPoolInk);
const LIGHT = LIGHT_KEYS.map(toPoolInk);

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
  // Fl. Yellow + Fl. Blue はプリセットに入ったので、ここでは重複させない
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
  dominantHue: number; // 彩度で重み付けした支配色相（ヒストグラムのピーク）
  mono: boolean;
  /** 明るさの平均 L*。暗い写真と明るい写真で「効く濃度」が正反対なので振り方を変える。 */
  meanL: number;
  /** 明るさの標準偏差 L*。平坦な画像は忠実に分解しても灰色の塊にしかならない。 */
  stdL: number;
}

const HUE_BINS = 12;

export function analyzeSource(px: Uint8ClampedArray, w: number, h: number): SourceStats {
  let cSum = 0, n = 0, lSum = 0, l2Sum = 0;
  // 円環平均だと「オレンジの肌 + 青緑の背景」のような二峰の画像で色相が打ち消し合い、
  // 意味のない方向を指す。彩度加重ヒストグラムのピークを支配色相として使う。
  const bins = new Float32Array(HUE_BINS);
  const step = Math.max(1, Math.floor((w * h) / 4000)); // 最大 ~4000 サンプル
  for (let i = 0; i < w * h; i += step) {
    const o = i * 4;
    const [L, la, lb] = rgbToLab(px[o], px[o + 1], px[o + 2]);
    const c = Math.hypot(la, lb);
    cSum += c; lSum += L; l2Sum += L * L; n++;
    const hue = ((Math.atan2(lb, la) * 180) / Math.PI + 360) % 360;
    bins[Math.floor(hue / (360 / HUE_BINS)) % HUE_BINS] += c;
  }
  const chroma = n ? cSum / n : 0;
  const meanL = n ? lSum / n : 0;
  const stdL = n ? Math.sqrt(Math.max(0, l2Sum / n - meanL * meanL)) : 0;
  // ピーク bin とその両隣で重心を取り、bin 幅（30°）より細かい角度にする
  let peak = 0;
  for (let i = 1; i < HUE_BINS; i++) if (bins[i] > bins[peak]) peak = i;
  const width = 360 / HUE_BINS;
  let vx = 0, vy = 0;
  for (let d = -1; d <= 1; d++) {
    const i = (peak + d + HUE_BINS) % HUE_BINS;
    const ang = ((i + 0.5) * width * Math.PI) / 180;
    vx += bins[i] * Math.cos(ang);
    vy += bins[i] * Math.sin(ang);
  }
  const dominantHue = (Math.atan2(vy, vx) * 180) / Math.PI;
  return { chroma, dominantHue, mono: chroma < 12, meanL, stdL };
}

/** 画像の性格。生成の分岐がここに集約されるようにしておく。 */
const isLowKey = (s: SourceStats) => s.meanL < 42;
const isHighKey = (s: SourceStats) => s.meanL > 68;
const isFlat = (s: SourceStats) => s.stdL < 18;

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

/**
 * 色相スキーム。以前は常に 360/n の等分（＝デュオは必ず補色、トリオは必ず三等分）で、
 * さらにアンカーが毎回ソースの支配色相だったため、1ページの配色が同じ族に染まっていた。
 * スキームとアンカーを候補ごとに引いて、族そのものを散らす。
 */
const DUO_SCHEMES = [
  [0, 180], // 補色
  [0, 150], // スプリット補色
  [0, 210],
  [0, 75], // 類似色 + アクセント
  [0, 105],
];
const TRI_SCHEMES = [
  [0, 120, 240], // 三等分
  [0, 150, 210], // スプリット補色
  [0, 35, 180], // 類似色 + 補色
];

/** 互いに色相の離れた n 色を選ぶ（濁った近似色ペアを避ける）。 */
function pickHarmony(
  rng: () => number,
  pool: PoolInk[],
  n: number,
  baseHue: number | null,
): PoolInk[] {
  const chosen: PoolInk[] = [];
  const exclude = new Set<string>();
  // アンカー: 半分は支配色相、1/4 はその補色（被写体を補色で刷る当たり）、残りは自由
  const anchor =
    baseHue === null
      ? rng() * 360
      : rng() < 0.5
        ? baseHue
        : rng() < 0.5
          ? baseHue + 180
          : rng() * 360;
  const scheme =
    n === 2 ? pick(rng, DUO_SCHEMES) : n === 3 ? pick(rng, TRI_SCHEMES) : null;
  for (let i = 0; i < n; i++) {
    const target = anchor + (scheme ? scheme[i] : (360 / n) * i);
    let attempt = pickNearHue(rng, pool, target, exclude);
    // 既選択と色相が近すぎる場合は再抽選（弾いた色は除外して同じものを引き直さない）
    for (let t = 0; t < 5 && chosen.some((c) => hueDist(c.hue, attempt.hue) < 35); t++) {
      exclude.add(attempt.key);
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
/**
 * グリッドは「見て違いが分かる刻み」だけを使う。サムネは renderScale 0.4 で描くので
 * dotSize 2/3 の差は網点セルにして 0.4px しかなく、タイルとしては同じに見える。
 * 細かい刻みは similar strip（mutate）側の担当。
 */
const DOT_SIZES = [2, 4, 6];
const DENSITIES = [0.9, 1.1, 1.3, 1.5];
const OPACITIES = [0.65, 0.8, 0.95];
/** リソらしい版ずれは常に少しだけ。振っても見えないので発見の軸にはしない。 */
const MISREGISTRATION = 1;

/**
 * 色分解の強さの抽選。写真は忠実側（0 付近）が当たりやすい一方、思い切って
 * グラフィックに倒した絵も Discover の面白さなので、忠実寄りに重みを置きつつ
 * 全域から引く。ただしコントラストの低い画像は忠実に分解しても灰色の塊にしか
 * ならない（足切りでほとんど落ちる）ので、強い側へ重みを移す。
 */
function pickSeparation(rng: () => number, stats?: SourceStats): number {
  const r = rng();
  if (stats && isFlat(stats)) {
    if (r < 0.15) return 0;
    if (r < 0.45) return roundTo(0.05, rangePick(rng, 0.2, 0.45));
    if (r < 0.8) return roundTo(0.05, rangePick(rng, 0.5, 0.75));
    return roundTo(0.05, rangePick(rng, 0.8, 1));
  }
  // 暗い写真は強く分解するとインクが乗りすぎて潰れる（掃引でも高い側はほぼ通らない）
  if (stats && isLowKey(stats)) {
    if (r < 0.55) return 0;
    if (r < 0.85) return roundTo(0.05, rangePick(rng, 0.15, 0.4));
    return roundTo(0.05, rangePick(rng, 0.45, 0.7));
  }
  if (r < 0.4) return 0;
  if (r < 0.65) return roundTo(0.05, rangePick(rng, 0.15, 0.4));
  if (r < 0.85) return roundTo(0.05, rangePick(rng, 0.45, 0.7));
  return roundTo(0.05, rangePick(rng, 0.75, 1));
}

/**
 * 見栄えパラメータの抽選。元画像の性格で「通る領域」がはっきり違うので、
 * experiments/discover/bench.ts の掃引結果に合わせて帯そのものを変える:
 *   暗い写真   … 薄いインク（0.65）は紙に沈んで何も出ない。濃度は低め。
 *   平坦な写真 … 忠実に分解すると灰色の塊。濃度は高め、不透明度も 0.8 以上。
 *   明るい写真 … インク量が足りないので濃度は高め。
 */
function randomParams(rng: () => number, stats: SourceStats) {
  const separation = pickSeparation(rng, stats);
  const densPool: readonly number[] = isLowKey(stats)
    ? [0.9, 1.1]
    : isHighKey(stats) || isFlat(stats)
      ? [1.1, 1.3, 1.5]
      : DENSITIES;
  const opacPool: readonly number[] = isLowKey(stats)
    ? [0.8, 0.95, 0.95] // 暗い写真では 0.95 の通過率が飛び抜けて高い
    : isFlat(stats)
      ? [0.8, 0.95]
      : OPACITIES;
  const density = pick(rng, densPool);
  const inkOpacity = pick(rng, opacPool);
  // ハイライトのクリップ: 効いているか分かる量だけ引く（0.03 は軟らかいニーで消える）。
  // 暗い写真では明部が少なく、効かせるとますます何も出ないので使わない。
  const highlightCutoff =
    isLowKey(stats) || rng() < 0.75 ? 0 : pick(rng, [0.08, 0.2]);
  // paperTexture は固定（DISCOVER_FIXED）なのでここでは振らない
  return {
    separation,
    dotSize: pick(rng, DOT_SIZES),
    density,
    inkOpacity,
    misregistration: MISREGISTRATION,
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
  return (
    `${paletteKey(c)}|${c.separation}|${c.dotSize}|${c.density}|${c.inkOpacity}` +
    `|${c.highlightCutoff}|${c.blackGeneration ?? ""}`
  );
}

/**
 * 黒/グレーの中立インクか（GCR が効く構成かの判定に使う）。
 * 吸収があり Lab 彩度が低いものを中立とみなす（stencil 側と同じ基準）。
 */
function isNeutralInk(c: StencilColor): boolean {
  const { r, g, b } = hexToRgb(c.color);
  const absorb = Math.hypot((255 - r) / 255, (255 - g) / 255, (255 - b) / 255);
  if (absorb < 0.05) return false; // ほぼ白は対象外
  const [, la, lb] = rgbToLab(r, g, b);
  return Math.hypot(la, lb) < 12;
}

/** GCR が効く構成（中立ちょうど1本＋有彩色2本以上）でだけ黒生成量を振る。 */
function pickBlackGeneration(rng: () => number, inks: StencilColor[]): number | undefined {
  let neutral = 0;
  let chromatic = 0;
  for (const c of inks) {
    if (isNeutralInk(c)) neutral++;
    else chromatic++;
  }
  if (neutral !== 1 || chromatic < 2) return undefined;
  return pick(rng, [0.45, 0.7, 0.95]);
}

/** StencilColor（アプリの色）から対応する PoolInk を引く（色文字列で照合）。 */
function poolInkFromColor(color: StencilColor): PoolInk {
  const key = INK_KEYS.find((k) => INKS[k].color === color.color) ?? "blue";
  return toPoolInk(key);
}

let idSeq = 0;
function makeCandidate(
  rng: () => number,
  stats: SourceStats,
  category: DiscoverCategory,
  label: string,
  inks: StencilColor[],
  opts?: { paperColor?: string; invert?: boolean; inkOpacity?: number },
): Candidate {
  const params = randomParams(rng, stats);
  return {
    id: `c${idSeq++}`,
    label,
    category,
    colors: inks,
    paperColor: opts?.paperColor ?? PAPER_CREAM,
    invert: opts?.invert ?? false,
    paperTexture: DISCOVER_FIXED.paperTexture,
    ...params,
    ...(opts?.inkOpacity !== undefined ? { inkOpacity: opts.inkOpacity } : null),
    blackGeneration: pickBlackGeneration(rng, inks),
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

  // 掃引で分かった「その画像では成立しない型」を最初から出さない（スロットの無駄を減らす）:
  //  ・単色は暗い/平坦な写真では成立しない（ベタか灰色の面になる）
  //  ・黒を含むパレット（GCR）と黒紙＋反転は、明るい/平坦な写真では潰れる
  const allowSingle = !isLowKey(stats) && !isFlat(stats);
  const allowDarkPaper = !isHighKey(stats) && !isFlat(stats);
  const allowNeutral = allowDarkPaper;

  // カテゴリ配分（彩度で変える）。mono は単色/サプライズ多め、color はデュオ/トリオ多め。
  const mix = stats.mono
    ? { curated: 0.18, duo: 0.22, tri: 0.08, single: 0.28, surprise: 0.24 }
    : { curated: 0.28, duo: 0.34, tri: 0.16, single: 0.1, surprise: 0.12 };

  const nCurated = Math.round(count * mix.curated);
  let nDuo = Math.round(count * mix.duo);
  const nTri = Math.round(count * mix.tri);
  let nSingle = Math.round(count * mix.single);
  let nSurprise = count - nCurated - nDuo - nTri - nSingle;
  // 出せない型の枠はデュオへ回す（枠を空けたままにしない）
  if (!allowSingle) { nDuo += nSingle; nSingle = 0; }
  if (!allowDarkPaper) { nDuo += nSurprise; nSurprise = 0; }

  // 定番: シャッフルして先頭から（1ページ内で同じ combo を使い回さない）。
  // sort(() => rng() - 0.5) は偏るので Fisher–Yates（seed 固定なら決定的）。
  const curatedShuffled = allowNeutral
    ? [...CURATED]
    : CURATED.filter((c) => !c.keys.some((k) => isNeutralInk(INKS[k])));
  for (let i = curatedShuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [curatedShuffled[i], curatedShuffled[j]] = [curatedShuffled[j], curatedShuffled[i]];
  }
  for (let i = 0; i < Math.min(nCurated, curatedShuffled.length); i++) {
    const c = curatedShuffled[i];
    out.push(makeCandidate(rng, stats, "curated", c.label, c.keys.map((k) => INKS[k])));
  }
  const nameOf = (inks: PoolInk[]) => inks.map((p) => p.color.name).join(" + ");
  // デュオ（ハーモニー）
  for (let i = 0; i < nDuo; i++) {
    const inks = pickHarmony(rng, VIVID, 2, baseHue);
    out.push(makeCandidate(rng, stats, "duo", nameOf(inks), inks.map((p) => p.color)));
  }
  // トリオ。1/3 は「黒 + 有彩色2色」にする（リソの定番だが、有彩色プールだけからは
  // 絶対に出てこない組み合わせ。GCR も効いてグレーが濁らない）。
  for (let i = 0; i < nTri; i++) {
    const inks =
      allowNeutral && rng() < 0.35
        ? [...pickHarmony(rng, VIVID, 2, baseHue), pick(rng, NEUTRAL)]
        : pickHarmony(rng, VIVID, 3, baseHue);
    out.push(makeCandidate(rng, stats, "tri", nameOf(inks), inks.map((p) => p.color)));
  }
  // 単色（蛍光 or 暗色 or 支配色相の近く）。明るいインクはクリーム紙だと消えるので、
  // 引いてしまったら黒紙＋反転へ回す（そこでは主役になる）。
  for (let i = 0; i < nSingle; i++) {
    let usePool = rng() < 0.5 ? FLUOR : rng() < 0.5 ? VIVID : DARK;
    // 黒紙へ回せない画像では、そもそも明るすぎるインクを引かない
    if (!allowDarkPaper) usePool = usePool.filter((p) => p.L <= 75);
    const ink = pickNearHue(rng, usePool.length ? usePool : VIVID, baseHue, new Set());
    const tooLight = allowDarkPaper && ink.L > 75;
    out.push(
      makeCandidate(
        rng,
        stats,
        "single",
        ink.color.name + (tooLight ? " · black paper" : ""),
        [ink.color],
        tooLight ? { paperColor: PAPER_DARK, invert: true, inkOpacity: 0.95 } : undefined,
      ),
    );
  }
  // サプライズ（蛍光/メタリック 1–2色 on 黒紙 + 反転）。不透明度が低いと紙に沈んで
  // 色が出ないので、ここだけは高い側に固定する。
  for (let i = 0; i < nSurprise; i++) {
    const n = rng() < 0.6 ? 1 : 2;
    const inks = pickHarmony(rng, n === 1 ? [...FLUOR, ...LIGHT] : FLUOR, n, baseHue);
    out.push(
      makeCandidate(rng, stats, "surprise", nameOf(inks) + " · black paper", inks.map((p) => p.color), {
        paperColor: PAPER_DARK,
        invert: true,
        inkOpacity: pick(rng, [0.85, 0.95]),
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
 * strip の役目は「1 つの軸を動かしたらどうなるか」を見比べられること。以前は
 * 色の差し替えと separation の揺らぎが点設定の格子スロットに重なって発火していて、
 * どのタイルも複数の軸が同時に動いており、比較にならなかった。スロットの役割を
 * 分ける:
 *   先頭 3 枚      … 色だけ（差し替え / 足す / 引く）。点設定と separation は base のまま
 *   4 枚に 1 枚    … separation だけ
 *   残り           … 点サイズ・濃度・不透明度の格子（色と separation は base のまま）
 * 後半（格子を 1 周した後）は組み合わせも見たいので、色も一緒に動かす。
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
  // 端では clamp すると複数スロットが base と同じ値に潰れて strip が痩せるので、
  // はみ出した分は反対側へ折り返す。
  const fold = (lo: number, hi: number, base_: number, d: number) => {
    const v = base_ + d;
    return clamp(lo, hi, v < lo || v > hi ? base_ - d : v);
  };

  /** separation の近傍。base が端（0 や 1）のときは片側だけを使う。 */
  const sepNeighbors = (() => {
    const deltas = [-0.3, 0.3, -0.15, 0.15];
    const vals = deltas
      .map((d) => roundTo(0.05, base.separation + d))
      .filter((v) => v >= 0 && v <= 1 && v !== base.separation);
    // 端で候補が減ったら、反対側と遠い値で埋める
    for (const v of [0, 0.3, 0.6, 1]) {
      if (vals.length >= 4) break;
      if (v !== base.separation && !vals.includes(v)) vals.push(v);
    }
    return vals;
  })();

  const pool = base.category === "surprise" ? FLUOR : VIVID;
  /** 色を 1 手だけ動かす（0=同系色へ差し替え / 1=1色引く / 2=1色足す）。 */
  const shiftColors = (kind: number): StencilColor[] => {
    if (kind === 0 && base.colors.length >= 1) {
      const idx = Math.floor(rng() * base.colors.length);
      const cur = poolInkFromColor(base.colors[idx]);
      // 中立インク（黒など）は Lab 色相が無意味（≈0°=赤の方向）なので、
      // 同系色を色相で探すと赤に化ける。中立は中立の中で差し替える。
      const near = isNeutralInk(base.colors[idx])
        ? NEUTRAL.filter((p) => p.color.color !== base.colors[idx].color)
        : pool.filter(
            (p) => p.color.color !== base.colors[idx].color && hueDist(p.hue, cur.hue) < 40,
          );
      if (near.length) {
        const repl = near[Math.floor(rng() * near.length)];
        return base.colors.map((c, j) => (j === idx ? repl.color : c));
      }
      return base.colors;
    }
    if (kind === 1 && base.colors.length >= 2) {
      const drop = Math.floor(rng() * base.colors.length);
      return base.colors.filter((_, j) => j !== drop);
    }
    if (base.colors.length < 3) {
      const used = new Set(base.colors.map((c) => c.color));
      const avail = pool.filter((p) => !used.has(p.color.color));
      if (avail.length) return [...base.colors, avail[Math.floor(rng() * avail.length)].color];
    }
    return base.colors;
  };

  const out: Candidate[] = [];
  let gridSlot = 0;
  for (let i = 0; i < count; i++) {
    let colors = base.colors;
    let separation = base.separation;
    let dotSize = base.dotSize;
    let density = base.density;
    let inkOpacity = base.inkOpacity;

    if (i < 3) {
      // 色だけ動かす（点設定は base のまま = パレットの違いだけを見比べられる）
      colors = shiftColors(i);
    } else if (i % 4 === 3) {
      separation = sepNeighbors[Math.floor(i / 4) % sepNeighbors.length];
    } else {
      const [dDot, dDens] = grid[gridSlot % grid.length];
      const round = Math.floor(gridSlot / grid.length);
      gridSlot++;
      dotSize = roundTo(0.5, fold(dotLo, dotHi, base.dotSize, dDot * dotStep));
      density = roundTo(0.05, fold(densLo, densHi, base.density, dDens));
      // 格子を 2 周目以降に使うときは不透明度をずらして同じ見た目にならないようにする
      const opacityShift = round === 0 ? 0 : round % 2 === 1 ? 0.1 : -0.1;
      inkOpacity = clamp(0.6, 0.95, roundTo(0.05, base.inkOpacity + opacityShift));
      // 格子を 1 周した後は、点設定と色の組み合わせも見せる
      if (round > 0 && gridSlot % 3 === 0) colors = shiftColors(gridSlot % 3);
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
  // ブロック平均は「網点の高周波を落とす」ためのもの。セルが網点セル（数 px）と
  // 同じくらいだと点のノイズがそのまま採点に乗り、コントラストの低い写真では
  // 相関がノイズに埋もれて候補が軒並み足切りされる。セル幅は 4px 以上を保つ。
  cells = Math.min(40, Math.floor(w / 4)),
): { distinction: number; variation: number } {
  const src = downsampleLab(srcPx, w, h, cells);
  const rend = downsampleLab(rendPx, w, h, cells);
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
