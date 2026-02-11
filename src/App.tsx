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
} from "./lib/risograph";
import { Download, Moon, Sun } from "lucide-react";

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
  const [downloadScale, setDownloadScale] = useState("1");
  const [addColorKey, setAddColorKey] = useState(inkEntries[0][0]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<RisographCanvasHandle>(null);
  const { dark, toggle: toggleTheme } = useTheme();

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <Label className="mb-2 text-xs text-muted-foreground">Mode</Label>
            <Select value={halftoneMode} onValueChange={(v) => setHalftoneMode(v as HalftoneMode)}>
              <SelectTrigger className="h-9 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fm" className="text-xs">FM</SelectItem>
                <SelectItem value="am" className="text-xs">AM</SelectItem>
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
          noise={noise}
          transparentBg={transparentBg}
          className="shadow-lg"
        />
      </div>

      <div className="mt-4 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-center text-[11px] text-muted-foreground/70 sm:text-left">
          All processing runs locally in your browser. No images are uploaded or sent to any server.
        </p>
        <div className="flex items-center justify-center gap-2 sm:justify-end">
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
