import { useCallback, useEffect, useRef, useState } from "react";
import {
  RisographCanvas,
  type RisographCanvasHandle,
} from "./components/RisographCanvas";
import { RISO_INKS, PRESETS } from "./presets";
import {
  processRisograph,
  loadImage,
  getImageData,
  type RisographColor,
  type HalftoneMode,
  type ColorMode,
} from "./lib/risograph";
import { Download, Info, Moon, Sun } from "lucide-react";

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

const inkEntries = Object.entries(RISO_INKS);
const presetEntries = Object.entries(PRESETS);

const guide = {
  en: {
    title: "Guide",
    sections: [
      {
        heading: "Image",
        body: "Select an image file from your device. All processing runs entirely in your browser — no images are uploaded to any server.",
      },
      {
        heading: "Paper",
        body: "Choose the paper color to simulate different paper stocks. Enable \"Transparent\" to export with a transparent background instead of a paper color.",
      },
      {
        heading: "Ink Colors",
        body: "Select from preset color combinations, or build your own by adding individual risograph ink colors. Each ink becomes a separate color layer. Remove colors by clicking the × on each badge. Opacity controls how strongly the ink covers the paper.",
      },
      {
        heading: "Separation",
        body: "Controls how the image is decomposed into ink color layers.\n• Natural — Faithfully reproduces the original colors by blending inks proportionally.\n• Bold — Aggressively separates colors for a high-contrast, graphic look typical of artistic risograph prints.",
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
        body: "Simulates the slight misalignment between color layers that naturally occurs in risograph printing. Higher values make the offset more pronounced.",
      },
      {
        heading: "Noise",
        body: "Adds ink scuffing and uneven coverage typical of real risograph prints. Higher values create broader, more visible ink unevenness.",
      },
      {
        heading: "Download",
        body: "Export the result as a PNG image. Choose 1x, 2x, or 4x resolution for higher quality output.",
      },
      {
        heading: "License",
        body: "This tool is free to use. Copyright of the output images belongs to the owner of the original image.",
      },
    ],
  },
  ja: {
    title: "ガイド",
    sections: [
      {
        heading: "画像",
        body: "デバイスから画像ファイルを選択します。すべての処理はブラウザ内で完結し、画像がサーバーに送信されることはありません。",
      },
      {
        heading: "用紙",
        body: "用紙の色を選択して、異なる紙質をシミュレートできます。「Transparent」を有効にすると、用紙色の代わりに透明な背景で書き出せます。",
      },
      {
        heading: "インクカラー",
        body: "プリセットの配色から選択するか、個別のリソグラフインクカラーを追加して自由に組み合わせられます。各インクは独立した色版になります。バッジの×をクリックして色を削除できます。Opacityはインクの紙への乗り具合を調整します。",
      },
      {
        heading: "色分解 (Separation)",
        body: "画像をインクカラーにどのように分解するかを制御します。\n• Natural — インクを比例配合して元の色を忠実に再現します。\n• Bold — 色を大胆に分離し、リソグラフ印刷特有のコントラストの高いグラフィカルな仕上がりにします。",
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
        body: "リソグラフ印刷で自然に発生する色版のわずかなずれをシミュレートします。値を大きくするとずれが顕著になります。",
      },
      {
        heading: "ノイズ",
        body: "実際のリソグラフ印刷に見られるインクの掠れや色ムラを加えます。値を大きくすると、より広範囲にムラが現れます。",
      },
      {
        heading: "ダウンロード",
        body: "結果をPNG画像として書き出します。1x、2x、4xの解像度を選択して、より高品質な出力が可能です。",
      },
      {
        heading: "ライセンス",
        body: "本ツールは無料でご利用いただけます。出力画像の著作権は元画像の所有者に帰属します。",
      },
    ],
  },
} as const;

type GuideLang = "en" | "ja";

function App() {
  const [imageSrc, setImageSrc] = useState(SAMPLE_IMAGE);
  const [colors, setColors] = useState<RisographColor[]>([
    ...PRESETS.cmyk.colors,
  ]);
  const [dotSize, setDotSize] = useState(0.5);
  const [misregistration, setMisregistration] = useState(2);
  const [density, setDensity] = useState(1.5);
  const [inkOpacity, setInkOpacity] = useState(0.75);
  const [paperColor, setPaperColor] = useState("#f5f0e8");
  const [noise, setNoise] = useState(0);
  const [transparentBg, setTransparentBg] = useState(false);
  const [halftoneMode, setHalftoneMode] = useState<HalftoneMode>("fm");
  const [colorMode, setColorMode] = useState<ColorMode>("natural");
  const [downloadScale, setDownloadScale] = useState("1");
  const [addColorKey, setAddColorKey] = useState(inkEntries[0][0]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<RisographCanvasHandle>(null);
  const { dark, toggle: toggleTheme } = useTheme();
  const [guideLang, setGuideLang] = useState<GuideLang>("en");

  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    const scale = Number(downloadScale);

    // 1x: use preview canvas directly
    if (scale === 1) {
      const canvas = canvasRef.current?.getCanvas();
      if (!canvas) return;
      const link = document.createElement("a");
      link.download = "risograph.png";
      link.href = canvas.toDataURL("image/png");
      link.click();
      return;
    }

    // Higher res: re-render offscreen
    setDownloading(true);
    try {
      const img = await loadImage(imageSrc);
      const targetWidth = 600 * scale;
      const targetHeight = Math.round(
        (img.naturalHeight / img.naturalWidth) * targetWidth
      );
      const imageData = getImageData(img, targetWidth, targetHeight);
      const offscreen = document.createElement("canvas");
      processRisograph(imageData, offscreen, {
        colors,
        dotSize,
        misregistration,
        grain: 0,
        density,
        inkOpacity,
        paperColor,
        halftoneMode,
        colorMode,
        noise,
        transparentBg,
      });
      const link = document.createElement("a");
      link.download = "risograph.png";
      link.href = offscreen.toDataURL("image/png");
      link.click();
    } finally {
      setDownloading(false);
    }
  };

  const handlePresetChange = (key: string) => {
    const preset = PRESETS[key as keyof typeof PRESETS];
    if (preset) {
      setColors([...preset.colors]);
    }
  };

  const addColor = () => {
    const ink = RISO_INKS[addColorKey as keyof typeof RISO_INKS];
    if (ink) {
      setColors((prev) => [...prev, { ...ink }]);
    }
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
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      {/* Header */}
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Risograph Canvas
          </h1>
          <p className="text-sm text-muted-foreground">
            Multi-color risograph print simulator
          </p>
        </div>
        <div className="flex items-center gap-1">
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

      {/* Image */}
      <section className="mb-6">
        <Label className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
          Image
        </Label>
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
        >
          Choose File
        </Button>
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
          <div className="flex w-28 items-center gap-2">
            <input
              type="color"
              value={paperColor}
              onChange={(e) => setPaperColor(e.target.value)}
              disabled={transparentBg}
              className="h-8 w-8 shrink-0 cursor-pointer rounded border border-input bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-40"
            />
            <span className="font-mono text-[11px] text-muted-foreground">
              {transparentBg ? "transparent" : paperColor}
            </span>
          </div>
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
        <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Ink Colors
        </p>
        <div className="mb-3">
          <Label className="mb-2 text-xs text-muted-foreground">Preset</Label>
          <Select defaultValue="cmyk" onValueChange={handlePresetChange}>
            <SelectTrigger className="h-8 w-full sm:max-w-75 text-xs">
              <SelectValue />
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
          <div className="flex items-center gap-1.5">
            <Select value={addColorKey} onValueChange={setAddColorKey}>
              <SelectTrigger className="h-7 min-w-0 max-w-35 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {inkEntries.map(([key, ink]) => (
                  <SelectItem key={key} value={key} className="text-xs">
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full border border-black/10"
                        style={{ background: ink.color }}
                      />
                      {ink.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={addColor}
            >
              + Add
            </Button>
          </div>
        </div>
        <div className="mt-3 sm:w-1/2">
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
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
      </section>

      {/* Print */}
      <section className="mb-6">
        <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Print
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        </div>
      </section>

      {/* Canvas */}
      <div className="flex justify-center rounded-xl bg-muted/60 p-2 sm:p-6">
        <RisographCanvas
          ref={canvasRef}
          src={imageSrc}
          colors={colors}
          width={600}
          dotSize={dotSize}
          misregistration={misregistration}
          grain={0}
          density={density}
          inkOpacity={inkOpacity}
          paperColor={paperColor}
          halftoneMode={halftoneMode}
          colorMode={colorMode}
          noise={noise}
          transparentBg={transparentBg}
          className="shadow-lg"
        />
      </div>

      <div className="mt-4 flex items-center justify-center gap-2 sm:justify-end">
        <Select value={downloadScale} onValueChange={setDownloadScale}>
          <SelectTrigger className="h-8 w-28 text-xs">
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
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={handleDownload}
          disabled={downloading}
        >
          <Download className="h-3.5 w-3.5" />
          {downloading ? "Processing..." : "Download PNG"}
        </Button>
      </div>

      <footer className="mt-10 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground/50">
        <span>&copy; yukiyokotani</span>
        <span>&middot;</span>
        <a
          href="https://github.com/yukiyokotani/risograph-canvas"
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
