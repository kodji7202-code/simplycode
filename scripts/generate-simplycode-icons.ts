/**
 * Renders every SimplyCode icon asset (all channels, `.icon` projects, web and
 * Android copies) from `assets/brand-src/simplycode-mark.svg` via sharp and
 * `scripts/lib/icon-export.ts`. One-time step; outputs are committed.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import sharp from "sharp";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL(".", import.meta.url)), "..");
const MASTER_PATH = NodePath.join(REPO_ROOT, "assets/brand-src/simplycode-mark.svg");

const MASTER_BG = "#0B0B0D";
const MASTER_FG = "#FFFFFF";

interface Channel {
  readonly dir: string; // assets/<dir>
  readonly name: string; // filename stem prefix
  readonly bg: string;
  readonly fg: string;
  /** Icon Composer `fill.solid` display-p3 triple. */
  readonly composerFill: string;
}

const CHANNELS: ReadonlyArray<Channel> = [
  {
    dir: "prod",
    name: "black",
    bg: "#0B0B0D",
    fg: "#FFFFFF",
    composerFill: "display-p3:0.04314,0.04314,0.05098,1.00000",
  },
  {
    dir: "nightly",
    name: "nightly",
    bg: "#111533",
    fg: "#8F8CF5",
    composerFill: "display-p3:0.06667,0.08235,0.20000,1.00000",
  },
  {
    dir: "dev",
    name: "blueprint",
    bg: "#347FF8",
    fg: "#FFFFFF",
    composerFill: "display-p3:0.20392,0.49804,0.97255,1.00000",
  },
];

const master = NodeFS.readFileSync(MASTER_PATH, "utf8");

/** Master with channel colors; `transparentBg` drops the rounded square. */
function markSvg(channel: Channel, opts: { transparentBg?: boolean; size?: number } = {}): string {
  let svg = master
    .replaceAll(`fill="${MASTER_BG}"`, `fill="${channel.bg}"`)
    .replaceAll(`stroke="${MASTER_FG}"`, `stroke="${channel.fg}"`);
  if (opts.transparentBg) svg = svg.replace(/<rect id="bg"[^/]*\/>\n?/, "");
  if (opts.size)
    svg = svg.replace('width="1024" height="1024"', `width="${opts.size}" height="${opts.size}"`);
  return svg;
}

/** Glyph only, centered inside `canvas` at `scale` of the 1024 master box. */
function glyphOnlySvg(fg: string, canvas: number, scale: number): string {
  const inner = Math.round(canvas / scale); // viewBox units mapped to canvas
  const offset = Math.round((canvas - canvas * scale) / 2);
  void inner;
  const glyph = master
    .match(/<g id="glyph"[\s\S]*?<\/g>/)![0]
    .replaceAll(`stroke="${MASTER_FG}"`, `stroke="${fg}"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">\n  <g transform="translate(${offset} ${offset}) scale(${(canvas * scale) / 1024})">\n  ${glyph}\n  </g>\n</svg>\n`;
}

function solidSvg(color: string, size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${color}"/></svg>`;
}

const written: string[] = [];

function write(rel: string, contents: Buffer | string) {
  const abs = NodePath.join(REPO_ROOT, rel);
  NodeFS.mkdirSync(NodePath.dirname(abs), { recursive: true });
  NodeFS.writeFileSync(abs, contents);
  written.push(rel);
}

async function png(svg: string, size: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: 384 }).resize(size, size).png().toBuffer();
}

async function writePng(rel: string, svg: string, size: number) {
  write(rel, await png(svg, size));
}

async function writeIco(rel: string, svg: string) {
  const images = [];
  for (const size of WINDOWS_ICON_SIZES) {
    images.push({ size, contents: await png(svg, size) });
  }
  write(rel, encodePngIco(images));
}

const TEXT_LAYER_SVG = (channel: Channel) =>
  `<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <g fill="none" stroke="${channel.fg}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="46,44 28,64 46,84"/>
    <polyline points="82,44 100,64 82,84"/>
    <line x1="70" y1="36" x2="58" y2="92"/>
  </g>
</svg>
`;

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
                "image-name": "text.svg",
                name: "Text",
                position: { scale: 8.5, "translation-in-points": [0, 0] },
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
    const full = markSvg(channel);

    // 1024px masters.
    for (const variant of ["ios", "macos", "universal"]) {
      await writePng(`${dir}/${n}-${variant}-1024.png`, full, 1024);
    }
    // Windows + web icon sets.
    await writeIco(`${dir}/${n}-windows.ico`, full);
    await writeIco(`${dir}/${n}-web-favicon.ico`, full);
    await writePng(`${dir}/${n}-web-favicon-16x16.png`, full, 16);
    await writePng(`${dir}/${n}-web-favicon-32x32.png`, full, 32);
    await writePng(`${dir}/${n}-web-apple-touch-180.png`, full, 180);
    await writePng(`${dir}/${n}-web-icon-192x192.png`, full, 192);
    await writePng(`${dir}/${n}-web-icon-512x512.png`, full, 512);

    // Icon Composer project (kept: `vp run icons:export` can re-render on macOS).
    const projectDir = `${dir}/app-icon.icon`;
    const assetsDir = NodePath.join(REPO_ROOT, projectDir, "Assets");
    NodeFS.mkdirSync(assetsDir, { recursive: true });
    for (const stale of NodeFS.readdirSync(assetsDir)) {
      if (!["background.svg", "text.svg"].includes(stale))
        NodeFS.rmSync(NodePath.join(assetsDir, stale));
    }
    write(`${projectDir}/icon.json`, iconJson(channel));
    write(`${projectDir}/Assets/background.svg`, BACKGROUND_LAYER_SVG(channel));
    write(`${projectDir}/Assets/text.svg`, TEXT_LAYER_SVG(channel));
  }

  // Channel-colored source SVG kept beside the outputs for reference.
  write("assets/prod/logo.svg", markSvg(CHANNELS[0]));

  // apps/web/public — checked-in copies of the production web set.
  const prod = CHANNELS[0];
  const prodFull = markSvg(prod);
  await writeIco("apps/web/public/favicon.ico", prodFull);
  await writePng("apps/web/public/favicon-16x16.png", prodFull, 16);
  await writePng("apps/web/public/favicon-32x32.png", prodFull, 32);
  await writePng("apps/web/public/apple-touch-icon.png", prodFull, 180);
  await writePng("apps/web/public/icon-192x192.png", prodFull, 192);
  await writePng("apps/web/public/icon-512x512.png", prodFull, 512);

  // apps/mobile/assets — Android adaptive icon + splash + notification sets.
  const glyphWhite432 = glyphOnlySvg("#FFFFFF", 432, 0.66);
  await writePng("apps/mobile/assets/android-icon-foreground.png", glyphWhite432, 432);
  await writePng("apps/mobile/assets/android-icon-mark.png", glyphWhite432, 432);
  await writePng(
    "apps/mobile/assets/android-notification-icon.png",
    glyphOnlySvg("#FFFFFF", 96, 0.8),
    96,
  );
  await writePng(
    "apps/mobile/assets/android-icon-background-dev.png",
    solidSvg("#347FF8", 432),
    432,
  );
  await writePng(
    "apps/mobile/assets/android-icon-background-nightly.png",
    solidSvg("#111533", 432),
    432,
  );
  await writePng(
    "apps/mobile/assets/android-splash-icon-dev.png",
    glyphOnlySvg("#347FF8", 1152, 0.5),
    1152,
  );
  await writePng(
    "apps/mobile/assets/android-splash-icon-nightly.png",
    glyphOnlySvg("#4F46E5", 1152, 0.5),
    1152,
  );
  await writePng(
    "apps/mobile/assets/android-splash-icon-prod.png",
    glyphOnlySvg("#0B0B0D", 1152, 0.5),
    1152,
  );

  console.log(`generated ${written.length} icon asset(s)`);
  for (const rel of written) console.log(`  ${rel}`);
}

await main();
