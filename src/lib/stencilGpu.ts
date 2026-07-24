// WebGPU ステンシル合成器のインターフェース。
// renderStencilWebGPU は GPT-5.6 Sol (Codex) が実装する。
// 入力の濃度マップ＋角度から、CPU 実装(halftone.ts / stencil.ts の合成)と同じ数式で
// AM/FM 網点スクリーニング＋白地乗算＋紙 source-over 合成を行い、RGBA ピクセルを返す。

export interface RGB { r: number; g: number; b: number }

export interface GpuStencilInput {
  /** 各色版の濃度マップ（0-1、length = width*height）。並びは inkRgbs と一致。 */
  densityMaps: Float32Array[];
  /** 各色版のスクリーン角度（度） */
  angles: number[];
  /** 各色版のインク RGB (0-255) */
  inkRgbs: RGB[];
  /** 紙色 (0-255) */
  paper: RGB;
  width: number;
  height: number;
  /** AM: cellSize = dotSize + 2 / FM: cellSize = dotSize, dotRadius = dotSize/2 */
  dotSize: number;
  /** 濃度スケール（density スライダ相当） */
  density: number;
  /** インク不透明度 (0-1) */
  inkOpacity: number;
  halftoneMode: "am" | "fm";
  /** true なら紙を落としインクのみ（アルファ付き）を返す */
  transparentBg: boolean;

  // --- 以下は CPU 実装(stencil.ts)と同じ数式で再現するエフェクト ---
  /** 版ずれ量(px, renderScale 適用済み)。0 で無効 */
  misregistration: number;
  /** グレイン強度 0-1。0 で無効 */
  grain: number;
  /** 掠れノイズ 0-0.5。0 で無効 */
  noise: number;
  /** 版ずれ・グレイン・テクスチャの疑似乱数シード */
  seed: number;
  /** 紙テクスチャの種類 */
  paperTexture: "none" | "felt" | "fiber";
  /** 紙テクスチャの強さ 0-1 */
  paperTextureAmount: number;
  /** 描画スケール（テクスチャの特徴サイズに比例させる） */
  renderScale: number;
}

export interface GpuComposeBufferInput {
  /** Ink-major f32 storage. The caller owns this buffer. */
  densityBuffer: GPUBuffer;
  inkCount: number;
  angles: number[];
  inkRgbs: RGB[];
  paper: RGB;
  width: number;
  height: number;
  dotSize: number;
  density: number;
  inkOpacity: number;
  halftoneMode: "am" | "fm";
  transparentBg: boolean;
  misregistration: number;
  grain: number;
  noise: number;
  seed: number;
  paperTexture: "none" | "felt" | "fiber";
  paperTextureAmount: number;
  renderScale: number;
}

/** RGBA 8bit ピクセル (length = width*height*4) を返す。 */
export async function compositeFromDensityBuffer(
  _device: GPUDevice,
  _input: GpuComposeBufferInput
): Promise<Uint8ClampedArray> {
  const device = _device;
  const input = _input;
  const {
    densityBuffer,
    inkCount,
    angles,
    inkRgbs,
    paper,
    width,
    height,
    dotSize,
    density,
    inkOpacity,
    halftoneMode,
    transparentBg,
    misregistration,
    grain,
    noise,
    seed,
    paperTexture,
    paperTextureAmount,
    renderScale,
  } = input;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new Error("width and height must be non-negative integers");
  }
  if (!Number.isInteger(inkCount) || inkCount < 0) {
    throw new Error("inkCount must be a non-negative integer");
  }
  if (inkCount !== angles.length || inkCount !== inkRgbs.length) {
    throw new Error("inkCount, angles, and inkRgbs must have the same value");
  }

  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount)) {
    throw new Error("image dimensions are too large");
  }
  if (pixelCount === 0) return new Uint8ClampedArray();
  if (!(dotSize > 0) || !Number.isFinite(dotSize)) {
    throw new Error("dotSize must be a positive finite number");
  }

  const cellSize = halftoneMode === "am" ? dotSize + 2 : dotSize;
  const dotRadius = dotSize * 0.5;
  const ss = cellSize >= 9 ? 2 : cellSize >= 4.5 ? 3 : 4;
  const searchRange = Math.max(1, Math.ceil(dotRadius / cellSize));
  const outputByteLength = pixelCount * 4;
  const densityByteLength = pixelCount * inkCount * Float32Array.BYTES_PER_ELEMENT;
  const densityBindingSize = Math.max(4, densityByteLength);
  const inkStrideFloats = 8;
  const inkByteLength = inkCount * inkStrideFloats * Float32Array.BYTES_PER_ELEMENT;

  if (
    outputByteLength > device.limits.maxStorageBufferBindingSize ||
    densityByteLength > device.limits.maxStorageBufferBindingSize ||
    inkByteLength > device.limits.maxStorageBufferBindingSize
  ) {
    throw new Error("stencil input exceeds this device's storage-buffer limit");
  }
  if (densityBuffer.size < densityBindingSize) {
    throw new Error("densityBuffer is smaller than the requested density data");
  }

  const shader = device.createShaderModule({
    label: "stencil compositor shader",
    code: /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  inkCount: u32,
  mode: u32,

  transparentBg: u32,
  superSamples: u32,
  searchRange: i32,
  _padding: u32,

  dotSize: f32,
  cellSize: f32,
  dotRadius: f32,
  densityScale: f32,

  inkOpacity: f32,
  paperR: f32,
  paperG: f32,
  paperB: f32,

  misregistration: f32,
  grain: f32,
  noise: f32,
  renderScale: f32,

  seed: u32,
  paperTexture: u32,
  paperTextureAmount: f32,
  _effectsPadding: u32,
}

struct Ink {
  // xy = cos/sin, zw = red/green
  geometry: vec4<f32>,
  // x = blue
  color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> densityMaps: array<f32>;
@group(0) @binding(2) var<storage, read> inks: array<Ink>;
@group(0) @binding(3) var<storage, read_write> outputPixels: array<u32>;

const PI: f32 = 3.14159265358979323846;
const DOT_FILL_D: f32 = 0.78539816339744830962;
const DOT_MAX_R: f32 = 0.58;

// Math.round(x) for the coordinate range used here. floor(x + 0.5) is
// important at negative half-integers, where WGSL round() differs from JS.
fn jsRound(value: f32) -> i32 {
  return i32(floor(value + 0.5));
}

fn roundToByte(value: f32) -> u32 {
  return u32(clamp(floor(value + 0.5), 0.0, 255.0));
}

// Density カーブ（CPU halftone.ts の densityCurve と同じ定義）。
// 1 以下は一律スケール、1 超は中間調ピボットを軸にコントラストを立てる。
const DENSITY_PIVOT: f32 = 0.5;
const DENSITY_CONTRAST: f32 = 1.2;

fn densityCurve(d: f32, density: f32) -> f32 {
  if (density <= 1.0) {
    return min(d * density, 1.0);
  }
  if (d <= 0.0) {
    return 0.0;
  }
  if (d >= 1.0) {
    return 1.0;
  }
  let contrast = 1.0 + (density - 1.0) * DENSITY_CONTRAST;
  if (d < DENSITY_PIVOT) {
    return DENSITY_PIVOT * pow(d / DENSITY_PIVOT, contrast);
  }
  return 1.0 - (1.0 - DENSITY_PIVOT) * pow((1.0 - d) / (1.0 - DENSITY_PIVOT), contrast);
}

fn densityAt(dotRx: f32, dotRy: f32, inkIndex: u32) -> f32 {
  let ink = inks[inkIndex];
  let cosine = ink.geometry.x;
  let sine = ink.geometry.y;
  let imageX = jsRound(dotRx * cosine - dotRy * sine);
  let imageY = jsRound(dotRx * sine + dotRy * cosine);

  if (
    imageX < 0 || imageX >= i32(params.width) ||
    imageY < 0 || imageY >= i32(params.height)
  ) {
    return 0.0;
  }

  let mapOffset = inkIndex * params.width * params.height;
  let pixelOffset = u32(imageY) * params.width + u32(imageX);
  return densityCurve(densityMaps[mapOffset + pixelOffset], params.densityScale);
}

fn cellHash(x: i32, y: i32) -> f32 {
  // u32 arithmetic supplies the same modulo-2^32 behavior as |0 and
  // Math.imul in the JavaScript reference.
  var hash = bitcast<u32>(x) * 374761393u + bitcast<u32>(y) * 668265263u;
  hash = (hash ^ (hash >> 13u)) * 1274126177u;
  hash = hash ^ (hash >> 16u);
  return f32(hash) * (1.0 / 4294967296.0);
}

fn roundIntegerToDoubleUlp(value: u32, quantum: u32) -> u32 {
  if (quantum == 1u) {
    return value;
  }
  let mask = quantum - 1u;
  let half = quantum >> 1u;
  let remainder = value & mask;
  var rounded = value & ~mask;
  // IEEE-754 round-to-nearest, ties-to-even. The quantum is at most 512,
  // so the low u32 contains all bits needed for the rounding decision.
  if (
    remainder > half ||
    (remainder == half && ((rounded / quantum) & 1u) != 0u)
  ) {
    rounded += quantum;
  }
  return rounded;
}

fn seedDoubleQuantum(seed: u32) -> u32 {
  // ULP of f64(seed * 1013904223). Thresholds are
  // ceil(2^exponent / 1013904223).
  if (seed >= 2274221724u) { return 512u; }
  if (seed >= 1137110862u) { return 256u; }
  if (seed >= 568555431u) { return 128u; }
  if (seed >= 284277716u) { return 64u; }
  if (seed >= 142138858u) { return 32u; }
  if (seed >= 71069429u) { return 16u; }
  if (seed >= 35534715u) { return 8u; }
  if (seed >= 17767358u) { return 4u; }
  if (seed >= 8883679u) { return 2u; }
  return 1u;
}

fn scuffHash(x: i32, y: i32, seed: u32) -> f32 {
  let quantum = seedDoubleQuantum(seed);
  let seedProduct = roundIntegerToDoubleUlp(seed * 1013904223u, quantum);
  let coordinates =
    bitcast<u32>(x) * 374761393u +
    bitcast<u32>(y) * 668265263u;

  // The CPU's first expression uses Number multiplication/addition before
  // |0. For a large seed, emulate f64's lost low bits with u32 operations;
  // using seed * constant modulo 2^32 directly produces a different hash.
  var hash = roundIntegerToDoubleUlp(seedProduct + coordinates, quantum);
  // From here, u32 arithmetic exactly matches Math.imul and logical >>>.
  hash = (hash ^ (hash >> 13u)) * 1274126177u;
  hash = hash ^ (hash >> 16u);
  return f32(hash) * (1.0 / 4294967296.0);
}

fn smoothNoise(x: f32, y: f32, cellSize: f32, seed: u32) -> f32 {
  let gx = i32(floor(x / cellSize));
  let gy = i32(floor(y / cellSize));
  let fx = x / cellSize - f32(gx);
  let fy = y / cellSize - f32(gy);

  // Keep the CPU helper's corner order and interpolation expression.
  let n00 = scuffHash(gx, gy, seed);
  let n10 = scuffHash(gx + 1, gy, seed);
  let n01 = scuffHash(gx, gy + 1, seed);
  let n11 = scuffHash(gx + 1, gy + 1, seed);
  let sx = fx * fx * (3.0 - 2.0 * fx);
  let sy = fy * fy * (3.0 - 2.0 * fy);
  return
    (n00 * (1.0 - sx) + n10 * sx) * (1.0 - sy) +
    (n01 * (1.0 - sx) + n11 * sx) * sy;
}

fn smoothNoiseAniso(
  x: f32,
  y: f32,
  cellX: f32,
  cellY: f32,
  seed: u32
) -> f32 {
  let gx = i32(floor(x / cellX));
  let gy = i32(floor(y / cellY));
  let fx = x / cellX - f32(gx);
  let fy = y / cellY - f32(gy);
  let n00 = scuffHash(gx, gy, seed);
  let n10 = scuffHash(gx + 1, gy, seed);
  let n01 = scuffHash(gx, gy + 1, seed);
  let n11 = scuffHash(gx + 1, gy + 1, seed);
  let sx = fx * fx * (3.0 - 2.0 * fx);
  let sy = fy * fy * (3.0 - 2.0 * fy);
  return
    (n00 * (1.0 - sx) + n10 * sx) * (1.0 - sy) +
    (n01 * (1.0 - sx) + n11 * sx) * sy;
}

fn fiberSample(
  x: f32,
  y: f32,
  cosine: f32,
  sine: f32,
  along: f32,
  across: f32,
  seed: u32
) -> f32 {
  let xr = x * cosine + y * sine;
  let yr = -x * sine + y * cosine;
  return smoothNoiseAniso(xr, yr, along, across, seed) - 0.5;
}

fn grain2(x: f32, y: f32, rs: f32, seed: u32) -> f32 {
  let a = smoothNoise(x, y, max(1.4 * rs, 1.0), seed) - 0.5;
  let b = smoothNoise(x, y, max(0.7 * rs, 1.0), seed + 7u) - 0.5;
  return a * 0.62 + b * 0.38;
}

fn speckField(x: f32, y: f32, rs: f32, seed: u32) -> f32 {
  let cellSize = max(1.1 * rs, 1.0);
  var speck = 0.0;
  let dark = smoothNoise(x, y, cellSize, seed + 311u);
  if (dark > 0.9) {
    speck -= (dark - 0.9) / 0.1;
  }
  let light = smoothNoise(x, y, cellSize, seed + 913u);
  if (light > 0.95) {
    speck += ((light - 0.95) / 0.05) * 0.4;
  }
  return speck;
}

fn crinkle(x: f32, y: f32, rs: f32, seed: u32) -> f32 {
  let noise = smoothNoiseAniso(x, y, 2.4 * rs, 8.0 * rs, seed + 55u);
  return 1.0 - abs(2.0 * noise - 1.0) - 0.5;
}

fn paperTextureAt(x: f32, y: f32) -> vec2<f32> {
  if (params.paperTexture == 0u) {
    return vec2<f32>(0.0);
  }

  let rs = params.renderScale;
  let seed = params.seed;
  let cloud = smoothNoise(x, y, 50.0 * rs, seed + 1u) - 0.5;
  let fineGrain = grain2(x, y, rs, seed);
  let speck = speckField(x, y, rs, seed);
  var lightness: f32;
  var speckAmount: f32;

  if (params.paperTexture == 2u) {
    // fiber: [86, 94, 79] degrees. Constants are the f32 forms of the
    // JavaScript Math.cos/Math.sin values used by the CPU helper.
    let fiber = (
      fiberSample(x, y,  0.069756474, 0.99756405, 13.0 * rs, 1.25 * rs, seed) +
      fiberSample(x, y, -0.069756474, 0.99756405, 13.0 * rs, 1.25 * rs, seed + 23u) +
      fiberSample(x, y,  0.19080900,  0.98162717, 13.0 * rs, 1.25 * rs, seed + 46u)
    ) / 3.0;
    lightness =
      fiber * 1.0 + crinkle(x, y, rs, seed) * 0.6 +
      fineGrain * 0.55 + cloud * 0.25;
    speckAmount = 0.35;
  } else {
    // felt: [0, 90, 45, -40] degrees.
    let fiber = (
      fiberSample(x, y, 1.0,        0.0,        9.0 * rs, 2.2 * rs, seed) +
      fiberSample(x, y, 0.0,        1.0,        9.0 * rs, 2.2 * rs, seed + 23u) +
      fiberSample(x, y, 0.70710677,  0.70710677, 9.0 * rs, 2.2 * rs, seed + 46u) +
      fiberSample(x, y, 0.76604444, -0.64278764, 9.0 * rs, 2.2 * rs, seed + 69u)
    ) / 4.0;
    lightness = fineGrain * 0.85 + fiber * 0.6 + cloud * 0.3;
    speckAmount = 1.0;
  }

  lightness = sign(lightness) * pow(abs(lightness), 0.92);
  lightness += speck * speckAmount;
  return vec2<f32>(lightness, cloud * 0.5);
}

fn amCoverage(pixelX: u32, pixelY: u32, inkIndex: u32) -> f32 {
  let ink = inks[inkIndex];
  let cosine = ink.geometry.x;
  let sine = ink.geometry.y;
  let sampleCount = params.superSamples;
  let inverseSamples = 1.0 / f32(sampleCount);
  var covered = 0u;

  for (var sampleY = 0u; sampleY < sampleCount; sampleY++) {
    for (var sampleX = 0u; sampleX < sampleCount; sampleX++) {
      let px = f32(pixelX) + (f32(sampleX) + 0.5) * inverseSamples - 0.5;
      let py = f32(pixelY) + (f32(sampleY) + 0.5) * inverseSamples - 0.5;
      let rx = px * cosine + py * sine;
      let ry = -px * sine + py * cosine;
      let gridX = i32(floor(rx / params.cellSize));
      let gridY = i32(floor(ry / params.cellSize));
      var inside = false;

      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let cellX = gridX + dx;
          let cellY = gridY + dy;
          let dotRx = (f32(cellX) + 0.5) * params.cellSize;
          let dotRy = (f32(cellY) + 0.5) * params.cellSize;
          let dotDensity = densityAt(dotRx, dotRy, inkIndex);
          if (dotDensity < 0.001) {
            continue;
          }

          var radius: f32;
          if (dotDensity <= DOT_FILL_D) {
            radius = sqrt(dotDensity / PI) * params.cellSize;
          } else {
            let t = (dotDensity - DOT_FILL_D) / (1.0 - DOT_FILL_D);
            radius = (0.5 + t * (DOT_MAX_R - 0.5)) * params.cellSize;
          }

          let distanceX = rx - dotRx;
          let distanceY = ry - dotRy;
          if (distanceX * distanceX + distanceY * distanceY <= radius * radius) {
            inside = true;
            break;
          }
        }
        if (inside) {
          break;
        }
      }

      if (inside) {
        covered++;
      }
    }
  }

  return f32(covered) / f32(sampleCount * sampleCount);
}

fn fmCoverage(pixelX: u32, pixelY: u32, inkIndex: u32) -> f32 {
  let ink = inks[inkIndex];
  let cosine = ink.geometry.x;
  let sine = ink.geometry.y;
  let sampleCount = params.superSamples;
  let inverseSamples = 1.0 / f32(sampleCount);
  let radiusSquared = params.dotRadius * params.dotRadius;
  var covered = 0u;

  for (var sampleY = 0u; sampleY < sampleCount; sampleY++) {
    for (var sampleX = 0u; sampleX < sampleCount; sampleX++) {
      let px = f32(pixelX) + (f32(sampleX) + 0.5) * inverseSamples - 0.5;
      let py = f32(pixelY) + (f32(sampleY) + 0.5) * inverseSamples - 0.5;
      let rx = px * cosine + py * sine;
      let ry = -px * sine + py * cosine;
      let gridX = i32(floor(rx / params.cellSize));
      let gridY = i32(floor(ry / params.cellSize));
      var inside = false;

      for (var dy = -params.searchRange; dy <= params.searchRange; dy++) {
        for (var dx = -params.searchRange; dx <= params.searchRange; dx++) {
          let cellX = gridX + dx;
          let cellY = gridY + dy;
          let dotRx = (f32(cellX) + 0.5) * params.cellSize;
          let dotRy = (f32(cellY) + 0.5) * params.cellSize;
          let distanceX = rx - dotRx;
          let distanceY = ry - dotRy;
          if (distanceX * distanceX + distanceY * distanceY > radiusSquared) {
            continue;
          }

          let dotDensity = densityAt(dotRx, dotRy, inkIndex);
          if (dotDensity <= cellHash(cellX, cellY)) {
            continue;
          }

          inside = true;
          break;
        }
        if (inside) {
          break;
        }
      }

      if (inside) {
        covered++;
      }
    }
  }

  return f32(covered) / f32(sampleCount * sampleCount);
}

@compute @workgroup_size(8, 8)
fn composite(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let pixelX = invocation.x;
  let pixelY = invocation.y;
  if (pixelX >= params.width || pixelY >= params.height) {
    return;
  }

  // The CPU stores its multiplication buffer in Uint8ClampedArray and calls
  // Math.round after each ink. Keeping integer-valued f32s here reproduces
  // that otherwise easy-to-miss per-layer quantization.
  var red = 255.0;
  var green = 255.0;
  var blue = 255.0;
  var alpha = 0.0;

  for (var inkIndex = 0u; inkIndex < params.inkCount; inkIndex++) {
    var offsetX = 0;
    var offsetY = 0;
    if (params.misregistration > 0.0) {
      offsetX = jsRound(
        (scuffHash(i32(inkIndex), 0, params.seed) - 0.5) *
        2.0 * params.misregistration
      );
      offsetY = jsRound(
        (scuffHash(i32(inkIndex), 1, params.seed) - 0.5) *
        2.0 * params.misregistration
      );
    }
    let sourceX = i32(pixelX) - offsetX;
    let sourceY = i32(pixelY) - offsetY;
    if (
      sourceX < 0 || sourceX >= i32(params.width) ||
      sourceY < 0 || sourceY >= i32(params.height)
    ) {
      continue;
    }

    var coverage = 0.0;
    if (params.mode == 0u) {
      coverage = amCoverage(u32(sourceX), u32(sourceY), inkIndex);
    } else {
      coverage = fmCoverage(u32(sourceX), u32(sourceY), inkIndex);
    }

    // The CPU mutates the complete halftone map before reading it through the
    // registration offset, so scuff coordinates are the source coordinates.
    if (params.noise > 0.0 && coverage >= 0.004) {
      let baseSize = max(params.dotSize * 4.0, 8.0 * params.renderScale);
      let size1 = baseSize * (1.0 + params.noise * 8.0);
      let size2 = size1 * 3.0;
      let size3 = size2 * 3.0;
      let noiseSeed = inkIndex * 7919u + 31u;
      let n =
        smoothNoise(f32(sourceX), f32(sourceY), size1, noiseSeed) * 0.3 +
        smoothNoise(f32(sourceX), f32(sourceY), size2, noiseSeed + 997u) * 0.4 +
        smoothNoise(f32(sourceX), f32(sourceY), size3, noiseSeed + 2003u) * 0.3;
      let deviation = (0.5 - n) * 2.0;
      if (deviation > 0.0) {
        coverage *= max(0.0, 1.0 - deviation * params.noise * 2.0);
      }
    }

    var opacity = coverage;
    if (params.grain > 0.0) {
      opacity = clamp(
        opacity +
        (scuffHash(i32(pixelX), i32(pixelY), params.seed + 101u) - 0.5) *
        params.grain,
        0.0,
        1.0
      );
    }

    if (opacity < 0.004) {
      continue;
    }

    let ink = inks[inkIndex];
    let a = opacity * params.inkOpacity;
    let transmittanceR = 1.0 - a * (1.0 - ink.geometry.z / 255.0);
    let transmittanceG = 1.0 - a * (1.0 - ink.geometry.w / 255.0);
    let transmittanceB = 1.0 - a * (1.0 - ink.color.x / 255.0);
    red = f32(roundToByte(red * transmittanceR));
    green = f32(roundToByte(green * transmittanceG));
    blue = f32(roundToByte(blue * transmittanceB));
    alpha = 1.0 - (1.0 - alpha) * (1.0 - a);
  }

  var outputAlpha = 255u;
  if (params.transparentBg != 0u) {
    if (alpha < 0.004) {
      red = 0.0;
      green = 0.0;
      blue = 0.0;
      outputAlpha = 0u;
    } else {
      let transparentWhite = 255.0 * (1.0 - alpha);
      red = f32(roundToByte((red - transparentWhite) / alpha));
      green = f32(roundToByte((green - transparentWhite) / alpha));
      blue = f32(roundToByte((blue - transparentWhite) / alpha));
      outputAlpha = roundToByte(alpha * 255.0);
    }
  } else {
    let inverseAlpha = 1.0 - alpha;
    let paperIsWhite =
      params.paperR == 255.0 && params.paperG == 255.0 && params.paperB == 255.0;
    let textureOn = params.paperTexture != 0u && params.paperTextureAmount > 0.0;
    if ((!paperIsWhite || textureOn) && inverseAlpha >= 0.004) {
      var addR = (params.paperR - 255.0) * inverseAlpha;
      var addG = (params.paperG - 255.0) * inverseAlpha;
      var addB = (params.paperB - 255.0) * inverseAlpha;
      if (textureOn) {
        let texture = paperTextureAt(f32(pixelX), f32(pixelY));
        let textureAmplitude = params.paperTextureAmount * 18.0;
        let lightness = texture.x * textureAmplitude * inverseAlpha;
        let warmth = texture.y * textureAmplitude * 0.4 * inverseAlpha;
        addR += lightness + warmth;
        addG += lightness;
        addB += lightness - warmth;
      }
      red = f32(roundToByte(red + addR));
      green = f32(roundToByte(green + addG));
      blue = f32(roundToByte(blue + addB));
    }
  }

  let packed =
    roundToByte(red) |
    (roundToByte(green) << 8u) |
    (roundToByte(blue) << 16u) |
    (outputAlpha << 24u);
  outputPixels[pixelY * params.width + pixelX] = packed;
}
`,
  });

  const paramsBuffer = device.createBuffer({
    label: "stencil parameters",
    size: 96,
    usage: GPUBufferUsage.UNIFORM,
    mappedAtCreation: true,
  });
  const paramsView = new DataView(paramsBuffer.getMappedRange());
  paramsView.setUint32(0, width, true);
  paramsView.setUint32(4, height, true);
  paramsView.setUint32(8, inkCount, true);
  paramsView.setUint32(12, halftoneMode === "am" ? 0 : 1, true);
  paramsView.setUint32(16, transparentBg ? 1 : 0, true);
  paramsView.setUint32(20, ss, true);
  paramsView.setInt32(24, searchRange, true);
  paramsView.setUint32(28, 0, true);
  paramsView.setFloat32(32, dotSize, true);
  paramsView.setFloat32(36, cellSize, true);
  paramsView.setFloat32(40, dotRadius, true);
  paramsView.setFloat32(44, density, true);
  paramsView.setFloat32(48, inkOpacity, true);
  paramsView.setFloat32(52, paper.r, true);
  paramsView.setFloat32(56, paper.g, true);
  paramsView.setFloat32(60, paper.b, true);
  paramsView.setFloat32(64, misregistration, true);
  paramsView.setFloat32(68, grain, true);
  paramsView.setFloat32(72, noise, true);
  paramsView.setFloat32(76, renderScale, true);
  paramsView.setUint32(80, seed, true);
  paramsView.setUint32(
    84,
    paperTexture === "none" ? 0 : paperTexture === "felt" ? 1 : 2,
    true
  );
  paramsView.setFloat32(88, paperTextureAmount, true);
  paramsView.setUint32(92, 0, true);
  paramsBuffer.unmap();

  const inkBuffer = device.createBuffer({
    label: "stencil inks",
    size: Math.max(32, inkByteLength),
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  const inkUpload = new Float32Array(inkBuffer.getMappedRange());
  for (let inkIndex = 0; inkIndex < inkCount; inkIndex++) {
    const radians = angles[inkIndex] * Math.PI / 180;
    const offset = inkIndex * inkStrideFloats;
    inkUpload[offset] = Math.cos(radians);
    inkUpload[offset + 1] = Math.sin(radians);
    inkUpload[offset + 2] = inkRgbs[inkIndex].r;
    inkUpload[offset + 3] = inkRgbs[inkIndex].g;
    inkUpload[offset + 4] = inkRgbs[inkIndex].b;
  }
  inkBuffer.unmap();

  const outputBuffer = device.createBuffer({
    label: "stencil packed output",
    size: outputByteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuffer = device.createBuffer({
    label: "stencil output readback",
    size: outputByteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  try {
    const pipeline = await device.createComputePipelineAsync({
      label: "stencil compositor pipeline",
      layout: "auto",
      compute: { module: shader, entryPoint: "composite" },
    });
    const bindGroup = device.createBindGroup({
      label: "stencil compositor resources",
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        {
          binding: 1,
          resource: { buffer: densityBuffer, size: densityBindingSize },
        },
        { binding: 2, resource: { buffer: inkBuffer } },
        { binding: 3, resource: { buffer: outputBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder({ label: "stencil compositor commands" });
    const pass = encoder.beginComputePass({ label: "stencil compositor pass" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, outputByteLength);
    device.queue.submit([encoder.finish()]);

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const result = new Uint8ClampedArray(outputByteLength);
    result.set(new Uint8Array(readbackBuffer.getMappedRange()));
    readbackBuffer.unmap();
    return result;
  } finally {
    paramsBuffer.destroy();
    inkBuffer.destroy();
    outputBuffer.destroy();
    readbackBuffer.destroy();
  }
}

/** RGBA 8bit ピクセル (length = width*height*4) を返す。 */
export async function renderStencilWebGPU(
  device: GPUDevice,
  input: GpuStencilInput
): Promise<Uint8ClampedArray> {
  const { densityMaps, ...composeInput } = input;
  const { angles, inkRgbs, width, height, dotSize } = input;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new Error("width and height must be non-negative integers");
  }
  if (densityMaps.length !== angles.length || densityMaps.length !== inkRgbs.length) {
    throw new Error("densityMaps, angles, and inkRgbs must have the same length");
  }

  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount)) {
    throw new Error("image dimensions are too large");
  }
  for (const densityMap of densityMaps) {
    if (densityMap.length !== pixelCount) {
      throw new Error("each density map must have width * height elements");
    }
  }
  if (pixelCount === 0) return new Uint8ClampedArray();
  if (!(dotSize > 0) || !Number.isFinite(dotSize)) {
    throw new Error("dotSize must be a positive finite number");
  }

  const inkCount = densityMaps.length;
  const outputByteLength = pixelCount * Uint32Array.BYTES_PER_ELEMENT;
  const densityByteLength =
    pixelCount * inkCount * Float32Array.BYTES_PER_ELEMENT;
  const inkByteLength =
    inkCount * 8 * Float32Array.BYTES_PER_ELEMENT;
  if (
    outputByteLength > device.limits.maxStorageBufferBindingSize ||
    densityByteLength > device.limits.maxStorageBufferBindingSize ||
    inkByteLength > device.limits.maxStorageBufferBindingSize
  ) {
    throw new Error("stencil input exceeds this device's storage-buffer limit");
  }

  // WebGPU does not permit zero-sized buffers. One dummy element is enough
  // for the zero-ink case because the shader never enters its ink loop.
  const densityBuffer = device.createBuffer({
    label: "stencil density maps",
    size: Math.max(4, densityByteLength),
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });

  try {
    const densityUpload = new Float32Array(densityBuffer.getMappedRange());
    for (let inkIndex = 0; inkIndex < inkCount; inkIndex++) {
      densityUpload.set(densityMaps[inkIndex], inkIndex * pixelCount);
    }
    densityBuffer.unmap();

    return await compositeFromDensityBuffer(device, {
      ...composeInput,
      densityBuffer,
      inkCount,
    });
  } finally {
    densityBuffer.destroy();
  }
}
