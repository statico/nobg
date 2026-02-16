#!/usr/bin/env bun

import { parseArgs } from "util";
import { resolve, basename, extname } from "path";
import { existsSync } from "fs";
import sharp from "sharp";

const RESOLUTIONS: Record<string, string> = {
  "1k": "1K",
  "2k": "2K",
  "4k": "4K",
};

const PROVIDERS: Record<string, (opts: GenerateOpts) => Promise<Buffer>> = {
  gemini: generateGemini,
};

interface GenerateOpts {
  model: string;
  prompt: string;
  aspectRatio: string;
  imageSize: string;
  temperature: number;
  debug: boolean;
}

function usage(): never {
  console.log(`Usage: nobg [options] <prompt>

Generate images with transparent backgrounds using AI.

Options:
  -a, --aspect-ratio <ratio>   Aspect ratio (default: 1:1)
  -r, --resolution <res>       Resolution: 1k, 2k, 4k (default: 1k)
  -t, --temperature <temp>     Temperature 0.0-2.0 (default: 1.0)
  -o, --output <file>          Output filename (default: auto-generated)
  -d, --debug                  Log full prompt and API details
  -c, --chroma-color <hex>     Chroma key color (default: #00FF00)
  -m, --model <provider/model> Model (default: gemini/gemini-3-pro-image-preview)
  -h, --help                   Show this help

Examples:
  nobg 'a red apple'
  nobg -a 16:9 -r 2k 'app icon of a banana'
  nobg -m gemini/nano-banana-pro-3 -o logo.png 'minimalist logo'`);
  process.exit(0);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "aspect-ratio": { type: "string", short: "a", default: "1:1" },
    resolution: { type: "string", short: "r", default: "1k" },
    temperature: { type: "string", short: "t", default: "1.0" },
    output: { type: "string", short: "o" },
    debug: { type: "boolean", short: "d", default: false },
    "chroma-color": { type: "string", short: "c", default: "#00FF00" },
    model: { type: "string", short: "m", default: "gemini/gemini-3-pro-image-preview" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help) usage();

const prompt = positionals[0];
if (!prompt) {
  console.error("Error: prompt is required. Use --help for usage.");
  process.exit(1);
}

// Parse provider/model
const modelStr = values.model!;
const slashIdx = modelStr.indexOf("/");
const provider = slashIdx !== -1 ? modelStr.slice(0, slashIdx) : "gemini";
const modelName = slashIdx !== -1 ? modelStr.slice(slashIdx + 1) : modelStr;

const generateFn = PROVIDERS[provider];
if (!generateFn) {
  console.error(
    `Error: unsupported provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(", ")}`
  );
  process.exit(1);
}

// Parse chroma color
const chromaColor = values["chroma-color"]!;
const chromaMatch = chromaColor.match(/^#?([0-9a-fA-F]{6})$/);
if (!chromaMatch) {
  console.error(
    `Error: invalid chroma color "${chromaColor}". Use hex format like #00FF00`
  );
  process.exit(1);
}
const chromaHexStr = chromaMatch[1]!;
const chromaHex = `#${chromaHexStr.toUpperCase()}`;
const chromaR = parseInt(chromaHexStr.slice(0, 2), 16);
const chromaG = parseInt(chromaHexStr.slice(2, 4), 16);
const chromaB = parseInt(chromaHexStr.slice(4, 6), 16);

// Parse resolution
const resKey = values.resolution!.toLowerCase();
const imageSize = RESOLUTIONS[resKey];
if (!imageSize) {
  console.error(
    `Error: unknown resolution "${values.resolution}". Use: ${Object.keys(RESOLUTIONS).join(", ")}`
  );
  process.exit(1);
}

// Parse temperature
const temperature = parseFloat(values.temperature!);
if (isNaN(temperature) || temperature < 0 || temperature > 2) {
  console.error("Error: temperature must be between 0.0 and 2.0");
  process.exit(1);
}

// Build full prompt with chroma key instructions
const fullPrompt = [
  `Generate an image of: ${prompt}`,
  ``,
  `CRITICAL: The background MUST be a solid, uniform ${chromaHex} color.`,
  `- Fill the entire background with exactly ${chromaHex} (RGB ${chromaR},${chromaG},${chromaB})`,
  `- No gradients, shadows, lighting effects, or color variation in the background`,
  `- The subject should have clean, sharp edges against the ${chromaHex} background`,
  `- Do not include any ground plane, surface, or environment — only the subject on the solid ${chromaHex} background`,
].join("\n");

if (values.debug) {
  console.log("--- Prompt ---");
  console.log(fullPrompt);
  console.log("--------------");
}

// Generate image
const imageBuffer = await generateFn({
  model: modelName,
  prompt: fullPrompt,
  aspectRatio: values["aspect-ratio"]!,
  imageSize,
  temperature,
  debug: values.debug!,
});

// --- Chroma key removal (HSV-based with spill suppression) ---

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  let h = 0;
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [h * 360, s * 100, v * 100];
}

const image = sharp(imageBuffer).ensureAlpha();
const { data: raw, info } = await image
  .raw()
  .toBuffer({ resolveWithObject: true });

// Detect actual background color from corner pixels
const px = (x: number, y: number) => {
  const i = (y * info.width + x) * 4;
  return [raw[i]!, raw[i + 1]!, raw[i + 2]!] as const;
};
const corners = [
  px(0, 0),
  px(info.width - 1, 0),
  px(0, info.height - 1),
  px(info.width - 1, info.height - 1),
];
const bgR = Math.round(corners.reduce((s, c) => s + (c[0] ?? 0), 0) / corners.length);
const bgG = Math.round(corners.reduce((s, c) => s + (c[1] ?? 0), 0) / corners.length);
const bgB = Math.round(corners.reduce((s, c) => s + (c[2] ?? 0), 0) / corners.length);
const [bgH, bgS] = rgbToHsv(bgR, bgG, bgB);

// Determine which RGB channel dominates the key color (for spill suppression)
const bgMax = Math.max(bgR, bgG, bgB);
const spillChannel = bgR === bgMax ? 0 : bgG === bgMax ? 1 : 2;
const otherChannels = [0, 1, 2].filter((c) => c !== spillChannel) as [number, number];

if (values.debug) {
  console.log(`--- Detected background: RGB(${bgR}, ${bgG}, ${bgB}) HSV(${bgH.toFixed(1)}, ${bgS.toFixed(1)}) ---`);
}

const HUE_RANGE = 35;
const MIN_SAT = 20;
const EDGE_HUE_RANGE = 55;

function hueDist(h1: number, h2: number): number {
  const d = Math.abs(h1 - h2);
  return d > 180 ? 360 - d : d;
}

for (let i = 0; i < raw.length; i += 4) {
  const [h, s, v] = rgbToHsv(raw[i]!, raw[i + 1]!, raw[i + 2]!);
  const hd = hueDist(h, bgH);

  if (hd <= HUE_RANGE && s >= MIN_SAT) {
    // Core background — fully transparent
    raw[i + 3] = 0;
  } else if (hd <= EDGE_HUE_RANGE && s >= MIN_SAT * 0.5) {
    // Edge zone — graduated alpha + spill suppression
    const t = (hd - HUE_RANGE) / (EDGE_HUE_RANGE - HUE_RANGE);
    const alpha = Math.round(Math.pow(t, 1.5) * 255);
    raw[i + 3] = Math.min(raw[i + 3]!, alpha);

    // Spill suppression: clamp dominant channel to max of the other two
    const cap = Math.max(raw[i + otherChannels[0]]!, raw[i + otherChannels[1]]!);
    raw[i + spillChannel] = Math.min(raw[i + spillChannel]!, cap);
  }
}

// Morphological erode: expand transparency by 1px to catch anti-aliased fringe
const w = info.width, h2 = info.height;
const alphaCopy = new Uint8Array(w * h2);
for (let y = 0; y < h2; y++)
  for (let x = 0; x < w; x++)
    alphaCopy[y * w + x] = raw[(y * w + x) * 4 + 3]!;

for (let y = 1; y < h2 - 1; y++) {
  for (let x = 1; x < w - 1; x++) {
    // If any neighbor is fully transparent, reduce this pixel's alpha
    const neighbors = [
      alphaCopy[(y - 1) * w + x]!,
      alphaCopy[(y + 1) * w + x]!,
      alphaCopy[y * w + x - 1]!,
      alphaCopy[y * w + x + 1]!,
    ];
    const minNeighbor = Math.min(...neighbors);
    if (minNeighbor === 0) {
      const idx = (y * w + x) * 4 + 3;
      raw[idx] = Math.min(raw[idx]!, Math.round(raw[idx]! * 0.3));
      // Spill suppress fringe pixels too
      const cap = Math.max(raw[idx - 3 + otherChannels[0]]!, raw[idx - 3 + otherChannels[1]]!);
      raw[idx - 3 + spillChannel] = Math.min(raw[idx - 3 + spillChannel]!, cap);
    }
  }
}

// Output filename
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function uniquePath(p: string): string {
  if (!existsSync(p)) return p;
  const ext = extname(p);
  const base = p.slice(0, -ext.length);
  let n = 2;
  while (existsSync(`${base}-${n}${ext}`)) n++;
  return `${base}-${n}${ext}`;
}

const outputPath = uniquePath(
  values.output ? resolve(values.output) : resolve(`${slugify(prompt)}.png`)
);

// Rebuild image, trim transparent pixels, save
await sharp(raw, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .trim()
  .png()
  .toFile(outputPath);

console.log(`Saved ${basename(outputPath)}`);

await displayInTerminal(outputPath);

// --- Terminal inline image display ---

async function displayInTerminal(path: string) {
  const term = process.env.TERM_PROGRAM;
  const pngData = Buffer.from(await Bun.file(path).arrayBuffer());
  const b64 = pngData.toString("base64");

  if (term === "iTerm.app") {
    // iTerm2 inline image protocol
    const name = Buffer.from(basename(path)).toString("base64");
    process.stdout.write(
      `\x1b]1337;File=inline=1;name=${name};size=${pngData.length}:${b64}\x07`
    );
    process.stdout.write("\n");
  } else if (term === "ghostty") {
    // Kitty graphics protocol (supported by Ghostty)
    const CHUNK_SIZE = 4096;
    for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
      const chunk = b64.slice(i, i + CHUNK_SIZE);
      const isLast = i + CHUNK_SIZE >= b64.length;
      if (i === 0) {
        process.stdout.write(
          `\x1b_Ga=T,f=100,m=${isLast ? 0 : 1};${chunk}\x1b\\`
        );
      } else {
        process.stdout.write(
          `\x1b_Gm=${isLast ? 0 : 1};${chunk}\x1b\\`
        );
      }
    }
    process.stdout.write("\n");
  }
}

// --- Provider implementations ---

async function generateGemini(opts: GenerateOpts): Promise<Buffer> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable is required");
    process.exit(1);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: opts.prompt }] }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      temperature: opts.temperature,
      imageConfig: {
        aspectRatio: opts.aspectRatio,
        imageSize: opts.imageSize,
      },
    },
  };

  if (opts.debug) {
    console.log("--- API Request ---");
    console.log(`POST ${url.replace(apiKey, "***")}`);
    console.log(JSON.stringify(body, null, 2));
    console.log("-------------------");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Error: Gemini API returned ${res.status}: ${err}`);
    process.exit(1);
  }

  const data: any = await res.json();
  const candidate = data.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(
    (p: any) => p.inlineData
  );

  if (!imagePart?.inlineData?.data) {
    console.error("Error: no image data in API response");
    if (opts.debug) console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  return Buffer.from(imagePart.inlineData.data, "base64");
}
