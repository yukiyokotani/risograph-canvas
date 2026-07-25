import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  StencilCanvas,
  type StencilCanvasHandle,
} from "./components/StencilCanvas";
import { INK_GROUPS, PRESETS } from "./presets";
import { hexToRgb, rgbToLab } from "./lib/color";
import {
  getGpuDevice,
  renderStencilPixelsGpuOnly,
} from "./lib/stencilRenderer";
import { MAX_INKS } from "./lib/stencilDecomposeGpu";
import {
  loadImage,
  getImageData,
  type StencilColor,
  type StencilOptions,
  type HalftoneMode,
  type ColorMode,
  type PaperTexture,
} from "./lib/stencil";
import {
  Download,
  History,
  Info,
  Loader2,
  Maximize,
  Moon,
  RotateCcw,
  Shuffle,
  Sun,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
// Discover はダイアログを開くまで要らない（21KB 相当）。初回描画から外す。
const DiscoverDialog = lazy(() =>
  import("./components/DiscoverDialog").then((m) => ({ default: m.DiscoverDialog }))
);
import { DISCOVER_FIXED, type Candidate } from "./lib/discover";
import { usePanZoom } from "./hooks/usePanZoom";
import { useSettingsHistory } from "./hooks/useSettingsHistory";
import {
  useRecentSettings,
  type StencilSettings,
} from "./hooks/useRecentSettings";
import { useVisualHistory } from "./hooks/useVisualHistory";

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
 * ガラス調コントロールの共通サーフェス（半透明の背景＋blur＋枠）。
 * コントロールパネル・ズーム・ダウンロードの背景色を統一するための定数。
 * 角丸/影/余白は各要素側で付与する。
 */
const GLASS_SURFACE = "border bg-background/70 backdrop-blur-md";

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

const presetEntries = Object.entries(PRESETS);

/** 与えられたインク列と完全に一致するプリセットのキー（無ければ ""） */
function matchPresetKey(colors: readonly StencilColor[]): string {
  const signature = colors.map((c) => c.color.toUpperCase()).join(",");
  for (const [key, preset] of presetEntries) {
    if (preset.colors.map((c) => c.color.toUpperCase()).join(",") === signature) {
      return key;
    }
  }
  return "";
}

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
        body: "Choose an image from your device. Everything is processed locally in your browser — nothing is uploaded.\n\nInvert tones flips the input image's tones (light ↔ dark) before printing. Useful when printing a light ink (e.g. white) on dark paper, so bright areas become heavily inked.",
      },
      {
        heading: "Paper",
        body: "Set the paper color to simulate different stocks. Texture adds a paper surface — Felt or Fiber — with adjustable strength. Enable Transparent to drop the paper entirely: only the ink remains, exported over a transparent background.",
      },
      {
        heading: "Ink Colors",
        body: "Pick a preset combination, or build your own by adding inks. Each ink prints as its own screen at a different angle. Remove an ink with the × on its badge. Opacity sets how opaquely the inks sit on the paper — lower values give more translucent, multiply-like overlaps where inks meet.",
      },
      {
        heading: "Separation",
        body: "How the image is split into ink layers.\n• Natural — reproduces the original colors. Saturated colors the inks can't mix (e.g. green with blue+pink) resolve to the nearest single ink instead of a muddy overlap, keeping them clean and bright. Best for photographic gradients.\n• Bold — punchier, high-contrast separation for a graphic look (see Separation strength).",
      },
      {
        heading: "Halftone Mode",
        body: "How tone is rendered.\n• Dot Size — dots sit on a regular grid and grow larger in darker areas (classic AM halftone). Gradients are carried by smooth dot-size modulation.\n• Dot Density — fixed-size dots placed by probability; darker areas get more dots (stochastic / FM screening).",
      },
      {
        heading: "Dot Size",
        body: "Base dot pitch of the screen. Smaller values give a finer screen with more detail; larger values create a bolder, more visible dot pattern.",
      },
      {
        heading: "Density",
        body: "Below 1, this simply thins the ink — the whole print gets lighter.\n\nAbove 1 it works as tonal punch rather than a flat boost: midtones pivot, so dark areas close up toward solid while light areas open up. A flat boost would push every tone into the range where neighbouring dots merge, and whole areas of different tone would flatten into one solid patch (most visible with a large Dot Size). Pivoting keeps the deepest tone near solid while the tone just below it stays as distinct, large dots — so you get heavy dots and still read the boundaries.",
      },
      {
        heading: "Separation strength",
        body: "Only active with Bold. Sets how hard out-of-gamut colors snap toward a single ink instead of mixing. Higher values give cleaner, more posterized single-ink areas; lower values keep more two-ink blending. Neutrals, in-gamut colors, and deep shadows always keep both inks. No effect in Natural.",
      },
      {
        heading: "Black generation",
        body: "Only shown when the palette includes a black or gray ink. Like real printing (GCR), the neutral/gray part of an image is carried by the black ink instead of muddy overlaps of the colored inks — so grays and shadows stay clean while saturated colors keep their vibrancy (no black is added to them). Higher values put more of the neutral tone into black; 0 uses almost no black.",
      },
      {
        heading: "Misregistration",
        body: "Simulates the slight offset between color layers that naturally occurs in stencil / riso printing. Higher values make the offset more pronounced.",
      },
      {
        heading: "Noise",
        body: "Adds ink scuffing and uneven coverage typical of real stencil prints. Higher values create broader, more visible unevenness.",
      },
      {
        heading: "Highlight cutoff",
        body: "Blows out the highlights: ink is pulled back across the light end so near-white areas open up. Rather than cutting the faint tones off, it rolls them down smoothly, so highlights thin out into many progressively smaller dots instead of leaving a few isolated ones that read as noise. The very faintest tones still fall away, which keeps stray dots from JPEG noise or anti-aliasing out of near-white areas.",
      },
      {
        heading: "Toolbar",
        body: "At the top of the panel:\n• History (clock) — reopen recently used settings and apply one again.\n• Shuffle — randomize the settings for quick exploration.\n• Guide (i) — this help.\n• Theme — toggle light / dark.",
      },
      {
        heading: "Undo / Redo & preview",
        body: "Undo a settings change with Ctrl/⌘ + Z, and redo with Ctrl/⌘ + Y or Ctrl/⌘ + Shift + Z. Changing the image clears the history. On the preview: scroll to zoom toward the cursor, drag to pan. On mobile, drag the handle at the top of the panel to resize it.",
      },
      {
        heading: "Download",
        body: "Export the result as a PNG. 1x / 2x / 4x render the same look at higher resolution (dots stay proportional, so it's a faithful scale-up of the preview).",
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
        body: "デバイスから画像を選択します。処理はすべてブラウザ内で完結し、画像がアップロードされることはありません。\n\n「Invert tones」は入力画像の階調（明↔暗）を反転してから印刷します。暗い紙に明るいインク（白など）で刷るときに便利で、元画像の明るい部分にインクが多く乗ります。",
      },
      {
        heading: "用紙 (Paper)",
        body: "用紙色を選んで紙質をシミュレートします。Texture は紙の地合い（Felt / Fiber）を強さ付きで加えます。「Transparent」を有効にすると用紙を無くし、インクだけを透明背景の上に書き出せます。",
      },
      {
        heading: "インクカラー (Ink Colors)",
        body: "プリセットの配色から選ぶか、インクを追加して自由に組み合わせます。各インクは異なる角度の独立した色版として刷られます。バッジの×で色を削除できます。Opacity はインクの乗り具合で、低くするほど半透明（乗算的）になり重なり部分の混色が出ます。",
      },
      {
        heading: "色分解 (Separation)",
        body: "画像をインクの色版にどう分解するかを制御します。\n• Natural — 元の色を忠実に再現します。インクで混色できない鮮やかな色（例: 青+ピンクでの緑）は、濁った重なりにせず最も近い単色インクへ寄せて、澄んだ発色を保ちます。写真的なグラデーション向き。\n• Bold — コントラストの高いグラフィカルな色分離（下の Separation strength 参照）。",
      },
      {
        heading: "ハーフトーンモード",
        body: "濃淡の表現方法を決めます。\n• Dot Size — 点が規則格子に並び、暗い部分ほど点が大きくなります（従来型 AM 網点）。階調は滑らかなドットサイズ変調で表現されます。\n• Dot Density — 点のサイズは固定で、暗い部分ほど点の密度が上がります（確率的 / FM スクリーニング）。",
      },
      {
        heading: "ドットサイズ (Dot Size)",
        body: "網点の基本ピッチです。小さいほど細かい網点でディテールが出ます。大きいほど目立つドットパターンになります。",
      },
      {
        heading: "濃度 (Density)",
        body: "1 未満はインク量そのものを薄くします（全体が淡くなります）。\n\n1 を超える領域では「一律に濃くする」のではなく、中間調を軸にトーンを立てます（濃い側は詰まり、薄い側は抜ける）。一律に濃くすると全部のトーンが「隣の点と融合する濃さ」まで押し上げられ、色や明るさの違う面同士が同じベタ面に潰れてしまいます（Dot Size が大きいほど顕著）。中間調を軸にすることで、最暗部だけがベタ近くまで詰まり、その一段下は大きな点のまま残るので、点の力強さと境界の見分けやすさが両立します。",
      },
      {
        heading: "分離の強さ (Separation strength)",
        body: "Bold でのみ有効です。ガモット外の色をどれだけ強く単色へ寄せる（混色させない）かを決めます。値を大きくするほどクリーンでポスター調の単色域になり、小さいほど2色の混色を残します。中立色・ガモット内の色・深い影は常に2色を保ちます。Natural では効果はありません。",
      },
      {
        heading: "黒生成 (Black generation)",
        body: "黒またはグレーのインクを含む構成のときだけ表示されます。実際の印刷（GCR）と同じく、画像の中立（グレー）な部分を、有彩色インクの濁った重なりではなく黒インクで表現します。これでグレーや影はクリーンに締まり、鮮やかな色には黒を入れないので発色はそのまま保たれます。値を大きくするほど中立部を多く黒へ置き換え、0 ではほぼ黒を使いません。",
      },
      {
        heading: "版ずれ (Misregistration)",
        body: "ステンシル / リソ印刷で自然に生じる色版のわずかなずれをシミュレートします。値を大きくするとずれが顕著になります。",
      },
      {
        heading: "ノイズ (Noise)",
        body: "実際のステンシル印刷に見られるインクの掠れや色ムラを加えます。値を大きくするほど広範囲にムラが現れます。",
      },
      {
        heading: "ハイライトのクリップ (Highlight cutoff)",
        body: "ハイライトを飛ばします。薄い側のインクを引いて、ほぼ白の領域を抜けさせます。薄い階調を切り捨てるのではなく滑らかに絞るので、ハイライトは「たくさんの小さな点」になって飛んでいきます（切り捨てると濃い点だけが白地に孤立して残り、階調ではなくノイズに見えます）。ごく薄い階調は消えるので、JPEG ノイズや反アリアス由来の点を掃除する役割も保たれます。",
      },
      {
        heading: "ツールバー (Toolbar)",
        body: "パネル上部のアイコン:\n• 履歴（時計）— 最近使った設定を開いて再適用。\n• シャッフル — 設定をランダム化して手早く探索。\n• ガイド（i）— このヘルプ。\n• テーマ — ライト/ダーク切替。",
      },
      {
        heading: "元に戻す/やり直し・プレビュー操作",
        body: "設定変更は Ctrl/⌘ + Z で元に戻し、Ctrl/⌘ + Y または Ctrl/⌘ + Shift + Z でやり直せます。画像を変更すると履歴はリセットされます。プレビューはホイールでカーソル中心にズーム、ドラッグでパン。モバイルではパネル上端のハンドルをドラッグして高さを変えられます。",
      },
      {
        heading: "ダウンロード (Download)",
        body: "結果を PNG として書き出します。1x / 2x / 4x は同じ見た目を高解像度でレンダリングします（点の比率は保たれ、プレビューを忠実にスケールアップします）。",
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
  disabled,
}: {
  onAdd: (color: StencilColor) => void;
  disabled?: boolean;
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
        <Button
          variant="outline"
          className="h-9 text-xs"
          disabled={disabled}
          title={disabled ? `Up to ${MAX_INKS} inks` : undefined}
        >
          + Add
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        {/* プリセットのインクパレット（候補）。モノトーン / 色 / 蛍光 で分け、
            色の組は色相順に並べる（スペクトラムになり狙った色を探しやすい）。 */}
        <div className="thin-scroll mb-2 max-h-56 overflow-y-auto pr-1">
          {INK_GROUPS.map((group) => (
            <div key={group.label} className="mb-2 last:mb-0">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.entries.map(([key, ink]) => (
                  <button
                    key={key}
                    aria-label={ink.name}
                    onClick={() => {
                      onAdd({ ...ink });
                      setOpen(false);
                    }}
                    className="group/sw relative h-7 w-7 rounded-full border-2 border-transparent shadow-sm transition-colors hover:border-ring focus-visible:border-ring"
                    style={{ background: ink.color }}
                  >
                    {/* 色名のツールチップ（ネイティブの title は出るのが遅いので自前で） */}
                    <span
                      role="tooltip"
                      className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[10px] leading-tight text-background opacity-0 shadow transition-opacity group-hover/sw:opacity-100 group-focus-visible/sw:opacity-100"
                    >
                      {ink.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
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
  const [halftoneMode, setHalftoneMode] = useState<HalftoneMode>("am");
  const [colorMode, setColorMode] = useState<ColorMode>("natural");
  const [gamutCutoff, setGamutCutoff] = useState(0.5);
  const [blackGeneration, setBlackGeneration] = useState(0.7);
  const [highlightCutoff, setHighlightCutoff] = useState(0);
  const [paperTexture, setPaperTexture] = useState<PaperTexture>("none");
  const [paperTextureAmount, setPaperTextureAmount] = useState(0.5);
  const [downloadScale, setDownloadScale] = useState("1");
  const [presetKey, setPresetKey] = useState("tricolor");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<StencilCanvasHandle>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const panzoom = usePanZoom(previewRef, contentRef);
  // 画像切り替え effect から呼ぶための最新参照（effect の依存に reset を入れると
  // 画像と無関係な再生成でリセットが走ってしまう）
  const panzoomResetRef = useRef(panzoom.reset);
  panzoomResetRef.current = panzoom.reset;

  // モバイル: コントロールパネルの高さ(vh)。上端のハンドルをドラッグで伸縮できる。
  const PANEL_MIN_VH = 22;
  const PANEL_MAX_VH = 88;
  const [panelVh, setPanelVh] = useState(42);
  const panelDragRef = useRef<{ y: number; vh: number } | null>(null);
  const onPanelHandleDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    panelDragRef.current = { y: e.clientY, vh: panelVh };
  };
  const onPanelHandleMove = (e: React.PointerEvent) => {
    const d = panelDragRef.current;
    if (!d) return;
    const dvh = -((e.clientY - d.y) / window.innerHeight) * 100;
    setPanelVh(Math.max(PANEL_MIN_VH, Math.min(PANEL_MAX_VH, d.vh + dvh)));
  };
  const onPanelHandleUp = (e: React.PointerEvent) => {
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    panelDragRef.current = null;
  };
  const { dark, toggle: toggleTheme } = useTheme();
  const [guideLang, setGuideLang] = useState<GuideLang>("en");

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // アップロードした画像の Blob URL（次の画像を選んだら解放する）
  const objectUrlRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  // Track image aspect ratio (width / height)
  const [imageAspect, setImageAspect] = useState<number | null>(null);
  useEffect(() => {
    setImageAspect(null);
    // 画像が変わると contentRef の要素ごと差し替わり、変形は inline カスタム
    // プロパティなので消える。ズーム state だけ残ると「300% と出ているのに
    // 実際は等倍」になるので、ここで view もリセットして表示と一致させる。
    panzoomResetRef.current();
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

  // プレビュー領域（パネルに重ならない残り領域）いっぱいに、幅・高さ両方へフィット
  const canvasWidth = (() => {
    if (!imageAspect) return 600;
    const pad = isLgLayout ? 40 : 24;
    const availW = Math.max(0, containerSize.width - pad);
    const availH = Math.max(0, containerSize.height - pad);
    const widthFromHeight = availH * imageAspect;
    return Math.max(100, Math.min(availW, widthFromHeight));
  })();

  // WebGPU が使えるか（使えるときだけ高解像度プレビューを有効化）
  const [gpuAvailable, setGpuAvailable] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    getGpuDevice().then((d) => { if (alive) setGpuAvailable(!!d); });
    return () => { alive = false; };
  }, []);

  // ズームが落ち着いてから内部解像度を上げる（操作中は低解像度のまま＝カクつかせない）
  const [settledZoom, setSettledZoom] = useState(1);
  useEffect(() => {
    const id = setTimeout(() => setSettledZoom(panzoom.zoom), 250);
    return () => clearTimeout(id);
  }, [panzoom.zoom]);

  // 内部描画解像度の倍率（WebGPU のみ）。画面上の表示サイズ×ズーム×DPR に見合う
  // 解像度を選び、renderScale も同じ倍率にして網点等の見た目は保つ。メモリ上限あり。
  const qualityScale = (() => {
    if (!gpuAvailable || !imageAspect) return 1;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const needed = (canvasWidth * settledZoom * dpr) / BASE_WIDTH;
    let q = Math.max(1, Math.min(4, Math.ceil(needed - 0.05)));
    // メモリ上限: 濃度バッファ = inkCount × pixelCount × 4byte。GPU の
    // storage buffer 上限（多くは 128MB）に余裕を持たせ 96MB までに抑える。
    const baseH = BASE_WIDTH / imageAspect;
    const budgetBytes = 96 * 1024 * 1024;
    while (q > 1 && BASE_WIDTH * q * baseH * q * colors.length * 4 > budgetBytes) q -= 1;
    return q;
  })();
  const renderWidth = Math.round(BASE_WIDTH * qualityScale);

  const handleDownload = async () => {
    const scale = Number(downloadScale);

    // どの倍率でも BASE_WIDTH×scale で描き直す。プレビュー Canvas は画面サイズ・
    // ズーム・DPR に応じて内部解像度が上がる（qualityScale）ので、それをそのまま
    // 保存すると「1x (600px)」なのに 1800px 出力、といったラベルとの食い違いが起きる。
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
        blackGeneration,
        highlightCutoff,
        paperTexture,
        paperTextureAmount,
        noise,
        transparentBg,
        invert,
        renderScale: scale,
      };

      // WebGPU が使えるならそちらで書き出す（高解像度ほど効く）。
      // 使えない環境や GPU が失敗した場合は Worker 上の CPU 実装で処理し、UI を止めない。
      // renderStencilPixels は GPU 失敗時にメインスレッドの CPU 実装へ落ちるので、
      // ここで拾わないと 4x 書き出し（GPU のバッファ上限超え等）で画面が固まる。
      const renderOnWorker = () =>
        new Promise<Uint8ClampedArray>((resolve, reject) => {
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

      const gpuDevice = await getGpuDevice();
      let pixels: Uint8ClampedArray;
      if (gpuDevice) {
        try {
          pixels = await renderStencilPixelsGpuOnly(imageData, options);
        } catch (gpuError) {
          console.warn("[stencil] GPU 書き出しに失敗。Worker で処理します", gpuError);
          pixels = await renderOnWorker();
        }
      } else {
        pixels = await renderOnWorker();
      }

      const offscreen = document.createElement("canvas");
      offscreen.width = targetWidth;
      offscreen.height = targetHeight;
      const ctx = offscreen.getContext("2d")!;
      const output = ctx.createImageData(targetWidth, targetHeight);
      output.data.set(pixels);
      ctx.putImageData(output, 0, 0);

      await saveImageFromCanvas(offscreen, "stencil.png");
      setDownloadError(null);
    } catch (e) {
      // 握り潰すと未処理の rejection になり、ユーザーには何も起きていないように見える
      console.error("[stencil] 書き出しに失敗しました", e);
      setDownloadError(
        e instanceof Error ? e.message : "Export failed. Please try again."
      );
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
    // 上限を超えると GPU 分解が毎フレーム例外を投げ、CPU へ落ちて重くなる。
    // スクリーン角度の表も 8 本しかなく、9 本目からは角度が重複してモアレになる。
    if (colors.length >= MAX_INKS) return;
    setColors((prev) => [...prev, color]);
    setPresetKey(""); // プリセットから外れたので選択を解除
  };

  /**
   * 設定をランダムに振る（当たりをつける用 / WebGPU が無い環境のフォールバック）。
   * インク色は崩壊を避けるためプリセットから自動選択し、点設定は Discover と同じ制約
   * （AM 固定・dotSize 2–6・density 1.0–1.4）でシャッフルする。Dot Density は使わない。
   */
  const randomize = () => {
    const pick = <T,>(arr: readonly T[]): T =>
      arr[Math.floor(Math.random() * arr.length)];

    // インク色: プリセットから1つ選ぶ（完全ランダムだと崩壊するため）
    const [key, preset] = pick(presetEntries);
    setPresetKey(key);
    setColors([...preset.colors]);

    // 点のサイズ / 濃度 / モード（極端に崩れない範囲で）
    setDotSize(pick([2, 2.5, 3, 3.5, 4, 5, 6]));
    setDensity(pick([1, 1.1, 1.2, 1.3, 1.4]));
    setHalftoneMode("am");
    setColorMode(pick<ColorMode>(["natural", "bold"]));
    setGamutCutoff(pick([0.3, 0.5, 0.7]));
    setPaperTexture(pick<PaperTexture>(["felt", "fiber", "none"]));
    setPaperTextureAmount(pick([0.3, 0.5, 0.7]));
  };

  /** Discover のサムネイルを選んで確定したとき、その候補の設定を丸ごと反映する。 */
  const applyCandidate = (cand: Candidate) => {
    setColors([...cand.colors]);
    setPaperColor(cand.paperColor);
    setInvert(cand.invert);
    setDotSize(cand.dotSize);
    setDensity(cand.density);
    setInkOpacity(cand.inkOpacity);
    setMisregistration(cand.misregistration);
    setHalftoneMode(cand.halftoneMode);
    setPaperTexture(cand.paperTexture);
    setColorMode(DISCOVER_FIXED.colorMode);
    setGamutCutoff(DISCOVER_FIXED.gamutThreshold);
    setBlackGeneration(DISCOVER_FIXED.blackGeneration);
    setHighlightCutoff(cand.highlightCutoff);
    setNoise(DISCOVER_FIXED.noise);
    setPaperTextureAmount(DISCOVER_FIXED.paperTextureAmount);
    setTransparentBg(false);
    setPresetKey("");
  };

  /** Shuffle ボタン: GPU があれば Discover グリッド、無ければ従来のシャッフル。 */
  const handleShuffleClick = () => {
    if (gpuAvailable) setDiscoverOpen(true);
    else randomize();
  };

  // 黒/グレーの中立インクを含むか（GCR = 黒生成が効く構成か）を判定。
  // 吸収があり、かつ Lab 彩度が低いインクを「中立」とみなす。
  const hasNeutralInk = colors.some((c) => {
    const { r, g, b } = hexToRgb(c.color);
    const absorb = Math.hypot((255 - r) / 255, (255 - g) / 255, (255 - b) / 255);
    if (absorb < 0.05) return false; // ほぼ白は対象外
    const [, la, lb] = rgbToLab(r, g, b);
    return Math.hypot(la, lb) < 12;
  });

  // 「最近使った設定」（localStorage）。明示的な保存ではなくサジェスト用。
  const currentSettings: StencilSettings = {
    colors,
    dotSize,
    misregistration,
    density,
    inkOpacity,
    paperColor,
    halftoneMode,
    colorMode,
    gamutCutoff,
    blackGeneration,
    highlightCutoff,
    paperTexture,
    paperTextureAmount,
    noise,
    transparentBg,
    invert,
  };
  // WebGPU 環境ではサムネ付き履歴（useVisualHistory）を表示するので、
  // localStorage 版は書き込みごと止める（読まれない履歴を 2.5 秒ごとに書いていた）。
  const { recent, remove: removeRecent } = useRecentSettings(
    currentSettings,
    !gpuAvailable
  );
  // WebGPU 環境は「見た目つき履歴」（メモリのみ・多め）。CPU は従来の localStorage 履歴。
  const getCanvas = useCallback(() => canvasRef.current?.getCanvas() ?? null, []);
  const { history: visualHistory } = useVisualHistory(
    currentSettings,
    getCanvas,
    gpuAvailable,
    imageSrc,
  );
  const [recentOpen, setRecentOpen] = useState(false);

  const applySettings = useCallback((s: StencilSettings) => {
    setColors([...s.colors]);
    setDotSize(s.dotSize);
    setMisregistration(s.misregistration);
    setDensity(s.density);
    setInkOpacity(s.inkOpacity);
    setPaperColor(s.paperColor);
    setHalftoneMode(s.halftoneMode);
    setColorMode(s.colorMode);
    setGamutCutoff(s.gamutCutoff);
    setBlackGeneration(s.blackGeneration ?? 0.7);
    setHighlightCutoff(s.highlightCutoff);
    setPaperTexture(s.paperTexture);
    setPaperTextureAmount(s.paperTextureAmount);
    setNoise(s.noise);
    setTransparentBg(s.transparentBg);
    setInvert(s.invert);
    // 復元した色がちょうどプリセットと一致するならプリセット表示も戻す
    // （Undo でプリセットへ戻ったのに選択欄が空になるのを防ぐ）。
    setPresetKey(matchPresetKey(s.colors));
  }, []);

  // 設定の Undo/Redo（画像変更で履歴リセット）。ブラウザ標準の
  // Ctrl/⌘+Z=戻す, Ctrl/⌘+Y または Ctrl/⌘+Shift+Z=進む。
  const { undo, redo } = useSettingsHistory(currentSettings, applySettings, imageSrc);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const removeColor = (index: number) => {
    setColors((prev) => prev.filter((_, i) => i !== index));
    setPresetKey(""); // プリセットから外れたので選択を解除
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    // 前に選んだ画像の Blob URL を解放する（放置するとファイル本体を掴んだままになる）
    const prev = objectUrlRef.current;
    objectUrlRef.current = url;
    if (prev) setTimeout(() => URL.revokeObjectURL(prev), 0);
    setImageSrc(url);
  };

  return (
    <div className="checkerboard relative h-[100dvh] w-screen overflow-hidden">
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
      {/* Preview: 全画面パン/ズーム面（拡大時は印刷物がパネル下へ潜り込む）。
          padding でデフォルト時の中心/サイズを非パネル領域に合わせる。 */}
      <div
        ref={previewRef}
        className="absolute inset-0 z-0 grid place-items-center overflow-hidden p-4 lg:pb-4 lg:pl-[356px]"
        style={{
          touchAction: "none",
          cursor:
            panzoom.zoom > 1
              ? panzoom.dragging
                ? "grabbing"
                : "grab"
              : "default",
          // モバイルは下パネルの高さぶんだけ下パディングを空け、印刷物を非パネル領域に収める
          paddingBottom: isLgLayout ? undefined : `calc(${panelVh}vh + 1rem)`,
        }}
        {...panzoom.handlers}
      >
        {imageAspect ? (
          <div
            ref={contentRef}
            style={{
              transform: "var(--pz-transform, none)",
              transformOrigin: "center center",
              willChange: "transform",
              lineHeight: 0,
            }}
          >
            <StencilCanvas
              ref={canvasRef}
              src={imageSrc}
              colors={colors}
              width={renderWidth}
              renderScale={qualityScale}
              dotSize={dotSize}
              misregistration={misregistration}
              grain={0}
              density={density}
              inkOpacity={inkOpacity}
              paperColor={paperColor}
              halftoneMode={halftoneMode}
              colorMode={colorMode}
              gamutThreshold={gamutCutoff}
              blackGeneration={blackGeneration}
              highlightCutoff={highlightCutoff}
              paperTexture={paperTexture}
              paperTextureAmount={paperTextureAmount}
              noise={noise}
              transparentBg={transparentBg}
              invert={invert}
              className="shadow-lg"
              style={{ width: Math.round(canvasWidth), height: "auto" }}
            />
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Loading…</span>
        )}
      </div>

      {/* Overlay: コントロールパネル（PC=左 / スマホ=下）＋隅コントロール */}
      <div className="pointer-events-none absolute inset-0 z-20 flex flex-col-reverse lg:flex-row">
        {/* Control panel: ガラス面（半透明+blur, ライト/ダーク両対応）＋内側スクロール */}
        <div
          className={`pointer-events-auto m-2 flex flex-col overflow-hidden rounded-2xl shadow-xl ${GLASS_SURFACE} lg:m-3 lg:h-[calc(100%-1.5rem)] lg:w-[340px] lg:shrink-0`}
          style={isLgLayout ? undefined : { height: `${panelVh}vh` }}
        >
          {/* Drag handle: ボトムシートの高さをドラッグで伸縮（モバイルのみ） */}
          <div
            className="flex shrink-0 touch-none cursor-ns-resize items-center justify-center pt-2.5 pb-1 lg:hidden"
            onPointerDown={onPanelHandleDown}
            onPointerMove={onPanelHandleMove}
            onPointerUp={onPanelHandleUp}
            onPointerCancel={onPanelHandleUp}
          >
            <div className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
          </div>
          <div className="sidebar-scroll flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-4 will-change-scroll [transform:translateZ(0)]">
          {/* Panel header: タイトル＋操作 / サブタイトル */}
          <div className="mb-4">
            <div className="flex items-center justify-between gap-2">
              <h1 className="text-lg font-semibold tracking-tight">Stencil Canvas</h1>
              <div className="flex shrink-0 items-center gap-0.5">
              {/* Recent (履歴) */}
              <Popover open={recentOpen} onOpenChange={setRecentOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    title="Recent settings"
                    disabled={(gpuAvailable ? visualHistory.length : recent.length) === 0}
                  >
                    <History className="h-4 w-4" />
                    <span className="sr-only">Recent settings</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-2">
                  <div className="mb-1 px-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Recent
                  </div>
                  {gpuAvailable ? (
                    <div className="thin-scroll grid max-h-80 grid-cols-3 overflow-y-auto">
                      {visualHistory.map((e) => (
                        <button
                          key={e.id}
                          onClick={() => {
                            applySettings(e.settings);
                            setRecentOpen(false);
                          }}
                          title="Apply these settings"
                          className="group relative aspect-square overflow-hidden bg-muted"
                        >
                          <img src={e.thumb} alt="" className="h-full w-full object-cover" />
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/55 to-transparent px-1.5 pb-1.5 pt-3">
                            <span className="flex gap-0.5">
                              {e.settings.colors.slice(0, 5).map((c, i) => (
                                <span
                                  key={i}
                                  className="h-2 w-2 rounded-full ring-1 ring-white/70"
                                  style={{ background: c.color }}
                                />
                              ))}
                            </span>
                            <span className="shrink-0 text-[9px] tabular-nums text-white/90">
                              {new Date(e.savedAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                  <div className="flex flex-col">
                    {recent.map((e) => (
                      <div key={e.id} className="group flex items-center gap-1">
                        <button
                          onClick={() => {
                            applySettings(e.settings);
                            setRecentOpen(false);
                          }}
                          title="Apply these settings"
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-accent"
                        >
                          <span className="flex shrink-0 -space-x-1">
                            {e.settings.colors.slice(0, 5).map((c, i) => (
                              <span
                                key={i}
                                className="h-3.5 w-3.5 rounded-full border border-background"
                                style={{ background: c.color }}
                              />
                            ))}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {e.settings.dotSize.toFixed(1)}px ·{" "}
                            {e.settings.halftoneMode === "fm" ? "Density" : "Size"}
                          </span>
                          {e.savedAt > 0 && (
                            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                              {new Date(e.savedAt).toLocaleString(undefined, {
                                month: "numeric",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          )}
                        </button>
                        <button
                          onClick={() => removeRecent(e.id)}
                          aria-label="Remove from recent"
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sm leading-none text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  )}
                </PopoverContent>
              </Popover>
              {/* Randomize */}
              <Button
                variant="ghost"
                size="icon"
                onClick={handleShuffleClick}
                className="h-9 w-9 shrink-0"
                title={gpuAvailable ? "Discover colors" : "Randomize settings"}
              >
                <Shuffle
                  className="h-5 w-5"
                  strokeWidth={2.5}
                  style={{ stroke: "url(#shuffleGrad)" }}
                />
                <span className="sr-only">
                  {gpuAvailable ? "Discover colors" : "Randomize settings"}
                </span>
              </Button>
              {/* Guide */}
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0">
                    <Info className="h-4 w-4" />
                    <span className="sr-only">Guide</span>
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-lg">
                  <div className="max-h-[85vh] overflow-y-auto overscroll-contain p-6 will-change-scroll [transform:translateZ(0)]">
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
                  <div className="mt-4 space-y-4">
                    {guide[guideLang].sections.map((s) => (
                      <div key={s.heading}>
                        <h3 className="mb-1 text-sm font-medium">{s.heading}</h3>
                        <p className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                          {s.body}
                        </p>
                      </div>
                    ))}
                  </div>
                  </div>
                </DialogContent>
              </Dialog>
              {/* Theme */}
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
            <p className="mt-1 text-[11px] text-muted-foreground">
              Multi-color stencil print simulator
            </p>
          </div>
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
                <Label
                  htmlFor="invert"
                  className="text-xs text-muted-foreground"
                  title="Invert the input image's tones (light ↔ dark) before printing"
                >
                  Invert tones
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
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <Label className="mb-2 text-xs text-muted-foreground">Texture</Label>
                <Select
                  value={paperTexture}
                  onValueChange={(v) => setPaperTexture(v as PaperTexture)}
                  disabled={transparentBg}
                >
                  <SelectTrigger aria-label="Paper texture" className="h-9 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none" className="text-xs">None</SelectItem>
                    <SelectItem value="felt" className="text-xs">Felt</SelectItem>
                    <SelectItem value="fiber" className="text-xs">Fiber</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {paperTexture !== "none" && (
                <div>
                  <Label className="mb-2 text-xs text-muted-foreground">
                    Texture amount
                  </Label>
                  <Slider
                    aria-label="Texture strength"
                    value={[paperTextureAmount]}
                    onValueChange={([v]) => setPaperTextureAmount(v)}
                    min={0}
                    max={1}
                    step={0.05}
                    className="mt-2"
                  />
                  <span className="mt-1 block text-right font-mono text-[11px] text-muted-foreground">
                    {Math.round(paperTextureAmount * 100)}%
                  </span>
                </div>
              )}
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
                <SelectTrigger className="h-9 w-full text-xs" aria-label="Color preset">
                  <SelectValue placeholder="Select preset..." />
                </SelectTrigger>
                <SelectContent>
                  {presetEntries.map(([key, preset]) => (
                    <SelectItem key={key} value={key} className="text-xs">
                      <span className="flex items-center gap-2">
                        <span className="flex shrink-0 -space-x-1">
                          {preset.colors.map((c, i) => (
                            <span
                              key={i}
                              className="h-3 w-3 rounded-full border border-background"
                              style={{ background: c.color }}
                            />
                          ))}
                        </span>
                        {preset.name}
                      </span>
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
                    aria-label={`Remove ${c.name}`}
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
                aria-label="Ink opacity"
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
                  <SelectTrigger aria-label="Separation mode" className="h-9 w-full text-xs">
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
                  <SelectTrigger aria-label="Halftone mode" className="h-9 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="am" className="text-xs">Dot Size</SelectItem>
                    <SelectItem value="fm" className="text-xs">Dot Density</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="mb-2 text-xs text-muted-foreground">Dot Size</Label>
                <Slider
                  aria-label="Dot size"
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
                  aria-label="Density"
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
                  Separation strength
                </Label>
                <Slider
                  aria-label="Separation strength"
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
            {hasNeutralInk && (
              <div className="mt-4">
                <Label className="mb-2 text-xs text-muted-foreground">
                  Black generation
                </Label>
                <Slider
                  aria-label="Black generation"
                  value={[blackGeneration]}
                  onValueChange={([v]) => setBlackGeneration(v)}
                  min={0}
                  max={1}
                  step={0.05}
                  className="mt-2"
                />
                <span className="mt-1 block text-right font-mono text-[11px] text-muted-foreground">
                  {Math.round(blackGeneration * 100)}%
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
                  aria-label="Misregistration"
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
                  aria-label="Noise"
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
                  aria-label="Highlight cutoff"
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
        </div>

        {/* Preview corner controls（非パネル領域）: ズーム左下・ダウンロード右下 */}
        <div className="pointer-events-none relative flex min-h-0 min-w-0 flex-1">
          {/* Zoom: モバイルは上, PC は下（下だとダウンロードと被るため） */}
          <div className="pointer-events-none absolute left-0 top-0 flex p-3 lg:bottom-0 lg:top-auto">
            <div
              className={`pointer-events-auto flex items-center gap-0.5 rounded-lg p-1 shadow-sm ${GLASS_SURFACE}`}
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

          {/* Download (bottom-right) */}
          <div className={`pointer-events-auto absolute bottom-3 right-3 flex items-center gap-2 rounded-lg p-1.5 shadow-sm ${GLASS_SURFACE}`}>
            {downloadError && (
              <span
                role="alert"
                className="max-w-[16rem] truncate text-xs text-destructive"
                title={downloadError}
              >
                {downloadError}
              </span>
            )}
            <Select value={downloadScale} onValueChange={setDownloadScale}>
              <SelectTrigger className="h-9 w-28 text-xs" aria-label="Export resolution">
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
              {downloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {downloading ? "Processing..." : "Download PNG"}
            </Button>
          </div>
        </div>
      </div>

      <footer className="pointer-events-none absolute bottom-2 right-3 z-10 hidden items-center justify-center gap-1.5 text-[11px] text-muted-foreground/50 lg:flex [&_a]:pointer-events-auto">
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

      {discoverOpen && (
        <Suspense fallback={null}>
          <DiscoverDialog
            open={discoverOpen}
            onOpenChange={setDiscoverOpen}
            imageSrc={imageSrc}
            onApply={applyCandidate}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
