// Discover 採点ロジックの検証。手作りの「良い/悪い/驚き」候補を小サムネで描画し、
// structure / separation スコアとカテゴリ判定が good と bad を分離できるかを見る。
import { computeStencil, type StencilOptions } from "../../src/lib/stencil";

const $ = (id: string) => document.getElementById(id)!;
const THUMB = 150;

// ---- color ----
const srgbToLin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
function lab(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
  const x = (0.4124564*R+0.3575761*G+0.1804375*B)/0.95047, y = 0.2126729*R+0.7151522*G+0.072175*B, z = (0.0193339*R+0.119192*G+0.9503041*B)/1.08883;
  const f = (t: number) => t > 216/24389 ? Math.cbrt(t) : (24389/27*t+16)/116;
  return [116*f(y)-16, 500*(f(x)-f(y)), 200*(f(y)-f(z))];
}
function pearson(a: number[], b: number[]): number {
  const n = a.length; let sa=0,sb=0; for(let i=0;i<n;i++){sa+=a[i];sb+=b[i];} const ma=sa/n, mb=sb/n;
  let num=0,da=0,db=0; for(let i=0;i<n;i++){const x=a[i]-ma,y=b[i]-mb; num+=x*y; da+=x*x; db+=y*y;}
  return da<=0||db<=0 ? 0 : num/Math.sqrt(da*db);
}
const std = (a: number[]) => { const m=a.reduce((s,v)=>s+v,0)/a.length; return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length); };

// ---- 候補（手作り: 良い/悪い/驚き）----
const INK = {
  blue:"#0078BF", red:"#F15060", yellow:"#FFE800", teal:"#00838A", orange:"#FF6C2F",
  green:"#00A95C", burgundy:"#914E72", flPink:"#F13792", flYellow:"#E6EF52", flGreen:"#44D62C",
  fedBlue:"#3D5588", indigo:"#484D7A", midnight:"#435060", slate:"#5E695E", charcoal:"#70747C",
};
type Cand = { name: string; expect: "ok"|"bad"; colors: string[]; paper?: string; invert?: boolean; note?: string };
const CANDIDATES: Cand[] = [
  { name:"Classic 青+赤", expect:"ok", colors:[INK.blue, INK.red] },
  { name:"Tricolor 青赤黄", expect:"ok", colors:[INK.blue, INK.red, INK.yellow] },
  { name:"Teal+Orange", expect:"ok", colors:[INK.teal, INK.orange] },
  { name:"Botanical 緑+バーガンディ", expect:"ok", colors:[INK.green, INK.burgundy] },
  { name:"驚き: 蛍光ピンク on 黒(反転)", expect:"ok", colors:[INK.flPink], paper:"#111111", invert:true, note:"単色/黒紙" },
  { name:"驚き: 蛍光黄+ピンク on 黒(反転)", expect:"ok", colors:[INK.flYellow, INK.flPink], paper:"#111111", invert:true },
  { name:"単色 蛍光ピンク", expect:"ok", colors:[INK.flPink], note:"単色" },
  // --- bad ---
  { name:"BAD: 似た暗い青2色(潰れ)", expect:"bad", colors:[INK.fedBlue, INK.indigo] },
  { name:"BAD: 暗い中間色2色", expect:"bad", colors:[INK.midnight, INK.slate] },
  { name:"BAD: 単色チャコール", expect:"bad", colors:[INK.charcoal] },
  { name:"BAD: 黄1色(暗部潰れ)", expect:"bad", colors:[INK.yellow] },
  { name:"BAD: 蛍光緑1色 明紙", expect:"bad", colors:[INK.flGreen], note:"明部飛び" },
];

// 網点の高周波を除くため、ドットピッチより粗く（≈40px幅）ブロック平均でダウンサンプル。
// 平均＝知覚される実効トーン/色（Neugebauer 平均）になるので、採点はこの上で行う。
function downsample(data: Uint8ClampedArray, w: number, h: number, tw = 40): {rgb:number[][], tw:number, th:number} {
  const th = Math.max(1, Math.round(h / w * tw));
  const rgb: number[][] = [];
  for (let ty=0; ty<th; ty++) for (let tx=0; tx<tw; tx++) {
    const x0=Math.floor(tx*w/tw), x1=Math.max(x0+1,Math.floor((tx+1)*w/tw));
    const y0=Math.floor(ty*h/th), y1=Math.max(y0+1,Math.floor((ty+1)*h/th));
    let r=0,g=0,b=0,c=0;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const o=(y*w+x)*4;r+=data[o];g+=data[o+1];b+=data[o+2];c++;}
    rgb.push([r/c,g/c,b/c]);
  }
  return {rgb, tw, th};
}

function score(srcPx: Uint8ClampedArray, rendPx: Uint8ClampedArray, w: number, h: number, candidateInkHues: number[]) {
  const ds = downsample(srcPx, w, h), dr = downsample(rendPx, w, h);
  const n = ds.rgb.length;
  const srcL: number[] = [], rendL: number[] = [];
  const srcLab: [number,number,number][] = [], rendLab: [number,number,number][] = [];
  let srcChroma = 0;
  for (let i=0;i<n;i++){
    const sL=lab(ds.rgb[i][0],ds.rgb[i][1],ds.rgb[i][2]); const rL=lab(dr.rgb[i][0],dr.rgb[i][1],dr.rgb[i][2]);
    srcLab.push(sL); rendLab.push(rL); srcL.push(sL[0]); rendL.push(rL[0]);
    srcChroma += Math.hypot(sL[1],sL[2]);
  }
  srcChroma /= n;
  void candidateInkHues; void srcL; void rendL; void std;
  // 統一指標: 「知覚的な区別の保存」。元で離れている画素ペアが描画でも離れているか
  // （Lab 距離の相関）。L も a,b も含むので、モノクロ=トーン構造、カラー=色分離の
  // 両方を1つで測れる。反転や配色ずれには不変（相対距離が保たれていれば高い）。
  const A: number[] = [], B: number[] = [];
  let seed = 12345; const rnd = () => (seed = (seed*1103515245+12345) & 0x7fffffff) / 0x7fffffff;
  let variationSum = 0, vc = 0;
  for (let k=0;k<4000;k++){
    const i=(rnd()*n)|0, j=(rnd()*n)|0; if(i===j) continue;
    const sd = Math.hypot(srcLab[i][0]-srcLab[j][0], srcLab[i][1]-srcLab[j][1], srcLab[i][2]-srcLab[j][2]);
    const rd = Math.hypot(rendLab[i][0]-rendLab[j][0], rendLab[i][1]-rendLab[j][1], rendLab[i][2]-rendLab[j][2]);
    A.push(sd); B.push(rd); variationSum += rd; vc++;
  }
  const distinction = Math.max(0, pearson(A, B));   // 0..1
  const variation = variationSum / vc;              // 描画側の平均ペア距離（潰れ検出）
  const category = srcChroma < 10 ? "mono" : "color";
  const ok = distinction > 0.55 && variation > 9;
  return { distinction, variation, category, srcChroma, ok };
}

// 色の構造を持つ合成画像（分離スコアの検証用）: 空/緑葉/赤花/肌/黄 の異なる色相
function syntheticColorful(): {data:Uint8ClampedArray,w:number,h:number} {
  const w=150,h=110; const d=new Uint8ClampedArray(w*h*4);
  const set=(x:number,y:number,c:number[])=>{const o=(y*w+x)*4;d[o]=c[0];d[o+1]=c[1];d[o+2]=c[2];d[o+3]=255;};
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const u=x/w,v=y/h;let c:number[];
    if(v<0.34){ c=[90+90*u,150+50*u,220]; }                 // 空（青グラデ）
    else if(v<0.68){ c=[50+70*u,120+70*(1-u),50]; }         // 緑葉
    else { const s=Math.floor(u*3); c = s===0?[200,60,55] : s===1?[225,180,150] : [225,205,70]; } // 赤/肌/黄
    // 花の赤いブロブ
    const dx=x-w*0.35, dy=y-h*0.5; if(dx*dx+dy*dy < 90) c=[200,50,60];
    set(x,y,c.map(z=>Math.max(0,Math.min(255,Math.round(z)))));}
  return {data:d,w,h};
}

async function loadSmall(url: string): Promise<{data:Uint8ClampedArray,w:number,h:number}> {
  if (url === "synthetic") return syntheticColorful();
  const img = new Image(); img.crossOrigin="anonymous";
  await new Promise<void>((r,j)=>{img.onload=()=>r();img.onerror=()=>j(new Error("load"));img.src=url;});
  const w=THUMB, h=Math.round(img.naturalHeight/img.naturalWidth*THUMB);
  const c=document.createElement("canvas"); c.width=w;c.height=h;
  const ctx=c.getContext("2d",{willReadFrequently:true})!; ctx.drawImage(img,0,0,w,h);
  return { data: ctx.getImageData(0,0,w,h).data, w, h };
}

async function run() {
  const url = ($("img") as HTMLSelectElement).value;
  $("status").textContent = " … rendering";
  const { data: src, w, h } = await loadSmall(url);
  const results = CANDIDATES.map((cand) => {
    const opt: StencilOptions = {
      colors: cand.colors.map((color,i)=>({name:"c"+i,color})),
      dotSize:2, misregistration:0, grain:0, density:1.2, inkOpacity:0.85,
      paperColor: cand.paper ?? "#f5f0e8", halftoneMode:"am", colorMode:"natural",
      gamutThreshold:0.5, blackGeneration:0.7, highlightCutoff:0,
      noise:0, transparentBg:false, invert: cand.invert ?? false, renderScale:1,
      paperTexture:"none", paperTextureAmount:0,
    };
    const rend = computeStencil({data:src,width:w,height:h}, opt);
    const hues = cand.colors.map(c=>{const r=parseInt(c.slice(1,3),16),g=parseInt(c.slice(3,5),16),b=parseInt(c.slice(5,7),16);const l=lab(r,g,b);return (Math.atan2(l[2],l[1])*180/Math.PI+360)%360;});
    const s = score(src, rend, w, h, hues);
    return { cand, rend, w, h, s };
  });
  // sort by distinction (主指標)
  results.sort((a,b)=> b.s.distinction - a.s.distinction);
  const grid = $("grid"); grid.innerHTML="";
  let correct=0;
  for (const {cand,rend,w,h,s} of results) {
    const verdictOk = s.ok;
    if (verdictOk === (cand.expect==="ok")) correct++;
    const card = document.createElement("div");
    card.className = "card " + (verdictOk?"ok":"bad");
    const cv = document.createElement("canvas"); cv.width=w;cv.height=h;
    cv.getContext("2d")!.putImageData(new ImageData(rend,w,h),0,0);
    card.appendChild(cv);
    const meta = document.createElement("div"); meta.className="meta";
    const sw = cand.colors.map(c=>`<span class="sw" style="background:${c}"></span>`).join("");
    meta.innerHTML =
      `<div class="name">${cand.name}</div>`+
      `<div class="swatches">${sw}${cand.paper?`<span class="sw" style="background:${cand.paper};border-color:#666"></span>紙`:""}</div>`+
      `distinction ${s.distinction.toFixed(2)} · variation ${s.variation.toFixed(0)} · ${s.category} · srcCμ${s.srcChroma.toFixed(0)}<br>`+
      `<span class="verdict ${verdictOk?"ok":"bad"}">${verdictOk?"OK":"REJECT"}</span> / 期待:${cand.expect}`;
    card.appendChild(meta);
    grid.appendChild(card);
  }
  $("status").textContent = ` — 期待と一致: ${correct}/${results.length}`;
}

($("img") as HTMLSelectElement).onchange = run;
run();
