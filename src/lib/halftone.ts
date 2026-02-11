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
 * AM ハーフトーン: ドット中心の濃度でドットサイズを決定し、常に真円を描画する。
 * 各ピクセルについて周囲のグリッドセルを探索し、
 * セル中心の濃度からドット半径を算出してカバレッジを計算する。
 */
function applyAMHalftone(
  densityMap: Float32Array,
  width: number,
  height: number,
  options: HalftoneOptions
): Float32Array {
  const { angle } = options;
  const scale = options.density ?? 1;
  const result = new Float32Array(width * height);

  const cellSize = options.dotSize + 2;
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // アンチエイリアスの縁幅 (ピクセル単位)
  const edge = 0.5;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;

      // 回転座標系に変換
      const rx = x * cos + y * sin;
      const ry = -x * sin + y * cos;

      // 回転グリッド上のセル座標
      const gx = Math.floor(rx / cellSize);
      const gy = Math.floor(ry / cellSize);

      let maxOpacity = 0;

      // 周囲のセルを探索（最大ドット半径 = 0.5 * cellSize なのでrange=1で十分）
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = gx + dx;
          const cy = gy + dy;

          // ドット中心（回転座標系）
          const dotRx = (cx + 0.5) * cellSize;
          const dotRy = (cy + 0.5) * cellSize;

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
          if (d < 0.001) continue;

          // ドット中心の濃度からドット半径を決定（ピクセル単位）
          const radius = Math.sqrt(d) * 0.5 * cellSize;

          // ピクセルからドット中心への距離
          const distX = rx - dotRx;
          const distY = ry - dotRy;
          const dist = Math.sqrt(distX * distX + distY * distY);

          if (dist > radius + edge) continue;

          // アンチエイリアスを含む不透明度計算
          let opacity: number;
          if (dist < radius - edge) {
            opacity = 1;
          } else {
            opacity = 1 - (dist - (radius - edge)) / (2 * edge);
          }

          maxOpacity = Math.max(maxOpacity, opacity);
        }
      }

      result[idx] = maxOpacity;
    }
  }

  return result;
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

  // サブピクセル透明度補正の強さ (dotRadius < 1px で有効)
  // dotRadius=0 → 1 (全面補正), dotRadius=1 → 0 (補正なし)
  const subPixelBlend = Math.max(0, 1 - dotRadius);

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

      // ドットの影響範囲に応じて探索範囲を動的に決定
      // サブピクセルサイズではドットのアンチエイリアス領域が
      // 複数セルにまたがるため、広い範囲を確認する必要がある
      const searchRange = Math.ceil((dotRadius + edge) / cellSize);
      for (let dy = -searchRange; dy <= searchRange; dy++) {
        for (let dx = -searchRange; dx <= searchRange; dx++) {
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

          // サブピクセル補正: ドットが物理的に小さくできない場合、
          // 透明度で濃度の微細な違いを表現する
          // dotRadius >= 1px では補正なし（均一濃度）
          if (subPixelBlend > 0) {
            opacity *= 1 - subPixelBlend * (1 - Math.sqrt(d));
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
  return applyAMHalftone(densityMap, width, height, options);
}
