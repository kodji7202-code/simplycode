// Renders every icon asset (all channels, .icon projects, web/Android copies)
// from assets/brand-src/simplycode-head.png. The master is a manual artifact:
// robot-heads@0.3.0 RobotHead (rectangle/happy/emerald, antenna, paused) shot
// in headless Chrome on a transparent 1024 canvas, trimmed + re-centered.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Build-time icon renderer writes files directly.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import sharp from "sharp";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL(".", import.meta.url)), "..");
const MASTER_PATH = NodePath.join(REPO_ROOT, "assets/brand-src/simplycode-head.png");

const EMERALD = "#00d47e";
const SMALL_ICON_MAX = 32;
const BG_RX_RATIO = 224 / 1024; // rounded-square corner radius of the old SVG master

interface Channel {
  readonly dir: string; // assets/<dir>
  readonly name: string; // filename stem prefix
  readonly bg: string;
  /** Icon Composer `fill.solid` display-p3 triple. */
  readonly composerFill: string;
}

const CHANNELS: ReadonlyArray<Channel> = [
  {
    dir: "prod",
    name: "black",
    bg: "#0B0B0D",
    composerFill: "display-p3:0.04314,0.04314,0.05098,1.00000",
  },
  {
    dir: "nightly",
    name: "nightly",
    bg: "#111533",
    composerFill: "display-p3:0.06667,0.08235,0.20000,1.00000",
  },
  {
    dir: "dev",
    name: "blueprint",
    bg: "#347FF8",
    composerFill: "display-p3:0.20392,0.49804,0.97255,1.00000",
  },
];

const headMaster = NodeFS.readFileSync(MASTER_PATH);

const written: string[] = [];

function write(rel: string, contents: Buffer | string) {
  const abs = NodePath.join(REPO_ROOT, rel);
  NodeFS.mkdirSync(NodePath.dirname(abs), { recursive: true });
  NodeFS.writeFileSync(abs, contents);
  written.push(rel);
}

/** Head scaled to `fraction` of `canvas`, centered on a transparent canvas. */
async function headLayer(canvas: number, fraction: number): Promise<Buffer> {
  const size = Math.round(canvas * fraction);
  const head = await sharp(headMaster).resize(size, size).png().toBuffer();
  return sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: head, left: Math.round((canvas - size) / 2), top: Math.round((canvas - size) / 2) },
    ])
    .png()
    .toBuffer();
}

/** Soft emerald glow matching `layer`'s alpha silhouette at ~0.45 opacity. */
async function glowLayer(layer: Buffer, canvas: number): Promise<Buffer> {
  const alpha = await sharp(layer)
    .extractChannel(3)
    .blur(Math.max(6, Math.round(canvas * 0.045)))
    .linear(0.45, 0)
    .png()
    .toBuffer();
  const { r, g, b } = hexToRgb(EMERALD);
  return sharp({
    create: { width: canvas, height: canvas, channels: 3, background: { r, g, b } },
  })
    .joinChannel(alpha)
    .png()
    .toBuffer();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

async function roundedSquareBg(channel: Channel, canvas: number): Promise<Buffer> {
  const rx = Math.round(canvas * BG_RX_RATIO);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}"><rect width="${canvas}" height="${canvas}" rx="${rx}" fill="${channel.bg}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Channel app icon at `canvas`: rounded-square background, emerald head with a
 * soft glow behind it. Small sizes drop the glow and enlarge the head.
 */
async function fullIconPng(channel: Channel, canvas: number): Promise<Buffer> {
  const small = canvas <= SMALL_ICON_MAX;
  const head = await headLayer(canvas, small ? 0.84 : 0.72);
  const overlays = small
    ? [{ input: head }]
    : [{ input: await glowLayer(head, canvas) }, { input: head }];
  return sharp(await roundedSquareBg(channel, canvas))
    .composite(overlays)
    .png()
    .toBuffer();
}

async function writePng(rel: string, contents: Promise<Buffer> | Buffer) {
  write(rel, await contents);
}

async function writeIco(rel: string, channel: Channel) {
  const images = [];
  for (const size of WINDOWS_ICON_SIZES) {
    images.push({ size, contents: await fullIconPng(channel, size) });
  }
  write(rel, encodePngIco(images));
}

/** Head silhouette in solid `color` (alpha taken from the head master). */
async function silhouettePng(canvas: number, fraction: number, color: string): Promise<Buffer> {
  const head = await headLayer(canvas, fraction);
  const alpha = await sharp(head).extractChannel(3).png().toBuffer();
  const { r, g, b } = hexToRgb(color);
  return sharp({
    create: { width: canvas, height: canvas, channels: 3, background: { r, g, b } },
  })
    .joinChannel(alpha)
    .png()
    .toBuffer();
}

function solidPng(canvas: number, color: string): Promise<Buffer> {
  return sharp({
    create: { width: canvas, height: canvas, channels: 4, background: color },
  })
    .png()
    .toBuffer();
}

const BACKGROUND_LAYER_SVG = (channel: Channel) =>
  `<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <rect width="128" height="128" rx="28" fill="${channel.bg}"/>
</svg>
`;

function iconJson(channel: Channel): string {
  return (
    JSON.stringify(
      {
        fill: { solid: channel.composerFill },
        groups: [
          {
            layers: [
              {
                "image-name": "head.png",
                name: "Head",
                position: { scale: 0.72, "translation-in-points": [0, 0] },
              },
              {
                "image-name": "background.svg",
                name: "Background",
                position: { scale: 8.1, "translation-in-points": [0, 0] },
              },
            ],
            shadow: { kind: "neutral", opacity: 0.5 },
            translucency: { enabled: true, value: 0.5 },
          },
        ],
        "supported-platforms": { circles: ["watchOS"], squares: "shared" },
      },
      null,
      2,
    ) + "\n"
  );
}

async function main() {
  for (const channel of CHANNELS) {
    const dir = `assets/${channel.dir}`;
    const n = channel.name;

    // 1024px masters.
    for (const variant of ["ios", "macos", "universal"]) {
      await writePng(`${dir}/${n}-${variant}-1024.png`, fullIconPng(channel, 1024));
    }
    // Windows + web icon sets.
    await writeIco(`${dir}/${n}-windows.ico`, channel);
    await writeIco(`${dir}/${n}-web-favicon.ico`, channel);
    await writePng(`${dir}/${n}-web-favicon-16x16.png`, fullIconPng(channel, 16));
    await writePng(`${dir}/${n}-web-favicon-32x32.png`, fullIconPng(channel, 32));
    await writePng(`${dir}/${n}-web-apple-touch-180.png`, fullIconPng(channel, 180));
    await writePng(`${dir}/${n}-web-icon-192x192.png`, fullIconPng(channel, 192));
    await writePng(`${dir}/${n}-web-icon-512x512.png`, fullIconPng(channel, 512));

    // Icon Composer project (kept: `vp run icons:export` can re-render on macOS).
    const projectDir = `${dir}/app-icon.icon`;
    const assetsDir = NodePath.join(REPO_ROOT, projectDir, "Assets");
    NodeFS.mkdirSync(assetsDir, { recursive: true });
    for (const stale of NodeFS.readdirSync(assetsDir)) {
      if (!["background.svg", "head.png"].includes(stale))
        NodeFS.rmSync(NodePath.join(assetsDir, stale));
    }
    write(`${projectDir}/icon.json`, iconJson(channel));
    write(`${projectDir}/Assets/background.svg`, BACKGROUND_LAYER_SVG(channel));
    // Layer renders larger than the 72% slot; icon.json scales it down.
    const headOnCanvas = await headLayer(1024, 1);
    const headWithGlow = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: await glowLayer(headOnCanvas, 1024) }, { input: headOnCanvas }])
      .png()
      .toBuffer();
    write(`${projectDir}/Assets/head.png`, headWithGlow);
  }

  // apps/web/public — checked-in copies of the production web set.
  const prod = CHANNELS[0]!;
  await writeIco("apps/web/public/favicon.ico", prod);
  await writePng("apps/web/public/favicon-16x16.png", fullIconPng(prod, 16));
  await writePng("apps/web/public/favicon-32x32.png", fullIconPng(prod, 32));
  await writePng("apps/web/public/apple-touch-icon.png", fullIconPng(prod, 180));
  await writePng("apps/web/public/icon-192x192.png", fullIconPng(prod, 192));
  await writePng("apps/web/public/icon-512x512.png", fullIconPng(prod, 512));

  // apps/mobile/assets — Android adaptive icon + splash + notification sets.
  await writePng("apps/mobile/assets/android-icon-foreground.png", headLayer(432, 0.62));
  await writePng("apps/mobile/assets/android-icon-mark.png", headLayer(432, 0.62));
  await writePng(
    "apps/mobile/assets/android-notification-icon.png",
    silhouettePng(96, 0.8, "#FFFFFF"),
  );
  await writePng("apps/mobile/assets/android-icon-background-dev.png", solidPng(432, "#347FF8"));
  await writePng(
    "apps/mobile/assets/android-icon-background-nightly.png",
    solidPng(432, "#111533"),
  );
  await writePng("apps/mobile/assets/android-splash-icon-dev.png", headLayer(1152, 0.5));
  await writePng("apps/mobile/assets/android-splash-icon-nightly.png", headLayer(1152, 0.5));
  await writePng("apps/mobile/assets/android-splash-icon-prod.png", headLayer(1152, 0.5));

  console.log(`generated ${written.length} icon asset(s)`);
  for (const rel of written) console.log(`  ${rel}`);
}

await main();
