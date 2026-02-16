# nobg

Generate images with transparent backgrounds using AI. Uses chroma key compositing — instructs the model to render on a solid green screen background, then replaces it with transparency using [sharp](https://sharp.pixelplumbing.com/).

## Setup

```sh
bun install
```

Set your API key:

```sh
export GEMINI_API_KEY=your-key-here
```

## Usage

```sh
bun nobg.ts [options] <prompt>
```

### Examples

```sh
bun nobg.ts 'a red apple'
bun nobg.ts -a 16:9 -r 2k 'app icon of a banana'
bun nobg.ts -o logo.png 'minimalist logo'
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `-a, --aspect-ratio` | Aspect ratio (e.g. `1:1`, `16:9`) | `1:1` |
| `-r, --resolution` | Resolution: `1k`, `2k`, `4k` | `1k` |
| `-t, --temperature` | Temperature `0.0`-`2.0` | `1.0` |
| `-o, --output` | Output filename | Auto-generated from prompt |
| `-d, --debug` | Log full prompt and API details | Off |
| `-c, --chroma-color` | Chroma key color in hex | `#00FF00` |
| `-m, --model` | Provider/model | `gemini/nano-banana-pro-3` |

---

Built entirely with [Claude Code](https://claude.ai/claude-code).
