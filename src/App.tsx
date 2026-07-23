import { useCallback, useEffect, useRef, useState } from "react";
import {
  StencilCanvas,
  type StencilCanvasHandle,
} from "./components/StencilCanvas";
import { INKS, PRESETS } from "./presets";
import {
  loadImage,
  getImageData,
  type StencilColor,
  type StencilOptions,
  type HalftoneMode,
  type ColorMode,
} from "./lib/stencil";
import {
  Download,
  Info,
  Maximize,
  Moon,
  RotateCcw,
  Shuffle,
  Sun,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { usePanZoom } from "./hooks/usePanZoom";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

function useTheme() {
  const [dark, setDark] = useState(
    () => document.documentElement.classList.contains("dark")
  );

  const toggle = useCallback(() => {
    setDark((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle("dark", next);
      localStorage.setItem("theme", next ? "dark" : "light");
      return next;
    });
  }, []);

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      if (localStorage.getItem("theme")) return;
      const isDark = e.matches;
      setDark(isDark);
      document.documentElement.classList.toggle("dark", isDark);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return { dark, toggle };
}

const SAMPLE_IMAGE = `${import.meta.env.BASE_URL}sample.jpg`;

/** プレビューの基準描画幅(px)。ダウンロードの 1x はこの解像度になる。 */
const BASE_WIDTH = 600;

/**
 * Canvas を PNG として保存する。
 *
 * iOS Safari は `data:` URL + `download` 属性を尊重せず保存できないため、
 * `toBlob()` + `URL.createObjectURL()` + DOM に追加したアンカーのクリックで
 * ダウンロードする。タッチ端末では Web Share が使える場合それを優先する。
 */
async function saveImageFromCanvas(
  canvas: HTMLCanvasElement,
  filename: string
): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png")
  );
  if (!blob) return;

  // タッチ端末（iOS 等）では Web Share が最も確実に保存できる
  const file = new File([blob], filename, { type: "image/png" });
  const canShareFile =
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] }) &&
    window.matchMedia("(pointer: coarse)").matches;
  if (canShareFile) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (err) {
      // ユーザーがキャンセルした場合は二重保存しない
      if (err instanceof DOMException && err.name === "AbortError") return;
      // それ以外はフォールバックのダウンロードへ
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const inkEntries = Object.entries(INKS);
const presetEntries = Object.entries(PRESETS);

const PAPER_COLORS = [
  { name: "White", color: "#ffffff" },
  { name: "Cream", color: "#f5f0e8" },
  { name: "Ivory", color: "#fffff0" },
  { name: "Kraft", color: "#c4a97d" },
  { name: "Light Gray", color: "#e8e8e8" },
  { name: "Black", color: "#1a1a1a" },
];

const guide = {
  en: {
    title: "Guide",
    sections: [
      {
        heading: "Image",
        body: "Select an image file from your device. All processing runs entirely in your browser — no images are uploaded to any server.\n\nEnable \"Invert\" to reverse the tonal values of the input image. This is useful when printing light-colored inks (e.g. white) on dark paper — bright areas in the original become heavily inked.",
      },
      {
        heading: "Paper",
        body: "Choose the paper color to simulate different paper stocks. Enable \"Transparent\" to export with a transparent background instead of a paper color.",
      },
      {
        heading: "Ink Colors",
        body: "Select from preset color combinations, or build your own by adding individual stencil ink colors. Each ink becomes a separate color layer. Remove colors by clicking the × on each badge. Opacity controls how strongly the ink covers the paper.",
      },
      {
        heading: "Separation",
        body: "Controls how the image is decomposed into ink color layers.\n• Natural — Faithfully reproduces the original colors by blending inks proportionally.\n• Bold — Aggressively separates colors for a high-contrast, graphic look typical of artistic stencil prints.",
      },
      {
        heading: "Halftone Mode",
        body: "Determines how tonal gradation is expressed.\n• Dot Density — Dots are a fixed size; darker areas have more dots (stochastic screening).\n• Dot Size — Dots are arranged in a regular grid; darker areas have larger dots (classic halftone).",
      },
      {
        heading: "Dot Size",
        body: "Controls the size of halftone dots. Smaller values produce finer detail; larger values create a more visible dot pattern.",
      },
      {
        heading: "Density",
        body: "Scales the overall ink density. Higher values produce darker, more saturated prints.",
      },
      {
        heading: "Misregistration",
        body: "Simulates the slight misalignment between color layers that naturally occurs in stencil printing. Higher values make the offset more pronounced.",
      },
      {
        heading: "Noise",
        body: "Adds ink scuffing and uneven coverage typical of real stencil prints. Higher values create broader, more visible ink unevenness.",
      },
      {
        heading: "Download",
        body: "Export the result as a PNG image. Choose 1x, 2x, or 4x resolution for higher quality output.",
      },
      {
        heading: "License",
        body: "This tool is free to use for both personal and commercial purposes. Copyright of the output images belongs to the owner of the original image.",
      },
    ],
  },
  ja: {
    title: "ガイド",
    sections: [
      {
        heading: "画像",
        body: "デバイスから画像ファイルを選択します。すべての処理はブラウザ内で完結し、画像がサーバーに送信されることはありません。\n\n「Invert」を有効にすると入力画像の階調が反転されます。暗い紙に明るいインク（白など）で印刷する際に便利です。元画像の明るい部分にインクが多く乗るようになります。",
      },
      {
        heading: "用紙",
        body: "用紙の色を選択して、異なる紙質をシミュレートできます。「Transparent」を有効にすると、用紙色の代わりに透明な背景で書き出せます。",
      },
      {
        heading: "インクカラー",
        body: "プリセットの配色から選択するか、個別のステンシルインクカラーを追加して自由に組み合わせられます。各インクは独立した色版になります。バッジの×をクリックして色を削除できます。Opacityはインクの紙への乗り具合を調整します。",
      },
      {
        heading: "色分解 (Separation)",
        body: "画像をインクカラーにどのように分解するかを制御します。\n• Natural — インクを比例配合して元の色を忠実に再現します。\n• Bold — 色を大胆に分離し、ステンシル印刷特有のコントラストの高いグラフィカルな仕上がりにします。",
      },
      {
        heading: "ハーフトーンモード",
        body: "濃淡の表現方法を決定します。\n• Dot Density — 点のサイズは固定で、暗い部分ほど点の密度が高くなります（確率的スクリーニング）。\n• Dot Size — 点が規則的な格子状に並び、暗い部分ほど点が大きくなります（従来型ハーフトーン）。",
      },
      {
        heading: "ドットサイズ",
        body: "ハーフトーンの点の大きさを調整します。小さい値は細かいディテールを、大きい値は目に見えるドットパターンを生み出します。",
      },
      {
        heading: "濃度 (Density)",
        body: "インク全体の濃度をスケーリングします。高い値ほど濃く、彩度の高い仕上がりになります。",
      },
      {
        heading: "版ずれ (Misregistration)",
        body: "ステンシル印刷で自然に発生する色版のわずかなずれをシミュレートします。値を大きくするとずれが顕著になります。",
      },
      {
        heading: "ノイズ",
        body: "実際のステンシル印刷に見られるインクの掠れや色ムラを加えます。値を大きくすると、より広範囲にムラが現れます。",
      },
      {
        heading: "ダウンロード",
        body: "結果をPNG画像として書き出します。1x、2x、4xの解像度を選択して、より高品質な出力が可能です。",
      },
      {
        heading: "ライセンス",
        body: "本ツールは個人利用・商用利用を問わず無料でご利用いただけます。出力画像の著作権は元画像の所有者に帰属します。",
      },
    ],
  },
} as const;

type GuideLang = "en" | "ja";

const DEBOUNCE_COLOR_MS = 150;

function PaperColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Sync draft when parent value changes (e.g. from preset)
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (color: string) => {
    setDraft(color);
    onChange(color);
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  const handleDrag = (color: string) => {
    setDraft(color);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onChange(color), DEBOUNCE_COLOR_MS);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          disabled={disabled}
          className="h-8 w-8 shrink-0 rounded-full border border-input shadow-sm transition-colors hover:border-ring disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: draft }}
        />
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {PAPER_COLORS.map((pc) => (
            <button
              key={pc.color}
              title={pc.name}
              onClick={() => commit(pc.color)}
              className={`h-7 w-7 rounded-full border-2 transition-colors ${draft === pc.color ? "border-ring" : "border-transparent hover:border-input"}`}
              style={{ background: pc.color }}
            />
          ))}
        </div>
        <Separator className="mb-2" />
        <div className="flex items-center gap-2">
          <label className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-full border border-input">
            <input
              type="color"
              value={draft}
              onChange={(e) => handleDrag(e.target.value)}
              className="absolute -inset-1 cursor-pointer opacity-0"
            />
            <span
              className="block h-full w-full rounded-full"
              style={{ background: draft }}
            />
          </label>
          <Input
            value={draft}
            onChange={(e) => {
              const v = e.target.value;
              setDraft(v);
              if (/^#[0-9a-fA-F]{6}$/.test(v)) commit(v);
            }}
            onBlur={(e) => {
              let v = e.target.value.trim();
              if (!v.startsWith("#")) v = "#" + v;
              if (/^#[0-9a-fA-F]{6}$/.test(v)) commit(v);
            }}
            maxLength={7}
            className="h-7 flex-1 px-2 font-mono text-xs"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * インク色の追加ピッカー。
 * プリセットのインクパレットを候補として残しつつ、
 * スペクトラム(ネイティブカラーピッカー)や HEX 入力で任意の色を選べる。
 */
function AddInkColorPicker({
  onAdd,
}: {
  onAdd: (color: StencilColor) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("#3366cc");

  const addCustom = () => {
    let v = custom.trim();
    if (!v.startsWith("#")) v = "#" + v;
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
    const hex = v.toUpperCase();
    onAdd({ name: hex, color: hex });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-9 text-xs">
          + Add
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        {/* プリセットのインクパレット（候補） */}
        <div className="mb-2 max-h-40 overflow-y-auto">
          <div className="flex flex-wrap gap-1.5">
            {inkEntries.map(([key, ink]) => (
              <button
                key={key}
                title={ink.name}
                onClick={() => {
                  onAdd({ ...ink });
                  setOpen(false);
                }}
                className="h-7 w-7 rounded-full border-2 border-transparent shadow-sm transition-colors hover:border-ring"
                style={{ background: ink.color }}
              />
            ))}
          </div>
        </div>
        <Separator className="mb-2" />
        {/* 任意の色（スペクトラム + HEX） */}
        <div className="flex items-center gap-2">
          <label className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-full border border-input">
            <input
              type="color"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="absolute -inset-1 cursor-pointer opacity-0"
            />
            <span
              className="block h-full w-full rounded-full"
              style={{ background: custom }}
            />
          </label>
          <Input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addCustom();
            }}
            maxLength={7}
            className="h-7 flex-1 px-2 font-mono text-xs"
          />
          <Button size="sm" className="h-7 px-2 text-xs" onClick={addCustom}>
            Add
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function App() {
  const [imageSrc, setImageSrc] = useState(SAMPLE_IMAGE);
  const [colors, setColors] = useState<StencilColor[]>([
    ...PRESETS.tricolor.colors,
  ]);
  const [dotSize, setDotSize] = useState(0.5);
  const [misregistration, setMisregistration] = useState(2);
  const [density, setDensity] = useState(1.5);
  const [inkOpacity, setInkOpacity] = useState(0.75);
  const [paperColor, setPaperColor] = useState("#f5f0e8");
  const [noise, setNoise] = useState(0);
  const [transparentBg, setTransparentBg] = useState(false);
  const [invert, setInvert] = useState(false);
  const [halftoneMode, setHalftoneMode] = useState<HalftoneMode>("fm");
  const [colorMode, setColorMode] = useState<ColorMode>("natural");
  const [gamutCutoff, setGamutCutoff] = useState(0.5);
  const [highlightCutoff, setHighlightCutoff] = useState(0);
  const [downloadScale, setDownloadScale] = useState("1");
  const [presetKey, setPresetKey] = useState("cmyk");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<StencilCanvasHandle>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const panzoom = usePanZoom(previewRef);
  const { dark, toggle: toggleTheme } = useTheme();
  const [guideLang, setGuideLang] = useState<GuideLang>("en");

  const [downloading, setDownloading] = useState(false);

  // Track image aspect ratio (width / height)
  const [imageAspect, setImageAspect] = useState<number | null>(null);
  useEffect(() => {
    setImageAspect(null);
    loadImage(imageSrc).then((img) => {
      setImageAspect(img.naturalWidth / img.naturalHeight);
    });
  }, [imageSrc]);

  // Measure available space in preview container
  const [containerSize, setContainerSize] = useState({ width: 600, height: 400 });
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setContainerSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Track whether we're in the lg two-column layout (matches Tailwind lg: breakpoint)
  const [isLgLayout, setIsLgLayout] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => setIsLgLayout(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Compute canvas width that fits within container (accounting for padding)
  const canvasWidth = (() => {
    if (!imageAspect) return 600;
    const pad = isLgLayout ? 48 : 24; // lg:p-6 = 24*2, p-3 = 12*2
    const availW = containerSize.width - pad;
    if (!isLgLayout) {
      // Mobile/tablet: scrollable layout, no height constraint
      return Math.max(100, Math.min(600, availW));
    }
    const availH = containerSize.height - pad;
    const widthFromHeight = availH * imageAspect;
    return Math.max(100, Math.min(600, availW, widthFromHeight));
  })();

  const handleDownload = async () => {
    const scale = Number(downloadScale);

    // 1x: プレビュー Canvas をそのまま保存（＝ベース解像度）
    if (scale === 1) {
      const canvas = canvasRef.current?.getCanvas();
      if (!canvas) return;
      await saveImageFromCanvas(canvas, "stencil.png");
      return;
    }

    // 高解像度: Web Worker でオフスレッド処理し、プレビューを忠実にスケールアップ。
    // renderScale によりドットサイズ・版ずれ等をベースの scale 倍にするため、
    // 点が細かくなるのではなくプレビューがそのまま高解像度化される。
    setDownloading(true);
    try {
      const img = await loadImage(imageSrc);
      const targetWidth = BASE_WIDTH * scale;
      const targetHeight = Math.round(
        (img.naturalHeight / img.naturalWidth) * targetWidth
      );
      const imageData = getImageData(img, targetWidth, targetHeight);
      const options: StencilOptions = {
        colors,
        dotSize,
        misregistration,
        grain: 0,
        density,
        inkOpacity,
        paperColor,
        halftoneMode,
        colorMode,
        gamutThreshold: gamutCutoff,
        highlightCutoff,
        noise,
        transparentBg,
        invert,
        renderScale: scale,
      };

      const pixels = await new Promise<Uint8ClampedArray>((resolve, reject) => {
        const worker = new Worker(
          new URL("./lib/stencil.worker.ts", import.meta.url),
          { type: "module" },
        );
        worker.onmessage = (e: MessageEvent<Uint8ClampedArray>) => {
          resolve(e.data);
          worker.terminate();
        };
        worker.onerror = (e) => {
          reject(new Error(e.message));
          worker.terminate();
        };
        worker.postMessage({
          data: imageData.data,
          width: imageData.width,
          height: imageData.height,
          options,
        });
      });

      const offscreen = document.createElement("canvas");
      offscreen.width = targetWidth;
      offscreen.height = targetHeight;
      const ctx = offscreen.getContext("2d")!;
      const output = ctx.createImageData(targetWidth, targetHeight);
      output.data.set(pixels);
      ctx.putImageData(output, 0, 0);

      await saveImageFromCanvas(offscreen, "stencil.png");
    } finally {
      setDownloading(false);
    }
  };

  const handlePresetChange = (key: string) => {
    const preset = PRESETS[key as keyof typeof PRESETS];
    if (preset) {
      setPresetKey(key);
      setColors([...preset.colors]);
    }
  };

  const addColor = (color: StencilColor) => {
    setColors((prev) => [...prev, color]);
  };

  /**
   * 設定をランダムに振る（当たりをつける用）。
   * インク色は崩壊を避けるためプリセットから自動選択し、
   * 点のサイズ・濃度・ハーフトーンモード・色分解モードをシャッフルする。
   */
  const randomize = () => {
    const pick = <T,>(arr: readonly T[]): T =>
      arr[Math.floor(Math.random() * arr.length)];

    // インク色: プリセットから1つ選ぶ（完全ランダムだと崩壊するため）
    const [key, preset] = pick(presetEntries);
    setPresetKey(key);
    setColors([...preset.colors]);

    // 点のサイズ / 濃度 / モード（極端に崩れない範囲で）
    setDotSize(pick([0.5, 1, 1.5, 2, 3, 4, 6]));
    setDensity(pick([1, 1.2, 1.4, 1.6, 1.8, 2]));
    setHalftoneMode(pick<HalftoneMode>(["fm", "am"]));
    setColorMode(pick<ColorMode>(["natural", "bold"]));
    setGamutCutoff(pick([0.3, 0.5, 0.7]));
  };

  const removeColor = (index: number) => {
    setColors((prev) => prev.filter((_, i) => i !== index));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setImageSrc(url);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:flex lg:h-screen lg:flex-col lg:overflow-hidden lg:py-6">
      {/* シャッフルボタンのアイコン用: 青紫のアニメーショングラデーション定義 */}
      <svg
        aria-hidden="true"
        width="0"
        height="0"
        style={{ position: "absolute" }}
      >
        <defs>
          <linearGradient
            id="shuffleGrad"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2="24"
            y2="0"
            spreadMethod="repeat"
          >
            {/* 青→紫→モーヴ(淡ピンク)。0% と 100% を同色にして継ぎ目なくループ（シアンなし、鮮やかめ） */}
            <stop offset="0%" stopColor="#3568d8" />
            <stop offset="25%" stopColor="#7d5fe8" />
            <stop offset="50%" stopColor="#c85fda" />
            <stop offset="75%" stopColor="#7d5fe8" />
            <stop offset="100%" stopColor="#3568d8" />
            <animateTransform
              attributeName="gradientTransform"
              type="translate"
              from="0 0"
              to="24 0"
              dur="2.6s"
              repeatCount="indefinite"
            />
          </linearGradient>
        </defs>
      </svg>
      {/* Header */}
      <div className="mb-8 flex items-start justify-between lg:mb-4 lg:shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Stencil Canvas
          </h1>
          <p className="text-sm text-muted-foreground">
            Multi-color stencil print simulator
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={randomize}
            className="h-9 w-9 shrink-0"
            title="Randomize settings"
          >
            <Shuffle
              className="h-5 w-5"
              strokeWidth={2.5}
              style={{ stroke: "url(#shuffleGrad)" }}
            />
            <span className="sr-only">Randomize settings</span>
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0">
                <Info className="h-4 w-4" />
                <span className="sr-only">Guide</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
              <DialogHeader>
                <div className="flex items-center justify-between pr-6">
                  <DialogTitle>{guide[guideLang].title}</DialogTitle>
                  <button
                    onClick={() => setGuideLang((l) => (l === "ja" ? "en" : "ja"))}
                    className="rounded border border-input px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent"
                  >
                    {guideLang === "ja" ? "English" : "日本語"}
                  </button>
                </div>
              </DialogHeader>
              <div className="space-y-4">
                {guide[guideLang].sections.map((s) => (
                  <div key={s.heading}>
                    <h3 className="mb-1 text-sm font-medium">{s.heading}</h3>
                    <p className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                      {s.body}
                    </p>
                  </div>
                ))}
              </div>
            </DialogContent>
          </Dialog>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className="h-9 w-9 shrink-0"
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            <span className="sr-only">Toggle theme</span>
          </Button>
        </div>
      </div>

      <div className="lg:flex lg:min-h-0 lg:flex-1 lg:gap-8">
        {/* Controls (left on desktop) */}
        <div className="sidebar-scroll lg:w-80 lg:shrink-0 lg:overflow-y-scroll lg:py-2 lg:pr-6">
          {/* Image */}
          <section className="mb-6">
            <Label className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
              Image
            </Label>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                className="h-9 text-xs"
                onClick={() => fileInputRef.current?.click()}
              >
                Choose File
              </Button>
              <div className="flex items-center gap-1.5">
                <Checkbox
                  id="invert"
                  checked={invert}
                  onCheckedChange={(v: boolean) => setInvert(v)}
                />
                <Label htmlFor="invert" className="text-xs text-muted-foreground">
                  Invert
                </Label>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
            <p className="mt-2 text-[11px] text-muted-foreground/70">
              All processing runs locally in your browser. No images are uploaded or sent to any server.
            </p>
          </section>

          <Separator className="mb-6" />

          {/* Paper */}
          <section className="mb-6">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Paper
            </p>
            <div className="flex items-center gap-3">
              <PaperColorPicker
                value={paperColor}
                onChange={setPaperColor}
                disabled={transparentBg}
              />
              <span className="font-mono text-[11px] text-muted-foreground">
                {transparentBg ? "transparent" : paperColor}
              </span>
              <div className="flex items-center gap-1.5">
                <Checkbox
                  id="transparent-bg"
                  checked={transparentBg}
                  onCheckedChange={(v: boolean) => setTransparentBg(v)}
                />
                <Label htmlFor="transparent-bg" className="text-xs text-muted-foreground">
                  Transparent
                </Label>
              </div>
            </div>
          </section>

          <Separator className="mb-6" />

          {/* Ink Colors */}
          <section className="mb-6">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Ink Colors
              </p>
              {colors.length > 0 && (
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => { setColors([]); setPresetKey(""); }}
                >
                  <RotateCcw className="h-3 w-3" /> Reset
                </button>
              )}
            </div>
            <div className="mb-3">
              <Label className="mb-2 text-xs text-muted-foreground">Preset</Label>
              <Select value={presetKey} onValueChange={handlePresetChange}>
                <SelectTrigger className="h-9 w-full text-xs">
                  <SelectValue placeholder="Select preset..." />
                </SelectTrigger>
                <SelectContent>
                  {presetEntries.map(([key, preset]) => (
                    <SelectItem key={key} value={key} className="text-xs">
                      {preset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {colors.map((c, i) => (
                <Badge
                  key={`${c.name}-${i}`}
                  variant="secondary"
                  className="gap-1.5 py-1 pl-1.5 pr-1 text-xs font-normal"
                >
                  <span
                    className="inline-block h-3 w-3 rounded-full border border-black/10"
                    style={{ background: c.color }}
                  />
                  {c.name}
                  <button
                    onClick={() => removeColor(i)}
                    className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                  >
                    ×
                  </button>
                </Badge>
              ))}
              <AddInkColorPicker onAdd={addColor} />
            </div>
            <div className="mt-3">
              <Label className="mb-2 text-xs text-muted-foreground">Opacity</Label>
              <Slider
                value={[inkOpacity]}
                onValueChange={([v]) => setInkOpacity(v)}
                min={0.1}
                max={1}
                step={0.05}
                className="mt-2"
              />
              <span className="mt-1 block text-right font-mono text-[11px] text-muted-foreground">
                {Math.round(inkOpacity * 100)}%
              </span>
            </div>
          </section>

          <Separator className="mb-6" />

          {/* Halftone */}
          <section className="mb-6">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Halftone
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4 lg:grid-cols-2">
              <div>
                <Label className="mb-2 text-xs text-muted-foreground">Separation</Label>
                <Select value={colorMode} onValueChange={(v) => setColorMode(v as ColorMode)}>
                  <SelectTrigger className="h-9 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="natural" className="text-xs">Natural</SelectItem>
                    <SelectItem value="bold" className="text-xs">Bold</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="mb-2 text-xs text-muted-foreground">Mode</Label>
                <Select value={halftoneMode} onValueChange={(v) => setHalftoneMode(v as HalftoneMode)}>
                  <SelectTrigger className="h-9 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fm" className="text-xs">Dot Density</SelectItem>
                    <SelectItem value="am" className="text-xs">Dot Size</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="mb-2 text-xs text-muted-foreground">Dot Size</Label>
                <Slider
                  value={[dotSize]}
                  onValueChange={([v]) => setDotSize(v)}
                  min={0.5}
                  max={12}
                  step={0.5}
                  className="mt-2"
                />
                <span className="mt-1 block text-right font-mono text-[11px] text-muted-foreground">
                  {dotSize.toFixed(1)}px
                </span>
              </div>
              <div>
                <Label className="mb-2 text-xs text-muted-foreground">Density</Label>
                <Slider
                  value={[density]}
                  onValueChange={([v]) => setDensity(v)}
                  min={0.5}
                  max={2}
                  step={0.1}
                  className="mt-2"
                />
                <span className="mt-1 block text-right font-mono text-[11px] text-muted-foreground">
                  {density.toFixed(1)}
                </span>
              </div>
            </div>
            {colorMode === "bold" && (
              <div className="mt-4">
                <Label className="mb-2 text-xs text-muted-foreground">
                  Off-gamut cutoff
                </Label>
                <Slider
                  value={[gamutCutoff]}
                  onValueChange={([v]) => setGamutCutoff(v)}
                  min={0}
                  max={1}
                  step={0.05}
                  className="mt-2"
                />
                <span className="mt-1 block text-right font-mono text-[11px] text-muted-foreground">
                  {Math.round(gamutCutoff * 100)}%
                </span>
              </div>
            )}
          </section>

          {/* Print */}
          <section className="mb-6">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Print
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
              <div>
                <Label className="mb-2 text-xs text-muted-foreground">Misregistration</Label>
                <Slider
                  value={[misregistration]}
                  onValueChange={([v]) => setMisregistration(v)}
                  min={0}
                  max={8}
                  step={0.5}
                  className="mt-2"
                />
                <span className="mt-1 block text-right font-mono text-[11px] text-muted-foreground">
                  {misregistration}px
                </span>
              </div>
              <div>
                <Label className="mb-2 text-xs text-muted-foreground">Noise</Label>
                <Slider
                  value={[noise]}
                  onValueChange={([v]) => setNoise(v)}
                  min={0}
                  max={0.5}
                  step={0.05}
                  className="mt-2"
                />
                <span className="mt-1 block text-right font-mono text-[11px] text-muted-foreground">
                  {noise.toFixed(2)}
                </span>
              </div>
              <div>
                <Label className="mb-2 text-xs text-muted-foreground">
                  Highlight cutoff
                </Label>
                <Slider
                  value={[highlightCutoff]}
                  onValueChange={([v]) => setHighlightCutoff(v)}
                  min={0}
                  max={0.3}
                  step={0.01}
                  className="mt-2"
                />
                <span className="mt-1 block text-right font-mono text-[11px] text-muted-foreground">
                  {Math.round(highlightCutoff * 100)}%
                </span>
              </div>
            </div>
          </section>
        </div>

        {/* Preview (right on desktop) */}
        <div className="mt-8 lg:mt-0 lg:flex lg:flex-1 lg:min-w-0 lg:flex-col">
          {/* Canvas area (zoom / pan) */}
          <div
            ref={previewRef}
            className="relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-xl bg-muted/60 p-3 lg:p-6"
            style={{
              touchAction: "none",
              cursor:
                panzoom.zoom > 1
                  ? panzoom.dragging
                    ? "grabbing"
                    : "grab"
                  : "default",
            }}
            {...panzoom.handlers}
          >
            {imageAspect ? (
              <>
                <div
                  style={{
                    transform: panzoom.transform,
                    transformOrigin: "center center",
                    willChange: "transform",
                    lineHeight: 0,
                  }}
                >
                  <StencilCanvas
                    ref={canvasRef}
                    src={imageSrc}
                    colors={colors}
                    width={BASE_WIDTH}
                    dotSize={dotSize}
                    misregistration={misregistration}
                    grain={0}
                    density={density}
                    inkOpacity={inkOpacity}
                    paperColor={paperColor}
                    halftoneMode={halftoneMode}
                    colorMode={colorMode}
                    gamutThreshold={gamutCutoff}
                    highlightCutoff={highlightCutoff}
                    noise={noise}
                    transparentBg={transparentBg}
                    invert={invert}
                    className={transparentBg ? "shadow-lg checkerboard" : "shadow-lg"}
                    style={{ width: Math.round(canvasWidth), height: "auto" }}
                  />
                </div>

                {/* Zoom controls */}
                <div
                  className="absolute inset-x-0 bottom-0 flex justify-end p-3"
                  style={{ pointerEvents: "none" }}
                >
                  <div
                    className="flex items-center gap-0.5 rounded-lg border bg-background/80 p-1 shadow-sm backdrop-blur"
                    style={{ pointerEvents: "auto" }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    {!panzoom.isDefault && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={panzoom.reset}
                          aria-label="Reset view"
                          title="Reset view"
                        >
                          <Maximize className="h-4 w-4" />
                        </Button>
                        <Separator orientation="vertical" className="mx-0.5 h-4" />
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={panzoom.zoomOut}
                      disabled={!panzoom.canZoomOut}
                      aria-label="Zoom out"
                    >
                      <ZoomOut className="h-4 w-4" />
                    </Button>
                    <span className="min-w-[3.5ch] text-center text-xs tabular-nums text-muted-foreground">
                      {Math.round(panzoom.zoom * 100)}%
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={panzoom.zoomIn}
                      disabled={!panzoom.canZoomIn}
                      aria-label="Zoom in"
                    >
                      <ZoomIn className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Loading…</span>
            )}
          </div>

          {/* Download bar: always visible */}
          <div className="mt-4 flex shrink-0 items-center justify-center gap-2 sm:justify-end">
            <Select value={downloadScale} onValueChange={setDownloadScale}>
              <SelectTrigger className="h-9 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1" className="text-xs">1x (600px)</SelectItem>
                <SelectItem value="2" className="text-xs">2x (1200px)</SelectItem>
                <SelectItem value="4" className="text-xs">4x (2400px)</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              className="h-9 shrink-0 gap-1.5 text-xs"
              onClick={handleDownload}
              disabled={downloading}
            >
              <Download className="h-3.5 w-3.5" />
              {downloading ? "Processing..." : "Download PNG"}
            </Button>
          </div>
        </div>
      </div>

      <footer className="mt-10 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground/50 lg:shrink-0">
        <span>&copy; yukiyokotani</span>
        <span>&middot;</span>
        <a
          href="https://github.com/yukiyokotani/stencil-canvas"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:text-muted-foreground"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
          </svg>
          GitHub
        </a>
      </footer>
    </div>
  );
}

export default App;
