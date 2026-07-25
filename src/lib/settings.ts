import type { StencilColor, HalftoneMode, PaperTexture } from "./stencil";

/**
 * 復元対象の設定一式（画像は含めない）。
 * 履歴（サムネ付き）と Undo/Redo が共有する。
 */
export interface StencilSettings {
  colors: StencilColor[];
  dotSize: number;
  misregistration: number;
  density: number;
  inkOpacity: number;
  paperColor: string;
  halftoneMode: HalftoneMode;
  /** 色分解の強さ 0–1（0=忠実 / 1=グラフィック） */
  separation: number;
  blackGeneration?: number;
  highlightCutoff: number;
  paperTexture: PaperTexture;
  paperTextureAmount: number;
  noise: number;
  transparentBg: boolean;
  invert: boolean;
}
