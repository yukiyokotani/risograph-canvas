import type { ImageDataLike } from "./stencil";

/**
 * 用紙の外寸を固定したまま、余白に応じて写真を縮小したレイアウトを返す。
 * margin は縮小後の写真短辺に対する最小余白の割合。用紙形状によって元から余る側は、
 * 指定値より広い余白になる。
 */
export function imageSizeWithMargin(
  width: number,
  height: number,
  margin: number,
  targetAspect?: number,
): {
  width: number;
  height: number;
  photoWidth: number;
  photoHeight: number;
  inset: number;
  offsetX: number;
  offsetY: number;
} {
  let paperWidth = width;
  let paperHeight = height;

  // 用紙外寸は margin=0 のときに確定し、以後は変えない。指定比率へ合わせる場合も、
  // 写真をクロップせず収められる最小の用紙を基準にする。
  if (targetAspect && Number.isFinite(targetAspect) && targetAspect > 0) {
    if (paperWidth / paperHeight < targetAspect) {
      paperWidth = Math.max(paperWidth, Math.round(paperHeight * targetAspect));
    } else {
      paperHeight = Math.max(paperHeight, Math.round(paperWidth / targetAspect));
    }
  }

  const safeMargin = Math.max(0, margin);
  const shortEdge = Math.min(width, height);
  const scale = safeMargin === 0
    ? 1
    : Math.min(
        1,
        paperWidth / (width + 2 * safeMargin * shortEdge),
        paperHeight / (height + 2 * safeMargin * shortEdge),
      );
  // floor にすると丸めで指定余白を下回らない。実画像では数百px以上なので、
  // 縦横比への影響は最大でも1px未満。
  const photoWidth = Math.max(1, Math.floor(width * scale));
  const photoHeight = Math.max(1, Math.floor(height * scale));
  const offsetX = Math.floor((paperWidth - photoWidth) / 2);
  const offsetY = Math.floor((paperHeight - photoHeight) / 2);
  const inset = Math.min(
    offsetX,
    offsetY,
    paperWidth - photoWidth - offsetX,
    paperHeight - photoHeight - offsetY,
  );

  return {
    width: paperWidth,
    height: paperHeight,
    photoWidth,
    photoHeight,
    inset,
    offsetX,
    offsetY,
  };
}

/**
 * 入力画像を余白に応じて縮小して中央へ置き、周囲を透明ピクセルにする。
 * 透明部分は色分解ではインクなしとして扱われ、合成時に用紙色と用紙テクスチャだけが描かれる。
 */
export function addImageMargin(
  source: ImageDataLike,
  margin: number,
  targetAspect?: number,
): ImageDataLike {
  const { width, height, photoWidth, photoHeight, offsetX, offsetY } = imageSizeWithMargin(
    source.width,
    source.height,
    margin,
    targetAspect,
  );
  if (
    width === source.width &&
    height === source.height &&
    photoWidth === source.width &&
    photoHeight === source.height
  ) return source;

  const data = new Uint8ClampedArray(width * height * 4);
  if (photoWidth === source.width && photoHeight === source.height) {
    for (let y = 0; y < source.height; y++) {
      const srcStart = y * source.width * 4;
      const dstStart = ((y + offsetY) * width + offsetX) * 4;
      data.set(source.data.subarray(srcStart, srcStart + source.width * 4), dstStart);
    }
    return { data, width, height };
  }

  // 縮小時はバイリニア補間。処理する画素数は余白が増えるほど減り、用紙外寸も
  // 一定なので、従来の「余白ぶん巨大な配列を作る」方式より負荷が安定する。
  const xScale = source.width / photoWidth;
  const yScale = source.height / photoHeight;
  for (let y = 0; y < photoHeight; y++) {
    const sy = Math.max(0, Math.min(source.height - 1, (y + 0.5) * yScale - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < photoWidth; x++) {
      const sx = Math.max(0, Math.min(source.width - 1, (x + 0.5) * xScale - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const fx = sx - x0;
      const topLeft = (y0 * source.width + x0) * 4;
      const topRight = (y0 * source.width + x1) * 4;
      const bottomLeft = (y1 * source.width + x0) * 4;
      const bottomRight = (y1 * source.width + x1) * 4;
      const dst = ((y + offsetY) * width + x + offsetX) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const top = source.data[topLeft + channel] * (1 - fx) + source.data[topRight + channel] * fx;
        const bottom = source.data[bottomLeft + channel] * (1 - fx) + source.data[bottomRight + channel] * fx;
        data[dst + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { data, width, height };
}
