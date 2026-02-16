#!/usr/bin/env bun

import { parseArgs } from "util";
import { resolve, basename } from "path";
import sharp from "sharp";

const RESOLUTIONS: Record<string, number> = {
  "1k": 1024,
  "2k": 2048,
  "4k": 4096,
};

const PROVIDERS: Record<string, (opts: GenerateOpts) => Promise<Buffer>> = {
  gemini: generateGemini,
};

interface GenerateOpts {
  model: string;
  prompt: string;
  aspectRatio: string;
  resolution: number;
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
  -m, --model <provider/model> Model (default: gemini/nano-banana-pro-3)
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
    model: { type: "string", short: "m", default: "gemini/nano-banana-pro-3" },
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
const chromaHex = `#${chromaMatch[1].toUpperCase()}`;
const chromaR = parseInt(chromaMatch[1].slice(0, 2), 16);
const chromaG = parseInt(chromaMatch[1].slice(2, 4), 16);
const chromaB = parseInt(chromaMatch[1].slice(4, 6), 16);

// Parse resolution
const resKey = values.resolution!.toLowerCase();
const basePx = RESOLUTIONS[resKey];
if (!basePx) {
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
  resolution: basePx,
  temperature,
  debug: values.debug!,
});

// Chroma key: replace chroma color with transparency
const TOLERANCE = 40;
const image = sharp(imageBuffer).ensureAlpha();
const { data: raw, info } = await image
  .raw()
  .toBuffer({ resolveWithObject: true });

for (let i = 0; i < raw.length; i += 4) {
  const dr = raw[i] - chromaR;
  const dg = raw[i + 1] - chromaG;
  const db = raw[i + 2] - chromaB;
  const dist = Math.sqrt(dr * dr + dg * dg + db * db);

  if (dist < TOLERANCE) {
    raw[i + 3] = 0;
  } else if (dist < TOLERANCE * 2) {
    // Feather edges for smoother cutout
    const alpha = Math.round(((dist - TOLERANCE) / TOLERANCE) * 255);
    raw[i + 3] = Math.min(raw[i + 3], alpha);
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

const outputPath = values.output
  ? resolve(values.output)
  : resolve(`${slugify(prompt)}.png`);

// Rebuild image, trim transparent pixels, save
await sharp(raw, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .trim()
  .png()
  .toFile(outputPath);

console.log(`Saved ${basename(outputPath)}`);

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
      responseModalities: ["IMAGE"],
      temperature: opts.temperature,
      aspectRatio: opts.aspectRatio,
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

  const data = await res.json();
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
