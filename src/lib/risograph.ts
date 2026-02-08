/**
 * リソグラフ効果のコアロジック
 *
 * 画像を複数のスポットカラーに色分解し、
 * ハーフトーン処理を施して合成する。
 */

import { hexToRgb, type RGB } from "./color";
import { applyHalftone } from "./halftone";

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
}

/** 色ごとのデフォルトスクリーン角度 */
const DEFAULT_ANGLES = [15, 75, 0, 45, 30, 60, 90, 105];

/** 紙の色 (RGB 0-255) */
const PAPER: RGB = { r: 245, g: 240, b: 232 };

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
  inkRgbs: RGB[]
): Float32Array[] {
  const { data, width, height } = imageData;
  const n = inkRgbs.length;
  const pixelCount = width * height;

  // 各インクの「吸収ベクトル」: (paper - ink) / 255
  const inkDeltas: [number, number, number][] = inkRgbs.map((ink) => [
    (PAPER.r - ink.r) / 255,
    (PAPER.g - ink.g) / 255,
    (PAPER.b - ink.b) / 255,
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
    const tr = ((PAPER.r - data[off]) / 255) * alpha;
    const tg = ((PAPER.g - data[off + 1]) / 255) * alpha;
    const tb = ((PAPER.b - data[off + 2]) / 255) * alpha;

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
 * ソースの ImageData を受け取り、リソグラフ風に加工した ImageData を返す。
 */
export function processRisograph(
  sourceData: ImageData,
  canvas: HTMLCanvasElement,
  options: RisographOptions
): void {
  const { colors, dotSize, misregistration, grain } = options;
  const { width, height } = sourceData;

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d")!;

  // 背景を紙の色で塗りつぶし
  ctx.fillStyle = `rgb(${PAPER.r},${PAPER.g},${PAPER.b})`;
  ctx.fillRect(0, 0, width, height);

  // インク RGB を取得
  const inkRgbs = colors.map((c) => hexToRgb(c.color));

  // NNLS 色分解: 全色の濃度マップを一括生成
  const densityMaps = decomposeColors(sourceData, inkRgbs);

  // 各色レイヤーを処理
  for (let ci = 0; ci < colors.length; ci++) {
    const rgb = inkRgbs[ci];
    const angle =
      colors[ci].angle ?? DEFAULT_ANGLES[ci % DEFAULT_ANGLES.length];

    // ハーフトーンの適用
    const halftoneMap = applyHalftone(densityMaps[ci], width, height, {
      dotSize,
      angle,
    });

    // このレイヤー用のオフスクリーンキャンバスを作成
    const layerCanvas = document.createElement("canvas");
    layerCanvas.width = width;
    layerCanvas.height = height;
    const layerCtx = layerCanvas.getContext("2d")!;
    const layerData = layerCtx.createImageData(width, height);

    for (let i = 0; i < width * height; i++) {
      const offset = i * 4;
      let opacity = halftoneMap[i];

      // グレインノイズの追加
      if (grain > 0) {
        const noise = (Math.random() - 0.5) * grain;
        opacity = Math.max(0, Math.min(1, opacity + noise));
      }

      layerData.data[offset] = rgb.r;
      layerData.data[offset + 1] = rgb.g;
      layerData.data[offset + 2] = rgb.b;
      layerData.data[offset + 3] = Math.round(opacity * 255);
    }

    layerCtx.putImageData(layerData, 0, 0);

    // 版ずれ（misregistration）オフセット
    const offsetX =
      misregistration > 0
        ? (Math.random() - 0.5) * 2 * misregistration
        : 0;
    const offsetY =
      misregistration > 0
        ? (Math.random() - 0.5) * 2 * misregistration
        : 0;

    // multiply ブレンドで合成
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(layerCanvas, offsetX, offsetY);
  }

  // 合成モードをリセット
  ctx.globalCompositeOperation = "source-over";
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
