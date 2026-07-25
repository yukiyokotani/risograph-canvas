/**
 * ステンシル印刷効果のコアロジック
 *
 * 画像を複数のスポットカラーに色分解し、
 * ハーフトーン処理を施して合成する。
 */

import { hexToRgb, luminance, rgbToLab, type RGB } from "./color";
import { applyHalftone, type HalftoneMode } from "./halftone";

export type { HalftoneMode };
export type ColorMode = "natural" | "bold";
/** 紙テクスチャの種類 */
export type PaperTexture = "none" | "felt" | "fiber";

/** ImageData 互換の軽量インターフェース（Web Worker でも使える） */
export interface ImageDataLike {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface StencilColor {
  /** 色の名前 */
  name: string;
  /** hex カラーコード (#RRGGBB) */
  color: string;
  /** ハーフトーンスクリーン角度（度）。省略時は自動割当 */
  angle?: number;
}

export interface StencilOptions {
  /** スポットカラーの配列 */
  colors: StencilColor[];
  /** ハーフトーンのドットサイズ (px) */
  dotSize: number;
  /** 版ずれのピクセル量 */
  misregistration: number;
  /** グレイン（ノイズ）の強度 0-1 */
  grain: number;
  /** 濃度スケール (0.5–2.0)。デフォルト: 1 */
  density?: number;
  /** インクの不透明度 (0–1)。デフォルト: 0.85。1=完全不透明(source-over)、0=完全透明(multiply) */
  inkOpacity?: number;
  /** 紙の色 (hex)。省略時はデフォルトのクリーム色 */
  paperColor?: string;
  /** ハーフトーンモード。"am" = ドットサイズ変化、"fm" = ドット密度変化 */
  halftoneMode?: HalftoneMode;
  /** 色分解モード。"natural" = 忠実な再現、"bold" = 大胆な色分離 */
  colorMode?: ColorMode;
  /**
   * Bold モードで、使用インクで表現できない色（ガモット外）を非印刷にする強さ (0–1)。
   * 0 = ほぼ切り捨てない、1 = 積極的に非印刷にする。デフォルト: 0.5
   */
  gamutThreshold?: number;
  /**
   * 黒生成（GCR）の強さ (0–1)。黒/グレーの中立インクが1本ある構成でのみ有効。
   * 有彩色が重なって作る「グレー成分」を、この割合だけ中立インク（黒）へ置換する。
   * 0 = 黒をほぼ使わない（有彩色のみ）、1 = 中立部を最大限黒へ。デフォルト: 0.7。
   * 鮮やかな色には黒を入れず、中立色・影ほど黒へ寄せる（実印刷の GCR/UCR に相当）。
   */
  blackGeneration?: number;
  /**
   * ハイライトのクリップ (0–1)。この濃度未満のインクを非印刷にする。
   * ほぼ白（JPEG ノイズや反アリアス等でわずかに色づいた画素）が網点として
   * 散るのを防ぐ。デフォルト: 0（オフ）
   */
  highlightCutoff?: number;
  /** 印刷の掠れノイズ (0–0.5)。各色レイヤーにランダムな欠けを生成。デフォルト: 0 */
  noise?: number;
  /** 背景を透明にする。インク部分のみ残る */
  transparentBg?: boolean;
  /** 入力画像の階調を反転する。暗い紙に明るいインクで刷るときに使用 */
  invert?: boolean;
  /**
   * 描画スケール（デフォルト: 1）。プレビューに対する出力解像度の倍率。
   * ドットサイズ・版ずれ・ノイズなどピクセル単位のパラメータを一律に倍率へ
   * 比例させ、「プレビューをそのまま高解像度にスケールアップ」した結果を得る。
   */
  renderScale?: number;
  /**
   * 版ずれ・グレインの疑似乱数シード（デフォルト: 固定値）。
   * 同じシードならプレビューと出力で版ずれが完全に一致する。
   */
  seed?: number;
  /** 紙テクスチャの種類。デフォルト: "fiber" */
  paperTexture?: PaperTexture;
  /** 紙テクスチャの強さ (0–1)。デフォルト: 0.5。0 または type="none" で無効 */
  paperTextureAmount?: number;
}

/** 掠れノイズ用ハッシュ（セル座標+シード → [0,1)） */
function scuffHash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1013904223) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** バイリニア補間付きスムースノイズ (0–1) */
function smoothNoise(x: number, y: number, cellSize: number, seed: number): number {
  const gx = Math.floor(x / cellSize);
  const gy = Math.floor(y / cellSize);
  const fx = x / cellSize - gx;
  const fy = y / cellSize - gy;

  const n00 = scuffHash(gx, gy, seed);
  const n10 = scuffHash(gx + 1, gy, seed);
  const n01 = scuffHash(gx, gy + 1, seed);
  const n11 = scuffHash(gx + 1, gy + 1, seed);

  // smoothstep 補間
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  return (n00 * (1 - sx) + n10 * sx) * (1 - sy) +
         (n01 * (1 - sx) + n11 * sx) * sy;
}

/** 異方性スムースノイズ（x/y で別セルサイズ）。繊維の向きを作るのに使う。 */
function smoothNoiseAniso(
  x: number,
  y: number,
  cellX: number,
  cellY: number,
  seed: number
): number {
  const gx = Math.floor(x / cellX);
  const gy = Math.floor(y / cellY);
  const fx = x / cellX - gx;
  const fy = y / cellY - gy;
  const n00 = scuffHash(gx, gy, seed);
  const n10 = scuffHash(gx + 1, gy, seed);
  const n01 = scuffHash(gx, gy + 1, seed);
  const n11 = scuffHash(gx + 1, gy + 1, seed);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sy) +
         (n01 * (1 - sx) + n11 * sx) * sy;
}

/**
 * 繊維場: 指定した各方向に細長く伸びた異方性ノイズ（along:繊維長, across:繊維幅）を
 * 重ね、繊維が絡み合う地合いを作る。角度の与え方で「多方向マット（felt）」から
 * 「一方向に流れる漉き紙（fiber）」まで表現を切り替えられる。
 */
function fiberField(
  x: number,
  y: number,
  seed: number,
  angles: number[],
  along: number,
  across: number
): number {
  let f = 0;
  for (let i = 0; i < angles.length; i++) {
    const r = (angles[i] * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const xr = x * c + y * s;
    const yr = -x * s + y * c;
    f += smoothNoiseAniso(xr, yr, along, across, seed + i * 23) - 0.5;
  }
  return f / angles.length;
}

/** 2 オクターブの微細グレイン（紙の tooth）。高周波を混ぜて粒立ちを細かくする。 */
function grain2(x: number, y: number, rs: number, seed: number): number {
  const a = smoothNoise(x, y, Math.max(1.4 * rs, 1), seed) - 0.5;
  const b = smoothNoise(x, y, Math.max(0.7 * rs, 1), seed + 7) - 0.5;
  return a * 0.62 + b * 0.38;
}

/**
 * 散在する暗い斑点（繊維片/夾雑物）。細かい場の上位数%だけを暗点にし、
 * 再生紙のような「ポツポツした繊維片」を表現する。まれに明るい斑点も混ぜる。
 * 戻り値はおおよそ -1〜+0.4（負が暗点）。
 */
function speckField(x: number, y: number, rs: number, seed: number): number {
  const c = Math.max(1.1 * rs, 1);
  let s = 0;
  const n = smoothNoise(x, y, c, seed + 311);
  if (n > 0.9) s -= (n - 0.9) / 0.1; // 上位10%を暗点に
  const n2 = smoothNoise(x, y, c, seed + 913);
  if (n2 > 0.95) s += ((n2 - 0.95) / 0.05) * 0.4; // まれに明点
  return s;
}

/** 縦に引き延ばした尾根状ノイズで、紙の皺（クリンクル）の筋を作る。 */
function crinkle(x: number, y: number, rs: number, seed: number): number {
  const n = smoothNoiseAniso(x, y, 2.4 * rs, 8 * rs, seed + 55);
  return 1 - Math.abs(2 * n - 1) - 0.5; // -0.5〜0.5 の尾根
}

/**
 * 紙テクスチャの明度(l)と暖色ムラ(w)を返す（おおよそ -1〜1）。
 *
 * fiber … 縦の細い繊維＋クリンクルの水彩紙風、felt … 均一な細粒＋繊維片の再生紙風。
 * どちらも微細グレイン（{@link grain2}）と散在する斑点（{@link speckField}）を重ねて
 * 実紙の粒立ちを出し、雲状ムラは脇役に留めて「もや」に見せない。
 * すべての特徴サイズを renderScale 倍にして、プレビューと高解像度出力で見た目を揃える。
 */
function paperTextureAt(
  x: number,
  y: number,
  type: PaperTexture,
  rs: number,
  seed: number
): { l: number; w: number } {
  if (type === "none") return { l: 0, w: 0 };
  const cloud = smoothNoise(x, y, 50 * rs, seed + 1) - 0.5;
  const g = grain2(x, y, rs, seed);
  const sp = speckField(x, y, rs, seed);

  let l: number;
  let speckAmt: number;
  if (type === "fiber") {
    // 水彩紙: 縦の細い繊維（短めで不規則）＋クリンクルの筋
    const fiber = fiberField(x, y, seed, [86, 94, 79], 13 * rs, 1.25 * rs);
    const cr = crinkle(x, y, rs, seed);
    l = fiber * 1.0 + cr * 0.6 + g * 0.55 + cloud * 0.25;
    speckAmt = 0.35;
  } else {
    // felt(再生紙): 均一な細粒＋ゆるい多方向繊維、斑点を強めに
    const fiber = fiberField(x, y, seed, [0, 90, 45, -40], 9 * rs, 2.2 * rs);
    l = g * 0.85 + fiber * 0.6 + cloud * 0.3;
    speckAmt = 1.0;
  }

  // 軽いコントラストで平坦なグレーを避けてから、暗点（斑点）を重ねる
  l = Math.sign(l) * Math.pow(Math.abs(l), 0.92);
  l += sp * speckAmt;
  const w = cloud * 0.5;

  return { l, w };
}

/**
 * リソグラフ標準のスクリーン角度（暗い色から順に割り当てる）。
 *
 * 網点印刷の定石に倣い、最も暗い（＝最も目立つ）色を 45° に置いて
 * ギザつき（sawtooth）とモアレを抑え、以降は 30° 間隔でずらす。
 * 暗い順に 45° → 75° → 15° → 0° を割り当てる（5色目以降は補助角度）。
 */
const RISO_SCREEN_ANGLES = [45, 75, 15, 0, 30, 60, 90, 105];

/** デフォルトの紙の色 (RGB 0-255) */
const DEFAULT_PAPER: RGB = { r: 245, g: 240, b: 232 };

/** 版ずれ・グレインのデフォルトシード。プレビューと出力を一致させるため固定値。 */
const DEFAULT_SEED = 0x5f3759df;

/**
 * 非負最小二乗法 (NNLS) による色分解。
 *
 * 各ピクセルの色を「紙色からの差分（＝インクが吸収すべき量）」として捉え、
 * 各インク色の吸収ベクトルの非負線形結合で近似する。
 *
 *   target ≈ Σ d_i × inkDelta_i   (d_i ≥ 0)
 *
 * 座標降下法で解くため色数が何色でも自動的に対応し、
 * 各インクの色相に応じた濃度マップが生成される。
 */
function decomposeColors(
  imageData: ImageDataLike,
  inkRgbs: RGB[],
  paper: RGB,
  needResidual: boolean
): { maps: Float32Array[]; residuals: Float32Array } {
  const { data, width, height } = imageData;
  const n = inkRgbs.length;
  const pixelCount = width * height;

  // 各インクの「吸収ベクトル」: (paper - ink) / 255
  const inkDeltas: [number, number, number][] = inkRgbs.map((ink) => [
    (paper.r - ink.r) / 255,
    (paper.g - ink.g) / 255,
    (paper.b - ink.b) / 255,
  ]);

  // 事前計算: 各インクペアのドット積
  const dotInkInk = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const dot =
        inkDeltas[i][0] * inkDeltas[j][0] +
        inkDeltas[i][1] * inkDeltas[j][1] +
        inkDeltas[i][2] * inkDeltas[j][2];
      dotInkInk[i * n + j] = dot;
      dotInkInk[j * n + i] = dot;
    }
  }

  // 出力: 各色の濃度マップ
  const maps = inkRgbs.map(() => new Float32Array(pixelCount));
  // 残差マップ: 使用インクの非負結合で表現しきれなかった量（色のガモット外れ度）
  const residuals = new Float32Array(pixelCount);

  const MAX_ITER = 12;
  const RESIDUAL_ITER = 8;
  const densities = new Float64Array(n);
  // 残差用: 濃度上限なし(≥0のみ)の解
  const densitiesU = new Float64Array(n);
  // 画素ループの外で確保する（中で作ると 4x 書き出しで数百万回の確保になる）
  const dotInkTarget = new Float64Array(n);

  for (let p = 0; p < pixelCount; p++) {
    const off = p * 4;
    const alpha = data[off + 3] / 255;
    if (alpha < 0.01) {
      for (let i = 0; i < n; i++) maps[i][p] = 0;
      continue;
    }

    // target = (paper - pixel) / 255 × alpha
    const tr = ((paper.r - data[off]) / 255) * alpha;
    const tg = ((paper.g - data[off + 1]) / 255) * alpha;
    const tb = ((paper.b - data[off + 2]) / 255) * alpha;

    // 各インクと target のドット積
    for (let i = 0; i < n; i++) {
      dotInkTarget[i] =
        inkDeltas[i][0] * tr +
        inkDeltas[i][1] * tg +
        inkDeltas[i][2] * tb;
    }

    // 初期値: 単純射影
    for (let i = 0; i < n; i++) {
      const selfDot = dotInkInk[i * n + i];
      densities[i] =
        selfDot > 1e-10
          ? Math.max(0, Math.min(1, dotInkTarget[i] / selfDot))
          : 0;
    }

    // 座標降下法で反復改善
    for (let iter = 0; iter < MAX_ITER; iter++) {
      for (let i = 0; i < n; i++) {
        let numerator = dotInkTarget[i];
        for (let j = 0; j < n; j++) {
          if (j !== i) numerator -= densities[j] * dotInkInk[i * n + j];
        }
        const selfDot = dotInkInk[i * n + i];
        densities[i] =
          selfDot > 1e-10
            ? Math.max(0, Math.min(1, numerator / selfDot))
            : 0;
      }
    }

    for (let i = 0; i < n; i++) {
      maps[i][p] = densities[i];
    }

    // 残差（ガモット外れ度）: 濃度上限(≤1)による「濃度不足」を誤差に含めないため、
    // 上限なし(≥0のみ)の非負最小二乗を別途解き、その再構成誤差を測る。
    // これにより「色相は表現可能で彩度が高いだけの色」は残差が小さくなり、
    // 「使用インクの非負結合では作れない色相」だけが大きな残差になる。
    if (needResidual) {
      for (let i = 0; i < n; i++) {
        const selfDot = dotInkInk[i * n + i];
        densitiesU[i] = selfDot > 1e-10 ? Math.max(0, dotInkTarget[i] / selfDot) : 0;
      }
      for (let iter = 0; iter < RESIDUAL_ITER; iter++) {
        for (let i = 0; i < n; i++) {
          let numerator = dotInkTarget[i];
          for (let j = 0; j < n; j++) {
            if (j !== i) numerator -= densitiesU[j] * dotInkInk[i * n + j];
          }
          const selfDot = dotInkInk[i * n + i];
          densitiesU[i] = selfDot > 1e-10 ? Math.max(0, numerator / selfDot) : 0;
        }
      }
      let rr = tr;
      let rg = tg;
      let rb = tb;
      for (let i = 0; i < n; i++) {
        rr -= densitiesU[i] * inkDeltas[i][0];
        rg -= densitiesU[i] * inkDeltas[i][1];
        rb -= densitiesU[i] * inkDeltas[i][2];
      }
      residuals[p] = Math.sqrt(rr * rr + rg * rg + rb * rb);
    }
  }

  return { maps, residuals };
}

/**
 * ハイライトのロールオフ（Highlight cutoff スライダ）。
 *
 * しきい値の分だけ濃度を差し引いて残りを引き伸ばす（＝ハイライトを飛ばす）点は
 * 従来と同じだが、**下端の崖をソフトニーにする**:
 *
 *     y = d − cutoff
 *     y ≥ cutoff : soft = y                       … 従来と完全に同じ
 *     それ以外   : soft = (y + cutoff)² / (4·cutoff)  … 0 へ滑らかに接続
 *     d' = soft / (1 − cutoff)
 *
 * 従来は `d ≤ cutoff` を一律 0 にしていたため、ハイライトの細かい濃淡がまとめて
 * 消える一方で元々濃かった画素だけが白地に孤立して残り、階調ではなく
 * 「ぽつぽつしたノイズ」に見えていた。ソフトニーなら薄い所ほど強く小さくなりつつ
 * 点自体は残るので、「たくさんの小さな点でハイライトが飛んでいく」表現になる。
 * ごく薄い画素は網点側の下限（0.001）を下回って消えるため、JPEG ノイズ由来の
 * 点を掃除する従来の役割も保たれる。
 *
 * cutoff の 2 倍以上の濃度では従来と数値が一致し、全体は単調な C1 連続関数。
 * 乗除算だけで書けるので GPU 実装と数値が厳密に一致する。
 */
export function highlightRolloff(d: number, cutoff: number): number {
  if (cutoff <= 0 || cutoff >= 1) return d;
  if (d <= 0) return 0;
  const y = d - cutoff;
  const soft = y >= cutoff ? y : ((y + cutoff) * (y + cutoff)) / (4 * cutoff);
  return soft / (1 - cutoff);
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * 単色インク density → 描画明度(L*) の対応表を作る（レンダラと同じ順モデル）。
 * 白地でインクを乗算し実際の紙色に合成した結果の L* を density 刻みで求める。
 * ガモット外の色を「支配的インク単色で明度を保ったまま」再現する際、目標明度に
 * 一致する単色 density を逆引きするのに使う。
 */
export function buildLightnessTable(
  ink: RGB,
  paper: RGB,
  inkOpacity: number,
  steps = 64
): Float32Array {
  const sR = 1 - ink.r / 255;
  const sG = 1 - ink.g / 255;
  const sB = 1 - ink.b / 255;
  const pR = paper.r / 255;
  const pG = paper.g / 255;
  const pB = paper.b / 255;
  const table = new Float32Array(steps + 1);
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * inkOpacity; // 実効カバレッジ
    const inv = 1 - a;
    const r = ((1 - a * sR) + (pR - 1) * inv) * 255;
    const g = ((1 - a * sG) + (pG - 1) * inv) * 255;
    const b = ((1 - a * sB) + (pB - 1) * inv) * 255;
    table[k] = rgbToLab(r, g, b)[0];
  }
  return table;
}

/**
 * 明度表から目標 L* に一致する density(0-1) を線形補間で逆引きする。
 *
 * 表は紙色から始まりインクを盛るほど変化するので、単調ではあるが向きは一定でない。
 * インクが紙より明るい場合（暗い紙に明るいインクを刷る＝Invert の主用途）は
 * **増加**する。向きを見ずに減少前提で探すと、そのケースで常に 0 を返してしまい、
 * スナップ・黒生成がインクを消してしまう。両方向に対応する。
 */
export function coverageForLightness(table: Float32Array, targetL: number): number {
  const steps = table.length - 1;
  const ascending = table[steps] > table[0];
  if (ascending ? targetL <= table[0] : targetL >= table[0]) return 0;
  if (ascending ? targetL >= table[steps] : targetL <= table[steps]) return 1;
  for (let k = 0; k < steps; k++) {
    const l0 = table[k];
    const l1 = table[k + 1];
    const lo = ascending ? l0 : l1;
    const hi = ascending ? l1 : l0;
    if (targetL >= lo && targetL <= hi) {
      const span = l1 - l0;
      const f = span === 0 ? 0 : (targetL - l0) / span;
      return (k + f) / steps;
    }
  }
  return 1;
}

/**
 * 色分解マップの後処理（Natural / Bold 共通）。
 *
 * 加法 NNLS の密度マップを土台に、「彩度が高く・色相がガモット外で・暗すぎない」＝
 * 混色すると濁って彩度が落ちる色だけ、少数派インクを抑えて支配的インク単色へ寄せ、
 * 明度を保つ（例: 青×ピンクでの緑 → 澄んだ青、暖色の肌 → ピンク）。どのインクへ
 * 寄せるかは加法フィットの配分が決める。中立色・ガモット内の二次色・暗い影は
 * 2 版のまま残す（デュオトーンらしさと影の深さを保つ）。
 *
 * strength: 0 = Natural（濁りだけ除去）, 1〜 = Bold（より積極的に単色分離）。
 */
function applySnapSeparation(
  densityMaps: Float32Array[],
  decompIndex: number[],
  residuals: Float32Array,
  source: ImageDataLike,
  paper: RGB,
  inkRgbs: RGB[],
  inkOpacity: number,
  strength: number
): void {
  if (decompIndex.length < 2) return; // 2 版以上でないと「濁る混色」は起きない

  const m = decompIndex.length;
  const tables = decompIndex.map((idx) =>
    buildLightnessTable(inkRgbs[idx], paper, inkOpacity)
  );
  // 順モデル用の吸収ベクトルと紙色（0-1）
  const sR = decompIndex.map((idx) => 1 - inkRgbs[idx].r / 255);
  const sG = decompIndex.map((idx) => 1 - inkRgbs[idx].g / 255);
  const sB = decompIndex.map((idx) => 1 - inkRgbs[idx].b / 255);
  const pRn = paper.r / 255;
  const pGn = paper.g / 255;
  const pBn = paper.b / 255;

  const b = Math.max(0, strength);
  // ゲートのしきい値（strength が高いほど広く・強く単色化）
  const rLo = 0.12 - 0.05 * b;
  const rHi = 0.34 - 0.1 * b;
  const cLo = 8 - 4 * b;
  const cHi = 22 - 6 * b;
  const scale = 0.85 + 0.15 * Math.min(b, 1);

  const data = source.data;
  const pixelCount = source.width * source.height;
  for (let p = 0; p < pixelCount; p++) {
    const off = p * 4;
    if (data[off + 3] < 3) continue;
    const [Lt, at, bt] = rgbToLab(data[off], data[off + 1], data[off + 2]);
    const Ct = Math.hypot(at, bt);

    const offGamut = smoothstep(rLo, rHi, residuals[p]);
    if (offGamut <= 0) continue;
    const satGate = smoothstep(cLo, cHi, Ct);
    const darkGate = smoothstep(18, 40, Lt); // 深い影は 2 版で暗さを確保
    const snap = offGamut * satGate * darkGate * scale;
    if (snap < 0.02) continue;

    // 現状の 2 版合成色（＝濁った混色）を求める
    let mr = 1, mg = 1, mb = 1, ia = 1;
    for (let t = 0; t < m; t++) {
      const a = densityMaps[decompIndex[t]][p] * inkOpacity;
      mr *= 1 - a * sR[t];
      mg *= 1 - a * sG[t];
      mb *= 1 - a * sB[t];
      ia *= 1 - a;
    }
    const curR = (mr + (pRn - 1) * ia) * 255;
    const curG = (mg + (pGn - 1) * ia) * 255;
    const curB = (mb + (pBn - 1) * ia) * 255;
    const [cl, ca, cb] = rgbToLab(curR, curG, curB);

    // 支配的インク = 現状の混色に「知覚的に最も近い単色」。密度の大小ではなく
    // 現状の色味が既に寄っている側へ純化するので、暖⇄寒を跨いで反転しない。
    let dom = -1;
    let domCov = 0;
    let bestDE = Infinity;
    for (let t = 0; t < m; t++) {
      const cov = coverageForLightness(tables[t], Lt);
      const a = cov * inkOpacity;
      const sr = ((1 - a * sR[t]) + (pRn - 1) * (1 - a)) * 255;
      const sg = ((1 - a * sG[t]) + (pGn - 1) * (1 - a)) * 255;
      const sb = ((1 - a * sB[t]) + (pBn - 1) * (1 - a)) * 255;
      const [sl, sa, sbb] = rgbToLab(sr, sg, sb);
      const de = Math.hypot(sl - cl, sa - ca, sbb - cb);
      if (de < bestDE) { bestDE = de; dom = t; domCov = cov; }
    }
    if (dom < 0) continue;

    // 単色（目標明度に一致）へ snap 分だけ寄せる
    for (let t = 0; t < m; t++) {
      const map = densityMaps[decompIndex[t]];
      const tgt = t === dom ? domCov : 0;
      map[p] = map[p] * (1 - snap) + tgt * snap;
    }
  }
}

/**
 * 2色 × Natural 専用の色分解。加法 NNLS の代わりに、実際の乗算（減法）フォワード
 * モデルへ直接フィットする。分解と描画が同じモデルになるので、ガモット外の色でも
 * 単色化（snap）せず連続的なブレンドで最近色へ収束する（＝ハードな境界が出ない）。
 * 影は両インクの重ね（overprint）へ自然に向かい、二色の階調をフルに使う。
 *
 *   F_c(d) = Π_i(1 − o·d_i·s_ic) + (P_c − 1)·Π_i(1 − o·d_i)   （合成器と同じ順モデル）
 *
 * は各密度についてアフィンなので、各座標の最小二乗解は閉形式。輝度重み付き RGB 距離
 * （超越関数なし＝軽量・CPU/GPU で素直に一致）を使い、NNLS 結果を初期値に数回スイープする。
 */
function applyTwoInkNaturalFit(
  densityMaps: Float32Array[],
  decompIndex: number[],
  source: ImageDataLike,
  paper: RGB,
  inkRgbs: RGB[],
  inkOpacity: number
): void {
  const i0 = decompIndex[0];
  const i1 = decompIndex[1];
  const o = inkOpacity;
  const s0: [number, number, number] = [1 - inkRgbs[i0].r / 255, 1 - inkRgbs[i0].g / 255, 1 - inkRgbs[i0].b / 255];
  const s1: [number, number, number] = [1 - inkRgbs[i1].r / 255, 1 - inkRgbs[i1].g / 255, 1 - inkRgbs[i1].b / 255];
  const P: [number, number, number] = [paper.r / 255, paper.g / 255, paper.b / 255];
  const Y: [number, number, number] = [0.2126, 0.7152, 0.0722];
  const LAMBDA = 3; // 明度（トーン）を優先する重み

  // ink A の密度を、もう片方 (dB, sB) を固定して閉形式で更新する。
  const coord = (
    sA: [number, number, number],
    sB: [number, number, number],
    dB: number,
    T: [number, number, number]
  ): number => {
    let BB = 0, Be0 = 0, yB = 0, ye0 = 0;
    for (let c = 0; c < 3; c++) {
      const Rc = 1 - o * dB * sB[c];
      const U = 1 - o * dB;
      const Ac = Rc + (P[c] - 1) * U;
      const Bc = -o * (sA[c] * Rc + (P[c] - 1) * U);
      const e0 = Ac - T[c];
      BB += Bc * Bc; Be0 += Bc * e0; yB += Y[c] * Bc; ye0 += Y[c] * e0;
    }
    const denom = BB + LAMBDA * yB * yB;
    if (denom <= 1e-9) return 0;
    const d = -(Be0 + LAMBDA * yB * ye0) / denom;
    return d < 0 ? 0 : d > 1 ? 1 : d;
  };

  const map0 = densityMaps[i0];
  const map1 = densityMaps[i1];
  const data = source.data;
  const pixelCount = source.width * source.height;
  const T: [number, number, number] = [0, 0, 0];
  for (let p = 0; p < pixelCount; p++) {
    const off = p * 4;
    const alpha = data[off + 3] / 255;
    if (alpha < 0.01) { map0[p] = 0; map1[p] = 0; continue; }
    // 順モデルと整合する目標色: T = (1−α)·紙 + α·元色
    T[0] = (1 - alpha) * P[0] + (alpha * data[off]) / 255;
    T[1] = (1 - alpha) * P[1] + (alpha * data[off + 1]) / 255;
    T[2] = (1 - alpha) * P[2] + (alpha * data[off + 2]) / 255;
    // NNLS 結果を初期値に座標降下（各座標は閉形式・6 スイープ）
    let d0 = map0[p];
    let d1 = map1[p];
    for (let sweep = 0; sweep < 6; sweep++) {
      d0 = coord(s0, s1, d1, T);
      d1 = coord(s1, s0, d0, T);
    }
    map0[p] = d0;
    map1[p] = d1;
  }
}

/**
 * Bold モードのシグモイドコントラスト。密度の中間調を減らして 0/1 寄りにし、
 * 版ごとのメリハリ（グラフィックな締まり）を強める。単色分離は
 * {@link applySnapSeparation} が担い、ここは明暗コントラストのみを受け持つ。
 */
function applyBoldContrast(maps: Float32Array[], pixelCount: number): void {
  const GAIN = 6.0;
  const MID = 0.35;
  const s0 = 1 / (1 + Math.exp(GAIN * MID));
  const s1 = 1 / (1 + Math.exp(-GAIN * (1 - MID)));
  const sRange = s1 - s0;
  for (let i = 0; i < maps.length; i++) {
    const m = maps[i];
    for (let p = 0; p < pixelCount; p++) {
      const x = m[p];
      if (x < 0.001) { m[p] = 0; continue; }
      const sig = 1 / (1 + Math.exp(-GAIN * (x - MID)));
      m[p] = Math.max(0, Math.min(1, (sig - s0) / sRange));
    }
  }
}

/**
 * 黒生成（GCR: Gray Component Replacement）。
 *
 * 有彩色インクだけで分解した密度マップに対し、「中立（低彩度）な画素ほど」その明度を
 * 中立インク（黒/グレー）で担わせ、有彩色を薄める。一般的な印刷と同じく、
 * 鮮やかな色は黒を使わず（色を殺さない）、グレー・影の部分だけ黒で締める。
 *
 * 各画素で blend = strength × 中立ゲート(彩度が低いほど1)。
 *   黒密度 k = blend × (目標明度に一致する黒単色の被覆)
 *   有彩色密度 ×= (1 − blend)
 * これで有彩色のみ(k=0)と黒単色(目標明度)の間を補間し、明度をおおむね保つ。
 */
function applyBlackGeneration(
  densityMaps: Float32Array[],
  chromaticIndex: number[],
  kIndex: number,
  source: ImageDataLike,
  paper: RGB,
  inkRgbs: RGB[],
  inkOpacity: number,
  strength: number
): void {
  if (strength <= 0) return;
  const kTable = buildLightnessTable(inkRgbs[kIndex], paper, inkOpacity);
  const kMap = densityMaps[kIndex];
  const data = source.data;
  const pixelCount = source.width * source.height;
  for (let p = 0; p < pixelCount; p++) {
    const off = p * 4;
    if (data[off + 3] < 3) continue;
    const [Lt, at, bt] = rgbToLab(data[off], data[off + 1], data[off + 2]);
    const Ct = Math.hypot(at, bt);
    // 中立ゲート: 彩度が低いほど 1（黒を使う）、鮮やかなほど 0（黒を使わない）
    const gate = 1 - smoothstep(6, 26, Ct);
    const blend = strength * gate;
    if (blend < 0.01) continue;
    kMap[p] = blend * coverageForLightness(kTable, Lt);
    for (let t = 0; t < chromaticIndex.length; t++) {
      densityMaps[chromaticIndex[t]][p] *= 1 - blend;
    }
  }
}

/**
 * 各色版の濃度マップとスクリーン角度（色分解〜後処理の結果）。
 * GPU など別の合成器で網点・合成を行うために computeStencil から取り出せる。
 */
export interface InkDensities {
  /** 各色版の濃度マップ（0-1、colors と同じ並び） */
  densityMaps: Float32Array[];
  /** 各色版のスクリーン角度（度、colors と同じ並び） */
  angles: number[];
  /** 紙色 (RGB 0-255) */
  paper: RGB;
  /** インク RGB（colors と同じ並び） */
  inkRgbs: RGB[];
  width: number;
  height: number;
}

/**
 * 色分解〜後処理までを行い、各色版の濃度マップとスクリーン角度だけを返す。
 * 網点・合成は行わないので、GPU 側で合成する場合に CPU コストを払わずに済む。
 * （分解は元ピクセルの純関数なので、網点パラメータを変えても再計算不要＝キャッシュ可能）
 */
export function computeInkDensities(
  sourceData: ImageDataLike,
  options: StencilOptions
): InkDensities {
  let captured: InkDensities | null = null;
  computeStencil(sourceData, options, (d) => { captured = d; }, true);
  if (!captured) throw new Error("failed to compute ink densities");
  return captured;
}

/**
 * DOM 非依存のステンシル印刷処理。
 * ソースのピクセルデータを受け取り、加工済みのピクセル配列を返す。
 * Web Worker からも呼び出し可能。
 *
 * onDensities を渡すと、網点・合成の直前の濃度マップ＋角度を受け取れる
 * （GPU 実装のパリティ検証・移植用。通常の描画結果には影響しない）。
 */
export function computeStencil(
  sourceData: ImageDataLike,
  options: StencilOptions,
  onDensities?: (d: InkDensities) => void,
  densitiesOnly = false
): Uint8ClampedArray {
  const { colors, dotSize, misregistration, grain, density, inkOpacity = 0.85, paperColor, halftoneMode, colorMode, gamutThreshold = 0.5, blackGeneration = 0.7, highlightCutoff = 0, noise = 0, transparentBg = false, invert = false, renderScale = 1, seed: rngSeed = DEFAULT_SEED, paperTexture = "felt", paperTextureAmount = 0.5 } = options;
  const { width, height } = sourceData;
  // ピクセル単位のパラメータを描画スケールへ比例させる（点の相対サイズを保つ）
  const scaledDotSize = dotSize * renderScale;
  const scaledMisreg = misregistration * renderScale;
  const paper = paperColor ? hexToRgb(paperColor) : DEFAULT_PAPER;

  // 階調反転: 暗い紙に明るいインクで刷る場合に使用
  let source = sourceData;
  if (invert) {
    const invData = new Uint8ClampedArray(sourceData.data.length);
    for (let i = 0; i < sourceData.data.length; i += 4) {
      invData[i] = 255 - sourceData.data[i];
      invData[i + 1] = 255 - sourceData.data[i + 1];
      invData[i + 2] = 255 - sourceData.data[i + 2];
      invData[i + 3] = sourceData.data[i + 3]; // alpha はそのまま
    }
    source = { data: invData, width, height };
  }

  // インク RGB を取得
  const inkRgbs = colors.map((c) => hexToRgb(c.color));

  // 色分解は常にホワイト基準（暗い紙でも正しく濃度マップを生成するため）
  const WHITE: RGB = { r: 255, g: 255, b: 255 };

  // 白に近いインク（吸収ベクトルが小さすぎる）を検出
  // これらは色分解では正しく密度が出ないため、輝度ベースで直接生成する
  const ABSORPTION_THRESHOLD = 0.05; // 吸収ベクトルの大きさがこれ以下なら輝度ベース
  const isLowAbsorption = inkRgbs.map((ink) => {
    const dR = (255 - ink.r) / 255;
    const dG = (255 - ink.g) / 255;
    const dB = (255 - ink.b) / 255;
    return Math.sqrt(dR * dR + dG * dG + dB * dB) < ABSORPTION_THRESHOLD;
  });

  // 単色（1インク）は色合わせが破綻する: 黒以外は「そのインク色が元画像にある画素だけ濃く」
  // なり、それ以外は均一に潰れて絵の構造が消える（黒だけ吸収がニュートラルなので偶然うまくいく）。
  // 単色のときは低吸収インクと同じく輝度ベースで密度を作り、どのインク色でも「そのインク色の
  // モノクローム」になるようにする。複数色の分解パス（NNLS→snap→GCR）は一切変えない。
  const singleInk = inkRgbs.length === 1;
  const useLuminance = inkRgbs.map((_, i) => isLowAbsorption[i] || singleInk);

  // 中立（無彩色）インク＝黒/グレーを検出。GCR で「グレー成分」を担わせる。
  const NEUTRAL_CHROMA = 12; // Lab 彩度がこれ未満なら中立インクとみなす
  const isNeutral = inkRgbs.map((ink, i) => {
    if (useLuminance[i]) return false;
    const [, a, b] = rgbToLab(ink.r, ink.g, ink.b);
    return Math.hypot(a, b) < NEUTRAL_CHROMA;
  });
  const neutralIdx: number[] = [];
  let chromaticCount = 0;
  for (let i = 0; i < inkRgbs.length; i++) {
    if (useLuminance[i]) continue;
    if (isNeutral[i]) neutralIdx.push(i);
    else chromaticCount++;
  }
  // GCR は「中立インクがちょうど1本 + 有彩色2本以上」のときだけ有効（黒/グレー付き構成）
  const useGCR = neutralIdx.length === 1 && chromaticCount >= 2 && blackGeneration > 0;
  const kIndex = useGCR ? neutralIdx[0] : -1;

  // 色分解に渡すインク: 低吸収インクと、GCR 時の中立インク（黒）を除外
  const decompInks: RGB[] = [];
  const decompIndexMap: number[] = []; // decompInks[i] → 元の colors[j]
  for (let i = 0; i < inkRgbs.length; i++) {
    if (useLuminance[i]) continue;
    if (useGCR && i === kIndex) continue; // 黒は分解に入れず GCR で生成
    decompIndexMap.push(i);
    decompInks.push(inkRgbs[i]);
  }

  const pixelCount = width * height;
  // 2色 Natural は乗算モデルへ直接フィットするので snap を通らない（＝残差を使わない）。
  // 残差は上限なし NNLS を別途 8 回まわして求めるので、要るときだけ計算する。
  const useTwoInkFit =
    colorMode !== "bold" && inkRgbs.length === 2 && decompIndexMap.length === 2;
  const needResidual = !useTwoInkFit && decompIndexMap.length >= 2;
  const decomp = decompInks.length > 0
    ? decomposeColors(source, decompInks, WHITE, needResidual)
    : { maps: [] as Float32Array[], residuals: new Float32Array(pixelCount) };
  const decompMaps = decomp.maps;
  const residuals = decomp.residuals;

  // 密度マップを組み立て
  const densityMaps: Float32Array[] = inkRgbs.map(() => new Float32Array(pixelCount));
  // 色分解結果をマッピング
  for (let di = 0; di < decompMaps.length; di++) {
    densityMaps[decompIndexMap[di]] = decompMaps[di];
  }
  // 低吸収インク・単色は輝度ベースで密度を生成（暗いほど濃く＝そのインク色のモノクローム）
  for (let i = 0; i < inkRgbs.length; i++) {
    if (!useLuminance[i]) continue;
    const map = densityMaps[i];
    for (let p = 0; p < pixelCount; p++) {
      const off = p * 4;
      const a = source.data[off + 3] / 255;
      // 輝度 (Rec. 709)
      const lum = (0.2126 * source.data[off] + 0.7152 * source.data[off + 1] + 0.0722 * source.data[off + 2]) / 255;
      // 暗いほど密度が高い（白紙上の吸収モデルに合わせる）
      map[p] = (1 - lum) * a;
    }
  }

  // 色分解の後処理: ガモット外の彩度高色を「混色の濁り」ではなく支配的インク単色へ
  // 寄せて明度・彩度を保つ（緑→澄んだ青 等）。Natural でも濁りを除去し、Bold はより
  // 積極的に分離する。Bold の分離強度は gamutThreshold（0-1）で調整できる。
  if (useTwoInkFit) {
    // 2色 × Natural: 加法 NNLS の代わりに乗算モデルへ直接フィット（snap 不要・連続）。
    // Bold・3色以上・GCR 構成には触れない（従来の snap を使う）。
    applyTwoInkNaturalFit(densityMaps, decompIndexMap, source, paper, inkRgbs, inkOpacity);
  } else if (decompIndexMap.length >= 2) {
    const strength = colorMode === "bold" ? 0.5 + gamutThreshold : 0;
    applySnapSeparation(
      densityMaps, decompIndexMap, residuals, source, paper, inkRgbs, inkOpacity, strength
    );
  }
  // 黒生成（GCR）: 有彩色分解の上に、中立な画素ほど黒で明度を担わせ有彩色を薄める。
  // 鮮やかな色は黒を使わず色を保ち、グレー・影だけ黒で締める（実印刷の黒の使い方）。
  if (useGCR) {
    applyBlackGeneration(
      densityMaps, decompIndexMap, kIndex, source, paper, inkRgbs, inkOpacity, blackGeneration
    );
  }
  // Bold: 版ごとの明暗コントラストを強めてグラフィックな締まりを出す
  if (colorMode === "bold") {
    applyBoldContrast(densityMaps, pixelCount);
  }

  // ハイライトのクリップ（レベル補正）: しきい値未満のごく低い濃度（ほぼ白）を 0 にして、
  // わずかに色づいた画素が網点として散る（端のノイズ）のを防ぐ。
  // 単純な 0 クリップだと、しきい値直上の濃度がいきなり中サイズのドットになり、
  // ハイライトの階調が「ドットの有無（密度）」で表現されてしまう。
  // 代わりに [cutoff, 1] を [0, 1] へ線形リマップし、しきい値直上を極小ドットから
  // 滑らかにサイズ成長させる（＝ AM のサイズ変調でハイライトの勾配を表現する）。
  if (highlightCutoff > 0 && highlightCutoff < 1) {
    for (let ci = 0; ci < densityMaps.length; ci++) {
      const m = densityMaps[ci];
      for (let p = 0; p < pixelCount; p++) {
        m[p] = highlightRolloff(m[p], highlightCutoff);
      }
    }
  }

  // スクリーン角度を色の暗さ順に割り当てる（リソグラフの定石）。
  // 最も暗い色に 45° を与え、以降は暗い順に RISO_SCREEN_ANGLES を割り当てる。
  const autoAngles = new Array<number>(colors.length);
  colors
    .map((_, i) => i)
    .sort(
      (a, b) =>
        luminance(inkRgbs[a].r, inkRgbs[a].g, inkRgbs[a].b) -
          luminance(inkRgbs[b].r, inkRgbs[b].g, inkRgbs[b].b) || a - b
    )
    .forEach((colorIdx, rank) => {
      autoAngles[colorIdx] =
        RISO_SCREEN_ANGLES[rank % RISO_SCREEN_ANGLES.length];
    });

  // GPU パイプライン等へ濃度マップ＋角度を引き渡す（描画結果には影響しない）。
  // densitiesOnly のときはここで打ち切り、重い網点・合成を行わない
  // （GPU 側で合成するため CPU の網点コストを払わないようにする）。
  if (onDensities) {
    onDensities({
      densityMaps,
      angles: colors.map((c, ci) => c.angle ?? autoAngles[ci]),
      paper,
      inkRgbs,
      width,
      height,
    });
    if (densitiesOnly) return new Uint8ClampedArray(0);
  }

  // Phase 1: インク同士を乗算（減法混色）で合成するバッファ（白ベース）
  // Phase 2 で紙の色に source-over で合成する
  const out = new Uint8ClampedArray(pixelCount * 4);
  // 乗算バッファ: 白紙上のインク透過率を蓄積（255 = 完全透過）
  for (let i = 0; i < pixelCount; i++) {
    const off = i * 4;
    out[off] = 255;
    out[off + 1] = 255;
    out[off + 2] = 255;
    out[off + 3] = 255;
  }
  // インクカバレッジ蓄積用（アルファ合成で union を取る）
  const alphaMap = new Float32Array(pixelCount);

  // 各色レイヤーを乗算で合成（インク同士の減法混色）
  for (let ci = 0; ci < colors.length; ci++) {
    const rgb = inkRgbs[ci];
    const angle = colors[ci].angle ?? autoAngles[ci];

    // ハーフトーンの適用（ドットサイズは描画スケールに比例）
    const halftoneMap = applyHalftone(densityMaps[ci], width, height, {
      dotSize: scaledDotSize,
      angle,
      density,
      mode: halftoneMode,
    });

    // 掠れノイズ: インクの色乗りムラをシミュレート
    // noise パラメータが大きいほど広域な色ムラが広がる
    if (noise > 0) {
      const seed = ci * 7919 + 31;
      // ノイズレベルに応じてムラのスケールを拡大（描画スケールに比例）
      const baseSize = Math.max(scaledDotSize * 4, 8 * renderScale);
      const scuffSize1 = baseSize * (1 + noise * 8);    // 細かいムラ
      const scuffSize2 = scuffSize1 * 3;                 // 中域のムラ
      const scuffSize3 = scuffSize2 * 3;                 // 広域のムラ
      for (let i = 0; i < width * height; i++) {
        if (halftoneMap[i] < 0.004) continue;
        const px = i % width;
        const py = (i / width) | 0;
        // 3オクターブのノイズを合成
        const n1 = smoothNoise(px, py, scuffSize1, seed);
        const n2 = smoothNoise(px, py, scuffSize2, seed + 997);
        const n3 = smoothNoise(px, py, scuffSize3, seed + 2003);
        const n = n1 * 0.3 + n2 * 0.4 + n3 * 0.3;
        // 全ピクセルに対して色ムラを適用
        // n=0.5 が平均で、そこからの偏差で減衰量を決定
        // noise が大きいほど減衰の振れ幅が大きい
        const deviation = (0.5 - n) * 2;  // -1 〜 +1
        if (deviation > 0) {
          // deviation > 0 の領域で色が薄くなる
          const attenuation = 1 - deviation * noise * 2;
          halftoneMap[i] *= Math.max(0, attenuation);
        }
      }
    }

    // 版ずれ（misregistration）オフセット
    // シード化した決定論的な値を使い、プレビューと出力で完全に一致させる。
    // 量は描画スケールに比例させる（高解像度でも見た目の版ずれ量は同じ）。
    const ox =
      scaledMisreg > 0
        ? Math.round((scuffHash(ci, 0, rngSeed) - 0.5) * 2 * scaledMisreg)
        : 0;
    const oy =
      scaledMisreg > 0
        ? Math.round((scuffHash(ci, 1, rngSeed) - 0.5) * 2 * scaledMisreg)
        : 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // 版ずれを考慮したソース座標
        const srcX = x - ox;
        const srcY = y - oy;
        if (srcX < 0 || srcX >= width || srcY < 0 || srcY >= height) continue;

        let opacity = halftoneMap[srcY * width + srcX];

        // グレインノイズの追加（シード化して決定論的に）
        if (grain > 0) {
          opacity = Math.max(
            0,
            Math.min(1, opacity + (scuffHash(x, y, rngSeed + 101) - 0.5) * grain)
          );
        }

        if (opacity < 0.004) continue;

        // インク合成 (乗算ブレンド — インク同士の減法混色)
        const dstOff = (y * width + x) * 4;
        const a = opacity * inkOpacity;

        // 透過率: 1 - (カバレッジ × 吸収率)
        const tR = 1 - a * (1 - rgb.r / 255);
        const tG = 1 - a * (1 - rgb.g / 255);
        const tB = 1 - a * (1 - rgb.b / 255);

        out[dstOff] = Math.round(out[dstOff] * tR);
        out[dstOff + 1] = Math.round(out[dstOff + 1] * tG);
        out[dstOff + 2] = Math.round(out[dstOff + 2] * tB);

        // カバレッジの union（α合成）
        const pi = y * width + x;
        alphaMap[pi] = 1 - (1 - alphaMap[pi]) * (1 - a);
      }
    }
  }

  // Phase 2: 乗算結果（白紙上のインク混色）を実際の紙色に合成
  // 公式: out = inkBuf + (paper - 255) * (1 - alpha)
  //   - 白紙 (255) の場合: out = inkBuf（乗算結果そのまま）
  //   - 黒紙 (0) の場合: インクのない部分 (alpha=0) は黒、インクのある部分は色が出る
  if (transparentBg) {
    for (let i = 0; i < pixelCount; i++) {
      const a = alphaMap[i];
      const off = i * 4;
      if (a < 0.004) {
        out[off] = 0;
        out[off + 1] = 0;
        out[off + 2] = 0;
        out[off + 3] = 0;
      } else {
        // インク色を抽出: C = (inkBuf - 255*(1-a)) / a
        const inv = 255 * (1 - a);
        out[off] = Math.max(0, Math.round((out[off] - inv) / a));
        out[off + 1] = Math.max(0, Math.round((out[off + 1] - inv) / a));
        out[off + 2] = Math.max(0, Math.round((out[off + 2] - inv) / a));
        out[off + 3] = Math.round(a * 255);
      }
    }
  } else {
    const pR = paper.r - 255;
    const pG = paper.g - 255;
    const pB = paper.b - 255;
    // 紙テクスチャ: 紙が見える部分（インクの無い所）に明度ムラを加える
    const texOn = paperTexture !== "none" && paperTextureAmount > 0;
    const texAmp = paperTextureAmount * 18; // amount=1 で ±18 程度の明度振れ
    // 白紙かつテクスチャ無しなら乗算結果がそのまま出る（従来と同等）
    if (pR !== 0 || pG !== 0 || pB !== 0 || texOn) {
      for (let i = 0; i < pixelCount; i++) {
        const invA = 1 - alphaMap[i];
        if (invA < 0.004) continue; // 完全カバー → 乗算結果のまま
        const off = i * 4;
        let addR = pR * invA;
        let addG = pG * invA;
        let addB = pB * invA;
        if (texOn) {
          const x = i % width;
          const y = (i / width) | 0;
          const { l, w } = paperTextureAt(x, y, paperTexture, renderScale, rngSeed);
          const t = l * texAmp * invA;
          const wt = w * texAmp * 0.4 * invA; // 暖色ムラ: R を上げ B を下げる
          addR += t + wt;
          addG += t;
          addB += t - wt;
        }
        out[off] = Math.max(0, Math.min(255, Math.round(out[off] + addR)));
        out[off + 1] = Math.max(0, Math.min(255, Math.round(out[off + 1] + addG)));
        out[off + 2] = Math.max(0, Math.min(255, Math.round(out[off + 2] + addB)));
      }
    }
  }

  return out;
}

/**
 * 画像を読み込んで ImageData を取得する
 */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(
        new Error(
          "Failed to load image. External URLs may be blocked by CORS policy — try uploading the file instead."
        )
      );
    img.src = src;
  });
}

/**
 * HTMLImageElement から ImageData を取得する
 */
export function getImageData(
  img: HTMLImageElement,
  width?: number,
  height?: number
): ImageData {
  const w = width ?? img.naturalWidth;
  const h = height ?? img.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}
