import type { ImageDataLike } from "./stencil";

/**
 * 写真の短辺に対する割合から、四辺へ追加する余白のピクセル数を返す。
 * 余白は入力画像の外側へ追加するため、写真そのものの解像度は変わらない。
 */
export function imageMarginPixels(
  width: number,
  height: number,
  margin: number,
): number {
  return Math.max(0, Math.round(Math.min(width, height) * margin));
}

/** 写真へ余白を加えたあとの外寸を返す。 */
export function imageSizeWithMargin(
  width: number,
  height: number,
  margin: number,
  targetAspect?: number,
): { width: number; height: number; inset: number; offsetX: number; offsetY: number } {
  const inset = imageMarginPixels(width, height, margin);
  let paperWidth = width + inset * 2;
  let paperHeight = height + inset * 2;

  // 指定比率へ合わせるときは、既存の均等余白を削らずに短い側だけを広げる。
  // 写真はクロップせず、増えた余白の中央へ配置する。
  if (targetAspect && Number.isFinite(targetAspect) && targetAspect > 0) {
    if (paperWidth / paperHeight < targetAspect) {
      paperWidth = Math.max(paperWidth, Math.round(paperHeight * targetAspect));
    } else {
      paperHeight = Math.max(paperHeight, Math.round(paperWidth / targetAspect));
    }
  }

  return {
    width: paperWidth,
    height: paperHeight,
    inset,
    offsetX: Math.floor((paperWidth - width) / 2),
    offsetY: Math.floor((paperHeight - height) / 2),
  };
}

/**
 * 入力画像を中央へ置き、周囲を透明ピクセルで拡張する。
 * 透明部分は色分解ではインクなしとして扱われ、合成時に用紙色と用紙テクスチャだけが描かれる。
 */
export function addImageMargin(
  source: ImageDataLike,
  margin: number,
  targetAspect?: number,
): ImageDataLike {
  const { width, height, inset, offsetX, offsetY } = imageSizeWithMargin(
    source.width,
    source.height,
    margin,
    targetAspect,
  );
  if (inset === 0 && width === source.width && height === source.height) return source;

  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < source.height; y++) {
    const srcStart = y * source.width * 4;
    const dstStart = ((y + offsetY) * width + offsetX) * 4;
    data.set(
      source.data.subarray(srcStart, srcStart + source.width * 4),
      dstStart,
    );
  }
  return { data, width, height };
}
