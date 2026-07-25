// WebGPU 版の色分解（decompose + snap + GCR + boldContrast + highlightCutoff）。
// LUT 補間ではなく、CPU と同じ計算式を per-pixel の compute shader で直接実行する。
import { hexToRgb, luminance, rgbToLab, type RGB } from "./color";
import {
  buildLightnessTable,
  type ImageDataLike,
  type InkDensities,
  type StencilOptions,
} from "./stencil";

/** GPU 分解が一度に扱えるインク数の上限（UI 側の上限もこれに合わせる） */
export const MAX_INKS = 8;
const LIGHTNESS_STEPS = 64;
const TABLE_SIZE = LIGHTNESS_STEPS + 1;
const RISO_SCREEN_ANGLES = [45, 75, 15, 0, 30, 60, 90, 105];
const DEFAULT_PAPER: RGB = { r: 245, g: 240, b: 232 };

const SHADER = /* wgsl */ `
const MAX_INKS: u32 = 8u;
const TABLE_SIZE: u32 = 65u;
const DELTA_FLOATS: u32 = 24u;

struct Params {
  width: u32,
  height: u32,
  pixelCount: u32,
  inkCount: u32,

  decompCount: u32,
  kIndex: u32,
  useGcr: u32,
  invert: u32,

  bold: u32,
  snapEnabled: u32,
  cutoffEnabled: u32,
  twoInkFit: u32,

  inkOpacity: f32,
  snapStrength: f32,
  blackGeneration: f32,
  highlightCutoff: f32,

  paperR: f32,
  paperG: f32,
  paperB: f32,
  _padding1: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> sourcePixels: array<u32>;
// [0..MAX_INKS): decompose index -> original ink index
// [MAX_INKS..2*MAX_INKS): low-absorption flag by original ink index
@group(0) @binding(2) var<storage, read> inkMeta: array<u32>;
// First MAX_INKS vec3 values are white-reference absorption vectors. The
// following MAX_INKS-square matrix is the precomputed Gram matrix.
@group(0) @binding(3) var<storage, read> precomputed: array<f32>;
// Tables are addressed by original ink index, each with 65 entries.
@group(0) @binding(4) var<storage, read> lightnessTables: array<f32>;
// Ink-major output: outputDensities[ink * pixelCount + pixel].
@group(0) @binding(5) var<storage, read_write> outputDensities: array<f32>;

fn smoothstepCpu(edge0: f32, edge1: f32, x: f32) -> f32 {
  let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn srgbToLinear(value: f32) -> f32 {
  let c = value / 255.0;
  if (c <= 0.04045) {
    return c / 12.92;
  }
  return pow((c + 0.055) / 1.055, 2.4);
}

fn labF(value: f32) -> f32 {
  if (value > 216.0 / 24389.0) {
    // This branch is positive, so pow(x, 1/3) matches Math.cbrt(x).
    return pow(value, 1.0 / 3.0);
  }
  return ((24389.0 / 27.0) * value + 16.0) / 116.0;
}

fn rgbToLab(red: f32, green: f32, blue: f32) -> vec3<f32> {
  let r = srgbToLinear(red);
  let g = srgbToLinear(green);
  let b = srgbToLinear(blue);
  let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  let y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  let z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  let fx = labF(x);
  let fy = labF(y);
  let fz = labF(z);
  return vec3<f32>(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}

fn deltaAt(ink: u32) -> vec3<f32> {
  let offset = ink * 3u;
  return vec3<f32>(
    precomputed[offset],
    precomputed[offset + 1u],
    precomputed[offset + 2u]
  );
}

fn gramAt(row: u32, column: u32) -> f32 {
  return precomputed[DELTA_FLOATS + row * MAX_INKS + column];
}

// 明度表は「インクが紙より明るい」場合（暗い紙に明るいインク）は増加する。
// CPU の coverageForLightness と同じく両方向へ対応する。
fn coverageForLightness(inkIndex: u32, targetL: f32) -> f32 {
  let base = inkIndex * TABLE_SIZE;
  let first = lightnessTables[base];
  let last = lightnessTables[base + TABLE_SIZE - 1u];
  let ascending = last > first;
  if (select(targetL >= first, targetL <= first, ascending)) {
    return 0.0;
  }
  if (select(targetL <= last, targetL >= last, ascending)) {
    return 1.0;
  }
  for (var k = 0u; k < TABLE_SIZE - 1u; k++) {
    let l0 = lightnessTables[base + k];
    let l1 = lightnessTables[base + k + 1u];
    let lo = select(l1, l0, ascending);
    let hi = select(l0, l1, ascending);
    if (targetL >= lo && targetL <= hi) {
      let span = l1 - l0;
      var fraction = 0.0;
      if (span != 0.0) {
        fraction = (targetL - l0) / span;
      }
      return (f32(k) + fraction) / f32(TABLE_SIZE - 1u);
    }
  }
  return 1.0;
}

// 2色 Natural フィットの1座標更新（CPU applyTwoInkNaturalFit と同一）。
// 順モデル F は片方の密度に対しアフィンなので、輝度重み付き RGB 距離の最小解は閉形式。
fn twoInkCoord(sA: vec3<f32>, sB: vec3<f32>, dB: f32, tgt: vec3<f32>, o: f32, pp: vec3<f32>) -> f32 {
  let Y = vec3<f32>(0.2126, 0.7152, 0.0722);
  let LAMBDA = 3.0;
  var BB = 0.0;
  var Be0 = 0.0;
  var yB = 0.0;
  var ye0 = 0.0;
  for (var c = 0u; c < 3u; c++) {
    let Rc = 1.0 - o * dB * sB[c];
    let U = 1.0 - o * dB;
    let Ac = Rc + (pp[c] - 1.0) * U;
    let Bc = -o * (sA[c] * Rc + (pp[c] - 1.0) * U);
    let e0 = Ac - tgt[c];
    BB += Bc * Bc;
    Be0 += Bc * e0;
    yB += Y[c] * Bc;
    ye0 += Y[c] * e0;
  }
  let denom = BB + LAMBDA * yB * yB;
  if (denom <= 1e-9) {
    return 0.0;
  }
  let d = -(Be0 + LAMBDA * yB * ye0) / denom;
  return clamp(d, 0.0, 1.0);
}

@compute @workgroup_size(8, 8)
fn decompose(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) {
    return;
  }

  let pixel = id.y * params.width + id.x;
  let packed = sourcePixels[pixel];
  let rawR = f32(packed & 255u);
  let rawG = f32((packed >> 8u) & 255u);
  let rawB = f32((packed >> 16u) & 255u);
  let alphaByte = (packed >> 24u) & 255u;
  let alpha = f32(alphaByte) / 255.0;

  var red = rawR;
  var green = rawG;
  var blue = rawB;
  if (params.invert != 0u) {
    red = 255.0 - rawR;
    green = 255.0 - rawG;
    blue = 255.0 - rawB;
  }

  var densities: array<f32, 8>;
  var dotTargets: array<f32, 8>;
  var unbounded: array<f32, 8>;
  for (var i = 0u; i < MAX_INKS; i++) {
    densities[i] = 0.0;
    dotTargets[i] = 0.0;
    unbounded[i] = 0.0;
  }

  var residual = 0.0;
  if (params.decompCount > 0u && alpha >= 0.01) {
    // The decomposition reference is always white, independently of paperR/G/B.
    let targetAbs = vec3<f32>(
      (255.0 - red) / 255.0 * alpha,
      (255.0 - green) / 255.0 * alpha,
      (255.0 - blue) / 255.0 * alpha
    );

    for (var i = 0u; i < params.decompCount; i++) {
      dotTargets[i] = dot(deltaAt(i), targetAbs);
      let originalIndex = inkMeta[i];
      let selfDot = gramAt(i, i);
      if (selfDot > 1e-10) {
        densities[originalIndex] = clamp(dotTargets[i] / selfDot, 0.0, 1.0);
      }
    }

    for (var iteration = 0u; iteration < 12u; iteration++) {
      for (var i = 0u; i < params.decompCount; i++) {
        var numerator = dotTargets[i];
        for (var j = 0u; j < params.decompCount; j++) {
          if (j != i) {
            numerator -= densities[inkMeta[j]] * gramAt(i, j);
          }
        }
        let originalIndex = inkMeta[i];
        let selfDot = gramAt(i, i);
        if (selfDot > 1e-10) {
          densities[originalIndex] = clamp(numerator / selfDot, 0.0, 1.0);
        } else {
          densities[originalIndex] = 0.0;
        }
      }
    }

    // A separate unbounded NNLS solve measures hue error without treating the
    // d<=1 coverage limit as an out-of-gamut residual.
    // 残差は snap でしか使わないので、snap を通らない構成では丸ごと省く
    // （8 スイープ分＝分解の約 4 割）。CPU 側の needResidual と同じ判定。
    if (params.snapEnabled != 0u) {
    for (var i = 0u; i < params.decompCount; i++) {
      let selfDot = gramAt(i, i);
      if (selfDot > 1e-10) {
        unbounded[i] = max(0.0, dotTargets[i] / selfDot);
      }
    }
    for (var iteration = 0u; iteration < 8u; iteration++) {
      for (var i = 0u; i < params.decompCount; i++) {
        var numerator = dotTargets[i];
        for (var j = 0u; j < params.decompCount; j++) {
          if (j != i) {
            numerator -= unbounded[j] * gramAt(i, j);
          }
        }
        let selfDot = gramAt(i, i);
        if (selfDot > 1e-10) {
          unbounded[i] = max(0.0, numerator / selfDot);
        } else {
          unbounded[i] = 0.0;
        }
      }
    }
    var remainder = targetAbs;
    for (var i = 0u; i < params.decompCount; i++) {
      remainder -= unbounded[i] * deltaAt(i);
    }
    residual = length(remainder);
    }
  }

  // Low-absorption inks bypass NNLS and use the CPU's Rec. 709 luminance path.
  let sourceLuminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255.0;
  for (var i = 0u; i < params.inkCount; i++) {
    if (inkMeta[MAX_INKS + i] != 0u) {
      densities[i] = (1.0 - sourceLuminance) * alpha;
    }
  }

  // 2色 × Natural: 加法 NNLS の代わりに乗算モデルへ直接フィット（snap は無効化済み）。
  // CPU 側は alpha < 0.01（= alphaByte が 3 未満）を除外するので閾値を揃える
  if (params.twoInkFit != 0u && alphaByte >= 3u) {
    let sa = deltaAt(0u);
    let sb = deltaAt(1u);
    let o = params.inkOpacity;
    let pp = vec3<f32>(params.paperR / 255.0, params.paperG / 255.0, params.paperB / 255.0);
    let tt = vec3<f32>(
      (1.0 - alpha) * pp.x + alpha * red / 255.0,
      (1.0 - alpha) * pp.y + alpha * green / 255.0,
      (1.0 - alpha) * pp.z + alpha * blue / 255.0
    );
    var d0 = densities[inkMeta[0u]];
    var d1 = densities[inkMeta[1u]];
    for (var sweep = 0u; sweep < 6u; sweep++) {
      d0 = twoInkCoord(sa, sb, d1, tt, o, pp);
      d1 = twoInkCoord(sb, sa, d0, tt, o, pp);
    }
    densities[inkMeta[0u]] = d0;
    densities[inkMeta[1u]] = d1;
  }

  if (params.snapEnabled != 0u && alphaByte >= 3u) {
    let targetLab = rgbToLab(red, green, blue);
    let targetChroma = length(targetLab.yz);
    let strength = max(0.0, params.snapStrength);
    let residualLow = 0.12 - 0.05 * strength;
    let residualHigh = 0.34 - 0.1 * strength;
    let chromaLow = 8.0 - 4.0 * strength;
    let chromaHigh = 22.0 - 6.0 * strength;
    let scale = 0.85 + 0.15 * min(strength, 1.0);
    let offGamut = smoothstepCpu(residualLow, residualHigh, residual);

    if (offGamut > 0.0) {
      let saturationGate = smoothstepCpu(chromaLow, chromaHigh, targetChroma);
      let darkGate = smoothstepCpu(18.0, 40.0, targetLab.x);
      let snap = offGamut * saturationGate * darkGate * scale;

      if (snap >= 0.02) {
        var mixedR = 1.0;
        var mixedG = 1.0;
        var mixedB = 1.0;
        var inverseAlpha = 1.0;
        for (var t = 0u; t < params.decompCount; t++) {
          let originalIndex = inkMeta[t];
          let absorption = deltaAt(t);
          let a = densities[originalIndex] * params.inkOpacity;
          mixedR *= 1.0 - a * absorption.x;
          mixedG *= 1.0 - a * absorption.y;
          mixedB *= 1.0 - a * absorption.z;
          inverseAlpha *= 1.0 - a;
        }
        let currentLab = rgbToLab(
          (mixedR + (params.paperR / 255.0 - 1.0) * inverseAlpha) * 255.0,
          (mixedG + (params.paperG / 255.0 - 1.0) * inverseAlpha) * 255.0,
          (mixedB + (params.paperB / 255.0 - 1.0) * inverseAlpha) * 255.0
        );

        var dominant = 0u;
        var dominantCoverage = 0.0;
        var bestDeltaE = 3.402823466e+38;
        for (var t = 0u; t < params.decompCount; t++) {
          let originalIndex = inkMeta[t];
          let absorption = deltaAt(t);
          let coverage = coverageForLightness(originalIndex, targetLab.x);
          let a = coverage * params.inkOpacity;
          let singleLab = rgbToLab(
            ((1.0 - a * absorption.x) +
              (params.paperR / 255.0 - 1.0) * (1.0 - a)) * 255.0,
            ((1.0 - a * absorption.y) +
              (params.paperG / 255.0 - 1.0) * (1.0 - a)) * 255.0,
            ((1.0 - a * absorption.z) +
              (params.paperB / 255.0 - 1.0) * (1.0 - a)) * 255.0
          );
          let deltaE = length(singleLab - currentLab);
          if (deltaE < bestDeltaE) {
            bestDeltaE = deltaE;
            dominant = t;
            dominantCoverage = coverage;
          }
        }

        for (var t = 0u; t < params.decompCount; t++) {
          let originalIndex = inkMeta[t];
          var targetDensity = 0.0;
          if (t == dominant) {
            targetDensity = dominantCoverage;
          }
          densities[originalIndex] =
            densities[originalIndex] * (1.0 - snap) + targetDensity * snap;
        }
      }
    }
  }

  if (params.useGcr != 0u && alphaByte >= 3u) {
    let targetLab = rgbToLab(red, green, blue);
    let targetChroma = length(targetLab.yz);
    let gate = 1.0 - smoothstepCpu(6.0, 26.0, targetChroma);
    let blend = params.blackGeneration * gate;
    if (blend >= 0.01) {
      densities[params.kIndex] =
        blend * coverageForLightness(params.kIndex, targetLab.x);
      for (var t = 0u; t < params.decompCount; t++) {
        densities[inkMeta[t]] *= 1.0 - blend;
      }
    }
  }

  if (params.bold != 0u) {
    let gain = 6.0;
    let middle = 0.35;
    let sigmoid0 = 1.0 / (1.0 + exp(gain * middle));
    let sigmoid1 = 1.0 / (1.0 + exp(-gain * (1.0 - middle)));
    let sigmoidRange = sigmoid1 - sigmoid0;
    for (var i = 0u; i < params.inkCount; i++) {
      let value = densities[i];
      if (value < 0.001) {
        densities[i] = 0.0;
      } else {
        let sigmoid = 1.0 / (1.0 + exp(-gain * (value - middle)));
        densities[i] = clamp((sigmoid - sigmoid0) / sigmoidRange, 0.0, 1.0);
      }
    }
  }

  // ハイライトのロールオフ（CPU の highlightRolloff と同じ定義）。
  // しきい値以下を 0 に切り捨てず、下端をソフトニーで 0 へ接続する。
  // 乗除算だけなので CPU と数値が厳密に一致する。
  if (params.cutoffEnabled != 0u) {
    let cutoff = params.highlightCutoff;
    for (var i = 0u; i < params.inkCount; i++) {
      let value = densities[i];
      if (value <= 0.0) {
        densities[i] = 0.0;
      } else {
        let y = value - cutoff;
        var soft = y;
        if (y < cutoff) {
          soft = ((y + cutoff) * (y + cutoff)) / (4.0 * cutoff);
        }
        densities[i] = soft / (1.0 - cutoff);
      }
    }
  }

  for (var i = 0u; i < params.inkCount; i++) {
    outputDensities[i * params.pixelCount + pixel] = densities[i];
  }
}
`;

// シェーダのコンパイルとパイプライン生成はデバイスごとに 1 回で足りる
// （WGSL は定数、layout も "auto" 固定）。毎回作り直すと Discover のように
// 候補を大量に描くとき、1 枚ごとにコンパイルを払うことになる。
const decomposePipelines = new WeakMap<GPUDevice, Promise<GPUComputePipeline>>();

function getDecomposePipeline(device: GPUDevice): Promise<GPUComputePipeline> {
  let pipeline = decomposePipelines.get(device);
  if (!pipeline) {
    pipeline = device.createComputePipelineAsync({
      label: "stencil decomposition pipeline",
      layout: "auto",
      compute: {
        module: device.createShaderModule({
          label: "stencil decomposition shader",
          code: SHADER,
        }),
        entryPoint: "decompose",
      },
    });
    // 失敗したらキャッシュに残さない（次回やり直せるように）
    pipeline.catch(() => decomposePipelines.delete(device));
    decomposePipelines.set(device, pipeline);
  }
  return pipeline;
}

function resolveAngles(inkRgbs: RGB[], options: StencilOptions): number[] {
  const autoAngles = new Array<number>(inkRgbs.length);
  inkRgbs
    .map((_, index) => index)
    .sort(
      (a, b) =>
        luminance(inkRgbs[a].r, inkRgbs[a].g, inkRgbs[a].b) -
          luminance(inkRgbs[b].r, inkRgbs[b].g, inkRgbs[b].b) ||
        a - b
    )
    .forEach((colorIndex, rank) => {
      autoAngles[colorIndex] =
        RISO_SCREEN_ANGLES[rank % RISO_SCREEN_ANGLES.length];
    });
  return options.colors.map((color, index) => color.angle ?? autoAngles[index]);
}

export interface GpuDensities {
  /** Ink-major f32 storage. The caller owns this buffer and must destroy it. */
  densityBuffer: GPUBuffer;
  inkCount: number;
  angles: number[];
  paper: RGB;
  inkRgbs: RGB[];
  width: number;
  height: number;
}

/**
 * CPU の computeInkDensities と同じ各段階を、1 pixel / 1 invocation で直接計算する。
 *
 * WGSL は f32、CPU の反復計算は JS f64 なので、NNLS と Lab の最終ビットには小さな
 * 丸め差が生じる。出力は ink-major の storage buffer のまま返す。
 */
export async function decomposeToGpuBuffer(
  device: GPUDevice,
  source: ImageDataLike,
  options: StencilOptions
): Promise<GpuDensities> {
  const { colors } = options;
  const inkCount = colors.length;
  if (inkCount > MAX_INKS) {
    throw new Error(
      `computeInkDensitiesWebGPU supports at most ${MAX_INKS} inks (received ${inkCount})`
    );
  }

  const { width, height } = source;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new Error("width and height must be non-negative integers");
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount)) {
    throw new Error("image dimensions are too large");
  }
  const inkRgbs = colors.map((color) => hexToRgb(color.color));
  const paper = options.paperColor ? hexToRgb(options.paperColor) : DEFAULT_PAPER;
  const inkOpacity = options.inkOpacity ?? 0.85;
  const gamutThreshold = options.gamutThreshold ?? 0.5;
  const blackGeneration = options.blackGeneration ?? 0.7;
  const highlightCutoff = options.highlightCutoff ?? 0;
  const bold = options.colorMode === "bold";

  const isLowAbsorption = inkRgbs.map((ink) => {
    const red = (255 - ink.r) / 255;
    const green = (255 - ink.g) / 255;
    const blue = (255 - ink.b) / 255;
    return Math.hypot(red, green, blue) < 0.05;
  });
  // 単色は色合わせが破綻するため、低吸収インクと同じく輝度ベースにする（CPU と一致）。
  const singleInk = inkCount === 1;
  const useLuminance = inkRgbs.map((_, index) => isLowAbsorption[index] || singleInk);
  const isNeutral = inkRgbs.map((ink, index) => {
    if (useLuminance[index]) return false;
    const [, a, b] = rgbToLab(ink.r, ink.g, ink.b);
    return Math.hypot(a, b) < 12;
  });

  const neutralIndices: number[] = [];
  let chromaticCount = 0;
  for (let index = 0; index < inkCount; index++) {
    if (useLuminance[index]) continue;
    if (isNeutral[index]) neutralIndices.push(index);
    else chromaticCount++;
  }
  const useGcr =
    neutralIndices.length === 1 && chromaticCount >= 2 && blackGeneration > 0;
  const kIndex = useGcr ? neutralIndices[0] : -1;

  const decompIndexMap: number[] = [];
  const decompInks: RGB[] = [];
  for (let index = 0; index < inkCount; index++) {
    if (useLuminance[index] || (useGcr && index === kIndex)) continue;
    decompIndexMap.push(index);
    decompInks.push(inkRgbs[index]);
  }

  const angles = resolveAngles(inkRgbs, options);
  const outputByteLength =
    inkCount * pixelCount * Float32Array.BYTES_PER_ELEMENT;
  if (
    pixelCount * Uint32Array.BYTES_PER_ELEMENT >
      device.limits.maxStorageBufferBindingSize ||
    outputByteLength > device.limits.maxStorageBufferBindingSize
  ) {
    throw new Error(
      "stencil decomposition input exceeds this device's storage-buffer limit"
    );
  }

  if (inkCount === 0 || pixelCount === 0) {
    const densityBuffer = device.createBuffer({
      label: "stencil decomposition output",
      size: Math.max(4, outputByteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    return {
      densityBuffer,
      inkCount,
      angles,
      paper,
      inkRgbs,
      width,
      height,
    };
  }

  // These values are computed in JS f64, then deliberately rounded once on
  // upload to the f32 representation consumed by WGSL.
  const deltas = decompInks.map(
    (ink) =>
      [(255 - ink.r) / 255, (255 - ink.g) / 255, (255 - ink.b) / 255] as const
  );
  const precomputedData = new Float32Array(MAX_INKS * 3 + MAX_INKS * MAX_INKS);
  for (let i = 0; i < deltas.length; i++) {
    precomputedData.set(deltas[i], i * 3);
    for (let j = 0; j < deltas.length; j++) {
      precomputedData[MAX_INKS * 3 + i * MAX_INKS + j] =
        deltas[i][0] * deltas[j][0] +
        deltas[i][1] * deltas[j][1] +
        deltas[i][2] * deltas[j][2];
    }
  }

  const metaData = new Uint32Array(MAX_INKS * 2);
  metaData.set(decompIndexMap);
  for (let index = 0; index < inkCount; index++) {
    metaData[MAX_INKS + index] = useLuminance[index] ? 1 : 0;
  }

  const tableData = new Float32Array(MAX_INKS * TABLE_SIZE);
  for (const originalIndex of decompIndexMap) {
    tableData.set(
      buildLightnessTable(inkRgbs[originalIndex], paper, inkOpacity),
      originalIndex * TABLE_SIZE
    );
  }
  if (useGcr) {
    tableData.set(
      buildLightnessTable(inkRgbs[kIndex], paper, inkOpacity),
      kIndex * TABLE_SIZE
    );
  }

  const paramsBuffer = device.createBuffer({
    label: "stencil decomposition parameters",
    size: 80,
    usage: GPUBufferUsage.UNIFORM,
    mappedAtCreation: true,
  });
  const params = new DataView(paramsBuffer.getMappedRange());
  params.setUint32(0, width, true);
  params.setUint32(4, height, true);
  params.setUint32(8, pixelCount, true);
  params.setUint32(12, inkCount, true);
  params.setUint32(16, decompIndexMap.length, true);
  params.setUint32(20, useGcr ? kIndex : 0, true);
  params.setUint32(24, useGcr ? 1 : 0, true);
  params.setUint32(28, options.invert ? 1 : 0, true);
  params.setUint32(32, bold ? 1 : 0, true);
  // 2色 × Natural は乗算モデルフィットを使い、従来の snap は無効化する。
  const twoInkFit = !bold && inkCount === 2 && decompIndexMap.length === 2;
  params.setUint32(36, !twoInkFit && decompIndexMap.length >= 2 ? 1 : 0, true);
  params.setUint32(40, highlightCutoff > 0 && highlightCutoff < 1 ? 1 : 0, true);
  params.setUint32(44, twoInkFit ? 1 : 0, true);
  params.setFloat32(48, inkOpacity, true);
  params.setFloat32(52, bold ? 0.5 + gamutThreshold : 0, true);
  params.setFloat32(56, blackGeneration, true);
  params.setFloat32(60, highlightCutoff, true);
  params.setFloat32(64, paper.r, true);
  params.setFloat32(68, paper.g, true);
  params.setFloat32(72, paper.b, true);
  params.setFloat32(76, 0, true);
  paramsBuffer.unmap();

  const sourceBuffer = device.createBuffer({
    label: "stencil decomposition source",
    size: pixelCount * 4,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  const packedSource = new Uint32Array(sourceBuffer.getMappedRange());
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    packedSource[pixel] =
      (source.data[offset] |
        (source.data[offset + 1] << 8) |
        (source.data[offset + 2] << 16) |
        (source.data[offset + 3] << 24)) >>>
      0;
  }
  sourceBuffer.unmap();

  const metaBuffer = device.createBuffer({
    label: "stencil decomposition ink metadata",
    size: metaData.byteLength,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  new Uint32Array(metaBuffer.getMappedRange()).set(metaData);
  metaBuffer.unmap();

  const precomputedBuffer = device.createBuffer({
    label: "stencil decomposition precomputed values",
    size: precomputedData.byteLength,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  new Float32Array(precomputedBuffer.getMappedRange()).set(precomputedData);
  precomputedBuffer.unmap();

  const tableBuffer = device.createBuffer({
    label: "stencil decomposition lightness tables",
    size: tableData.byteLength,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  new Float32Array(tableBuffer.getMappedRange()).set(tableData);
  tableBuffer.unmap();

  const outputBuffer = device.createBuffer({
    label: "stencil decomposition output",
    size: outputByteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  let outputHandedOff = false;

  try {
    const pipeline = await getDecomposePipeline(device);
    const bindGroup = device.createBindGroup({
      label: "stencil decomposition resources",
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: sourceBuffer } },
        { binding: 2, resource: { buffer: metaBuffer } },
        { binding: 3, resource: { buffer: precomputedBuffer } },
        { binding: 4, resource: { buffer: tableBuffer } },
        { binding: 5, resource: { buffer: outputBuffer } },
      ],
    });

    // 検証エラー/OOM は非同期に報告されるので、スコープで拾って例外にする
    // （拾わないと壊れた密度バッファを成功として返してしまう）。
    device.pushErrorScope("validation");
    device.pushErrorScope("out-of-memory");
    const encoder = device.createCommandEncoder({
      label: "stencil decomposition commands",
    });
    const pass = encoder.beginComputePass({ label: "stencil decomposition pass" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);
    const oomError = await device.popErrorScope();
    const validationError = await device.popErrorScope();
    if (oomError || validationError) {
      throw new Error(
        `WebGPU decompose failed: ${(validationError ?? oomError)!.message}`
      );
    }

    outputHandedOff = true;
    return {
      densityBuffer: outputBuffer,
      inkCount,
      angles,
      paper,
      inkRgbs,
      width,
      height,
    };
  } finally {
    paramsBuffer.destroy();
    sourceBuffer.destroy();
    metaBuffer.destroy();
    precomputedBuffer.destroy();
    tableBuffer.destroy();
    if (!outputHandedOff) outputBuffer.destroy();
  }
}

/**
 * Decomposes and reads the ink-major GPU result back into the original
 * per-ink Float32Array API.
 */
export async function computeInkDensitiesWebGPU(
  device: GPUDevice,
  source: ImageDataLike,
  options: StencilOptions
): Promise<InkDensities> {
  const gpuDensities = await decomposeToGpuBuffer(device, source, options);
  const {
    densityBuffer,
    inkCount,
    angles,
    paper,
    inkRgbs,
    width,
    height,
  } = gpuDensities;
  const pixelCount = width * height;
  const outputByteLength =
    inkCount * pixelCount * Float32Array.BYTES_PER_ELEMENT;

  if (outputByteLength === 0) {
    densityBuffer.destroy();
    return {
      densityMaps: inkRgbs.map(() => new Float32Array(pixelCount)),
      angles,
      paper,
      inkRgbs,
      width,
      height,
    };
  }

  let readbackBuffer: GPUBuffer | undefined;
  let readbackMapped = false;

  try {
    readbackBuffer = device.createBuffer({
      label: "stencil decomposition readback",
      size: outputByteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder({
      label: "stencil decomposition readback commands",
    });
    encoder.copyBufferToBuffer(
      densityBuffer,
      0,
      readbackBuffer,
      0,
      outputByteLength
    );
    device.queue.submit([encoder.finish()]);

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    readbackMapped = true;
    const readback = new Float32Array(readbackBuffer.getMappedRange());
    const densityMaps = inkRgbs.map((_, index) => {
      const map = new Float32Array(pixelCount);
      map.set(readback.subarray(index * pixelCount, (index + 1) * pixelCount));
      return map;
    });

    return { densityMaps, angles, paper, inkRgbs, width, height };
  } finally {
    if (readbackMapped) readbackBuffer?.unmap();
    densityBuffer.destroy();
    readbackBuffer?.destroy();
  }
}
