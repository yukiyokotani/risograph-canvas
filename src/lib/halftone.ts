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
 * ドットの見かけの大きさ（セルサイズ, px）に応じてスーパーサンプル数を決める。
 * 小さいドットほど 1px あたりのサンプルを増やし、どのドットも同じ形・大きさの
 * 真円として均一に整列して見えるようにする（1 サンプル/px だとドットごとに
 * 画素グリッドとのズレで四角や菱形に化けて「バラつき」が出る）。
 */
function superSamples(cellSize: number): number {
  if (cellSize >= 9) return 2;
  if (cellSize >= 4.5) return 3;
  return 4;
}

/**
 * AM ハーフトーン: ドット中心の濃度でドットサイズを決定し、常に真円を描画する。
 * 各ピクセルを SS×SS のサブサンプルで評価し、真円内に入るサブサンプルの割合を
 * カバレッジとする（アナリティックなアンチエイリアス）。これによりドットサイズに
 * かかわらず均一で滑らかな円が規則正しい格子に整列する。
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

  const SS = superSamples(cellSize);
  const inv = 1 / SS;
  const ss2 = SS * SS;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let covered = 0;

      // ピクセル内を SS×SS 均等サンプル
      for (let syi = 0; syi < SS; syi++) {
        for (let sxi = 0; sxi < SS; sxi++) {
          const px = x + (sxi + 0.5) * inv - 0.5;
          const py = y + (syi + 0.5) * inv - 0.5;

          // 回転座標系に変換
          const rx = px * cos + py * sin;
          const ry = -px * sin + py * cos;

          // 回転グリッド上のセル座標
          const gx = Math.floor(rx / cellSize);
          const gy = Math.floor(ry / cellSize);

          // 周囲セルのドットいずれかに含まれれば被覆
          let inside = false;
          for (let dy = -1; dy <= 1 && !inside; dy++) {
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

              const ddx = rx - dotRx;
              const ddy = ry - dotRy;
              if (ddx * ddx + ddy * ddy <= radius * radius) {
                inside = true;
                break;
              }
            }
          }
          if (inside) covered++;
        }
      }

      result[y * width + x] = covered / ss2;
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
  const dotRadius = dotSize * 0.5;

  const SS = superSamples(cellSize);
  const inv = 1 / SS;
  const ss2 = SS * SS;
  const searchRange = Math.max(1, Math.ceil(dotRadius / cellSize));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let covered = 0;

      for (let syi = 0; syi < SS; syi++) {
        for (let sxi = 0; sxi < SS; sxi++) {
          const px = x + (sxi + 0.5) * inv - 0.5;
          const py = y + (syi + 0.5) * inv - 0.5;

          // 回転座標系に変換
          const rx = px * cos + py * sin;
          const ry = -px * sin + py * cos;

          // 回転グリッド上のセル
          const gx = Math.floor(rx / cellSize);
          const gy = Math.floor(ry / cellSize);

          let inside = false;
          for (let dy = -searchRange; dy <= searchRange && !inside; dy++) {
            for (let dx = -searchRange; dx <= searchRange; dx++) {
              const cx = gx + dx;
              const cy = gy + dy;

              // ドット中心（回転座標系）
              const dotRx = (cx + 0.5) * cellSize;
              const dotRy = (cy + 0.5) * cellSize;

              const ddx = rx - dotRx;
              const ddy = ry - dotRy;
              if (ddx * ddx + ddy * ddy > dotRadius * dotRadius) continue;

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

              inside = true;
              break;
            }
          }
          if (inside) covered++;
        }
      }

      result[y * width + x] = covered / ss2;
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
