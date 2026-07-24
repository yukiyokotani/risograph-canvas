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
}

/** RGBA 8bit ピクセル (length = width*height*4) を返す。 */
export async function renderStencilWebGPU(
  _device: GPUDevice,
  _input: GpuStencilInput
): Promise<Uint8ClampedArray> {
  const device = _device;
  const input = _input;
  const {
    densityMaps,
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
  } = input;

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
  const cellSize = halftoneMode === "am" ? dotSize + 2 : dotSize;
  const dotRadius = dotSize * 0.5;
  const ss = cellSize >= 9 ? 2 : cellSize >= 4.5 ? 3 : 4;
  const searchRange = Math.max(1, Math.ceil(dotRadius / cellSize));
  const outputByteLength = pixelCount * 4;
  const densityByteLength = pixelCount * inkCount * Float32Array.BYTES_PER_ELEMENT;
  const inkStrideFloats = 8;
  const inkByteLength = inkCount * inkStrideFloats * Float32Array.BYTES_PER_ELEMENT;

  if (
    outputByteLength > device.limits.maxStorageBufferBindingSize ||
    densityByteLength > device.limits.maxStorageBufferBindingSize ||
    inkByteLength > device.limits.maxStorageBufferBindingSize
  ) {
    throw new Error("stencil input exceeds this device's storage-buffer limit");
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
  return min(densityMaps[mapOffset + pixelOffset] * params.densityScale, 1.0);
}

fn cellHash(x: i32, y: i32) -> f32 {
  // u32 arithmetic supplies the same modulo-2^32 behavior as |0 and
  // Math.imul in the JavaScript reference.
  var hash = bitcast<u32>(x) * 374761393u + bitcast<u32>(y) * 668265263u;
  hash = (hash ^ (hash >> 13u)) * 1274126177u;
  hash = hash ^ (hash >> 16u);
  return f32(hash) * (1.0 / 4294967296.0);
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
    var coverage = 0.0;
    if (params.mode == 0u) {
      coverage = amCoverage(pixelX, pixelY, inkIndex);
    } else {
      coverage = fmCoverage(pixelX, pixelY, inkIndex);
    }

    if (coverage < 0.004) {
      continue;
    }

    let ink = inks[inkIndex];
    let a = coverage * params.inkOpacity;
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
    if (!paperIsWhite && inverseAlpha >= 0.004) {
      red = f32(roundToByte(red + (params.paperR - 255.0) * inverseAlpha));
      green = f32(roundToByte(green + (params.paperG - 255.0) * inverseAlpha));
      blue = f32(roundToByte(blue + (params.paperB - 255.0) * inverseAlpha));
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
    size: 64,
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
  paramsBuffer.unmap();

  // WebGPU does not permit zero-sized buffers. One dummy element is enough
  // for the zero-ink case because the shader never enters its ink loop.
  const densityBuffer = device.createBuffer({
    label: "stencil density maps",
    size: Math.max(4, densityByteLength),
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  const densityUpload = new Float32Array(densityBuffer.getMappedRange());
  for (let inkIndex = 0; inkIndex < inkCount; inkIndex++) {
    densityUpload.set(densityMaps[inkIndex], inkIndex * pixelCount);
  }
  densityBuffer.unmap();

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
        { binding: 1, resource: { buffer: densityBuffer } },
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
    densityBuffer.destroy();
    inkBuffer.destroy();
    outputBuffer.destroy();
    readbackBuffer.destroy();
  }
}
