/**
 * リソグラフ効果のコアロジック
 *
 * 画像を複数のスポットカラーに色分解し、
 * ハーフトーン処理を施して合成する。
 */

import { hexToRgb, type RGB } from "./color";
import { applyHalftone, type HalftoneMode } from "./halftone";

export type { HalftoneMode };

export interface RisographColor {
  /** 色の名前 */
  name: string;
  /** hex カラーコード (#RRGGBB) */
  color: string;
  /** ハーフトーンスクリーン角度（度）。省略時は自動割当 */
  angle?: number;
}

export interface RisographOptions {
  /** スポットカラーの配列 */
  colors: RisographColor[];
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
  /** 印刷の掠れノイズ (0–0.5)。各色レイヤーにランダムな欠けを生成。デフォルト: 0 */
  noise?: number;
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

/** 色ごとのデフォルトスクリーン角度 */
const DEFAULT_ANGLES = [15, 75, 0, 45, 30, 60, 90, 105];

/** デフォルトの紙の色 (RGB 0-255) */
const DEFAULT_PAPER: RGB = { r: 245, g: 240, b: 232 };

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
  imageData: ImageData,
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
 * メインのリソグラフ処理。
 * ソースの ImageData を受け取り、リソグラフ風に加工した結果を canvas に描画する。
 *
 * 色分解はホワイト基準で行い、インクは source-over（不透明）で合成する。
 * これにより暗い紙色でもインクが正しく表示される。
 */
export function processRisograph(
  sourceData: ImageData,
  canvas: HTMLCanvasElement,
  options: RisographOptions
): void {
  const { colors, dotSize, misregistration, grain, density, inkOpacity = 0.85, paperColor, halftoneMode, noise = 0 } = options;
  const { width, height } = sourceData;
  const paper = paperColor ? hexToRgb(paperColor) : DEFAULT_PAPER;

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d")!;

  // インク RGB を取得
  const inkRgbs = colors.map((c) => hexToRgb(c.color));

  // 色分解は常にホワイト基準（暗い紙でも正しく濃度マップを生成するため）
  const WHITE: RGB = { r: 255, g: 255, b: 255 };
  const densityMaps = decomposeColors(sourceData, inkRgbs, WHITE);

  // 出力バッファを紙の色で初期化
  const outputData = ctx.createImageData(width, height);
  const out = outputData.data;
  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    out[off] = paper.r;
    out[off + 1] = paper.g;
    out[off + 2] = paper.b;
    out[off + 3] = 255;
  }

  // 各色レイヤーを source-over で合成
  for (let ci = 0; ci < colors.length; ci++) {
    const rgb = inkRgbs[ci];
    const angle =
      colors[ci].angle ?? DEFAULT_ANGLES[ci % DEFAULT_ANGLES.length];

    // ハーフトーンの適用
    const halftoneMap = applyHalftone(densityMaps[ci], width, height, {
      dotSize,
      angle,
      density,
      mode: halftoneMode,
    });

    // 掠れノイズ: 各色レイヤーにランダムな欠けを生成
    if (noise > 0) {
      const scuffSize = Math.max(dotSize * 3, 6);
      const seed = ci * 7919 + 31;
      for (let i = 0; i < width * height; i++) {
        if (halftoneMap[i] < 0.004) continue;
        const px = i % width;
        const py = (i / width) | 0;
        const n = smoothNoise(px, py, scuffSize, seed);
        if (n < noise) {
          halftoneMap[i] = 0;
        }
      }
    }

    // 版ずれ（misregistration）オフセット
    const ox =
      misregistration > 0
        ? Math.round((Math.random() - 0.5) * 2 * misregistration)
        : 0;
    const oy =
      misregistration > 0
        ? Math.round((Math.random() - 0.5) * 2 * misregistration)
        : 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // 版ずれを考慮したソース座標
        const srcX = x - ox;
        const srcY = y - oy;
        if (srcX < 0 || srcX >= width || srcY < 0 || srcY >= height) continue;

        let opacity = halftoneMap[srcY * width + srcX];

        // グレインノイズの追加
        if (grain > 0) {
          opacity = Math.max(
            0,
            Math.min(1, opacity + (Math.random() - 0.5) * grain)
          );
        }

        if (opacity < 0.004) continue;

        // インク合成 (乗算ブレンド)
        // 各インクは半透明フィルタとして光を吸収する。
        // absorption = 1 - ink/255 (各チャンネルの吸収率)
        // inkOpacity で吸収の強さを調整し、opacity (ドットカバレッジ) で適用範囲を制御。
        // 乗算は可換なため色の順序に依存しない。
        const dstOff = (y * width + x) * 4;
        const prevR = out[dstOff];
        const prevG = out[dstOff + 1];
        const prevB = out[dstOff + 2];

        const f = inkOpacity;

        // 透過率: 1 - (ドットカバレッジ × インク濃度 × 吸収率)
        const tR = 1 - opacity * f * (1 - rgb.r / 255);
        const tG = 1 - opacity * f * (1 - rgb.g / 255);
        const tB = 1 - opacity * f * (1 - rgb.b / 255);

        out[dstOff] = Math.round(prevR * tR);
        out[dstOff + 1] = Math.round(prevG * tG);
        out[dstOff + 2] = Math.round(prevB * tB);
      }
    }
  }

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
