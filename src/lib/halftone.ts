/**
 * ハーフトーン（網点）パターン生成
 *
 * AM モード: ドットサイズが濃度に応じて変化（振幅変調）
 * FM モード: 固定サイズのドットが密度に応じて配置（周波数変調/確率的スクリーニング）
 */

export type HalftoneMode = "am" | "fm";

export interface HalftoneOptions {
  /** ドットの基本サイズ (px) */
  dotSize: number;
  /** スクリーン角度 (度) */
  angle: number;
  /** 濃度スケール (0.5–2.0)。1 がデフォルト */
  density?: number;
  /** ハーフトーンモード。"am" = ドットサイズ変化、"fm" = ドット密度変化 */
  mode?: HalftoneMode;
}

/**
 * AM ハーフトーン: 濃度値 (0-1) をハーフトーンのドット有無に変換する。
 * 指定角度で回転したグリッド上の位置から、
 * そのピクセルがドット内に含まれるかを判定する。
 *
 * @returns 0-1 の値（ドットの不透明度）
 */
export function halftoneAt(
  x: number,
  y: number,
  density: number,
  options: HalftoneOptions
): number {
  const { dotSize, angle } = options;
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // 回転座標系に変換
  const rx = x * cos + y * sin;
  const ry = -x * sin + y * cos;

  // グリッドセル内での相対位置 (-0.5 ~ 0.5)
  const cellX = (rx / dotSize) % 1;
  const cellY = (ry / dotSize) % 1;
  const cx = cellX - Math.round(cellX);
  const cy = cellY - Math.round(cellY);

  // セル中心からの距離（0 ~ ~0.707）
  const dist = Math.sqrt(cx * cx + cy * cy);

  // 濃度スケールを適用し、ドット半径を決定
  const scale = options.density ?? 1;
  const scaled = Math.min(density * scale, 1);
  const radius = Math.sqrt(scaled) * 0.5;

  // ドットの縁をわずかにアンチエイリアス
  const edge = 0.5 / dotSize;
  if (dist < radius - edge) return 1;
  if (dist > radius + edge) return 0;
  return 1 - (dist - (radius - edge)) / (2 * edge);
}

/** セル座標の決定論的ハッシュ → [0, 1) の閾値 */
function cellHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/**
 * FM (周波数変調) ハーフトーン。
 * 固定サイズのドットを濃度に応じた確率で配置する。
 * 暗い部分はドットが密集し、ほぼベタ塗りになる。
 */
function applyFMHalftone(
  densityMap: Float32Array,
  width: number,
  height: number,
  options: HalftoneOptions
): Float32Array {
  const { dotSize, angle } = options;
  const scale = options.density ?? 1;
  const result = new Float32Array(width * height);

  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const cellSize = dotSize;
  // ドット半径 = セルサイズの半分（ドット直径 = セルサイズ）
  // 高濃度でのベタ塗りは solidBlend で処理する
  const dotRadius = dotSize * 0.5;
  const edge = Math.max(0.5, 0.5 / dotSize);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;

      // 回転座標系に変換
      const rx = x * cos + y * sin;
      const ry = -x * sin + y * cos;

      // 回転グリッド上のセル
      const gx = Math.floor(rx / cellSize);
      const gy = Math.floor(ry / cellSize);

      let maxOpacity = 0;

      // このセルと周囲8セルを確認
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = gx + dx;
          const cy = gy + dy;

          // ドット中心（回転座標系）
          const dotRx = (cx + 0.5) * cellSize;
          const dotRy = (cy + 0.5) * cellSize;

          // ピクセルからドット中心への距離
          const distX = rx - dotRx;
          const distY = ry - dotRy;
          const dist = Math.sqrt(distX * distX + distY * distY);

          if (dist > dotRadius + edge) continue;

          // ドット中心を画像座標に逆変換して濃度をサンプリング
          const imgX = Math.round(dotRx * cos - dotRy * sin);
          const imgY = Math.round(dotRx * sin + dotRy * cos);

          let d: number;
          if (imgX >= 0 && imgX < width && imgY >= 0 && imgY < height) {
            d = densityMap[imgY * width + imgX];
          } else {
            d = 0;
          }
          d = Math.min(d * scale, 1);

          // セルのハッシュ閾値と比較してドットの有無を決定
          const threshold = cellHash(cx, cy);
          if (d <= threshold) continue;

          // アンチエイリアスを含む不透明度計算
          let opacity: number;
          if (dist < dotRadius - edge) {
            opacity = 1;
          } else {
            opacity = 1 - (dist - (dotRadius - edge)) / (2 * edge);
          }

          maxOpacity = Math.max(maxOpacity, opacity);
        }
      }

      result[idx] = maxOpacity;
    }
  }

  return result;
}

/**
 * ImageData の濃度マップにハーフトーンを適用し、
 * 結果の不透明度配列 (Float32Array, 0-1) を返す。
 */
export function applyHalftone(
  densityMap: Float32Array,
  width: number,
  height: number,
  options: HalftoneOptions
): Float32Array {
  if (options.mode === "fm") {
    return applyFMHalftone(densityMap, width, height, options);
  }
  // AM モードではドットサイズ変化で濃淡を表現するため +1px シフト
  const amOptions = { ...options, dotSize: options.dotSize + 1 };
  const result = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const density = densityMap[i];
      result[i] = halftoneAt(x, y, density, amOptions);
    }
  }
  return result;
}
