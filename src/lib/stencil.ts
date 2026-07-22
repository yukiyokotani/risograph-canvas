/**
 * ステンシル印刷効果のコアロジック
 *
 * 画像を複数のスポットカラーに色分解し、
 * ハーフトーン処理を施して合成する。
 */

import { hexToRgb, luminance, type RGB } from "./color";
import { applyHalftone, type HalftoneMode } from "./halftone";

export type { HalftoneMode };
export type ColorMode = "natural" | "bold";

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
  paper: RGB
): Float32Array[] {
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

  const MAX_ITER = 12;
  const densities = new Float64Array(n);

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
    const dotInkTarget = new Float64Array(n);
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
  }

  return maps;
}

/**
 * Bold モード: NNLS 密度マップを後処理し、大胆な色分離を実現する。
 *
 * 1. 競合抑制: 各ピクセルで支配的なインクを強調し、弱いインクを抑制
 * 2. シグモイドコントラスト: 密度値を 0/1 の両極端に押しやる
 */
function applyBoldTransform(maps: Float32Array[], pixelCount: number): void {
  const n = maps.length;
  if (n === 0) return;

  const SUPPRESSION_POWER = 2.0;
  const SIGMOID_GAIN = 6.0;
  const SIGMOID_MID = 0.35;

  // シグモイド正規化: sigmoid(0)=0, sigmoid(1)=1 となるよう再スケール
  const s0 = 1 / (1 + Math.exp(SIGMOID_GAIN * SIGMOID_MID));
  const s1 = 1 / (1 + Math.exp(-SIGMOID_GAIN * (1 - SIGMOID_MID)));
  const sRange = s1 - s0;

  for (let p = 0; p < pixelCount; p++) {
    let maxD = 0;
    for (let i = 0; i < n; i++) {
      if (maps[i][p] > maxD) maxD = maps[i][p];
    }
    if (maxD < 0.01) continue;

    // Phase 1: 競合抑制 — 支配的なインクを残し、弱いインクを抑制
    for (let i = 0; i < n; i++) {
      const ratio = maps[i][p] / maxD;
      maps[i][p] *= Math.pow(ratio, SUPPRESSION_POWER);
    }

    // Phase 2: シグモイドコントラスト — 中間調を減らし、はっきりした色分離に
    for (let i = 0; i < n; i++) {
      const x = maps[i][p];
      if (x < 0.001) { maps[i][p] = 0; continue; }
      const sig = 1 / (1 + Math.exp(-SIGMOID_GAIN * (x - SIGMOID_MID)));
      maps[i][p] = Math.max(0, Math.min(1, (sig - s0) / sRange));
    }
  }
}

/**
 * DOM 非依存のステンシル印刷処理。
 * ソースのピクセルデータを受け取り、加工済みのピクセル配列を返す。
 * Web Worker からも呼び出し可能。
 */
export function computeStencil(
  sourceData: ImageDataLike,
  options: StencilOptions
): Uint8ClampedArray {
  const { colors, dotSize, misregistration, grain, density, inkOpacity = 0.85, paperColor, halftoneMode, colorMode, noise = 0, transparentBg = false, invert = false, renderScale = 1, seed: rngSeed = DEFAULT_SEED } = options;
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

  // 色分解に渡すインクから低吸収インクを除外
  const decompInks: RGB[] = [];
  const decompIndexMap: number[] = []; // decompInks[i] → 元の colors[j]
  for (let i = 0; i < inkRgbs.length; i++) {
    if (!isLowAbsorption[i]) {
      decompIndexMap.push(i);
      decompInks.push(inkRgbs[i]);
    }
  }

  const decompMaps = decompInks.length > 0
    ? decomposeColors(source, decompInks, WHITE)
    : [];

  // 密度マップを組み立て
  const pixelCount = width * height;
  const densityMaps: Float32Array[] = inkRgbs.map(() => new Float32Array(pixelCount));
  // 色分解結果をマッピング
  for (let di = 0; di < decompMaps.length; di++) {
    densityMaps[decompIndexMap[di]] = decompMaps[di];
  }
  // 低吸収インクは輝度ベースで密度を生成
  for (let i = 0; i < inkRgbs.length; i++) {
    if (!isLowAbsorption[i]) continue;
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

  // Bold モード: 密度マップを後処理して大胆な色分離に
  if (colorMode === "bold") {
    applyBoldTransform(densityMaps, width * height);
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
    // 白紙なら pR=pG=pB=0 で乗算結果がそのまま出る（従来と同等）
    if (pR !== 0 || pG !== 0 || pB !== 0) {
      for (let i = 0; i < pixelCount; i++) {
        const invA = 1 - alphaMap[i];
        if (invA < 0.004) continue; // 完全カバー → 乗算結果のまま
        const off = i * 4;
        out[off] = Math.max(0, Math.min(255, Math.round(out[off] + pR * invA)));
        out[off + 1] = Math.max(0, Math.min(255, Math.round(out[off + 1] + pG * invA)));
        out[off + 2] = Math.max(0, Math.min(255, Math.round(out[off + 2] + pB * invA)));
      }
    }
  }

  return out;
}

/**
 * メインのステンシル印刷処理。
 * ソースの ImageData を受け取り、ステンシル印刷風に加工した結果を canvas に描画する。
 */
export function processStencil(
  sourceData: ImageData,
  canvas: HTMLCanvasElement,
  options: StencilOptions
): void {
  const { width, height } = sourceData;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const pixels = computeStencil(sourceData, options);
  const outputData = ctx.createImageData(width, height);
  outputData.data.set(pixels);
  ctx.putImageData(outputData, 0, 0);
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
