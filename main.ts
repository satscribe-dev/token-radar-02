// Launch Radar entrypoint: reads the sealed snapshot, prices every
// pre-token protocol with the model in dashboard/model.js, and writes the
// board, the dashboard data, the dashboard, the screenshots and the
// dossier into the output directory.
//
// Run it locally with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
// The grader runs it with the snapshot at /input/snapshot.json and the
// repository mounted read-only; MAKEFUN_BOT_DIR names the repository.
// --stage writes everything except dossier.json, so the dashboard can be
// screenshotted first; the real run copies the committed screenshots in.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";
import "./dashboard/model.js";

const RadarModel = (globalThis as any).RadarModel;

function fail(message: string): never {
  throw new Error("token radar: " + message);
}

function flagValue(argv: string[], name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return null;
}

function resolveRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.MAKEFUN_BOT_DIR, here].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(join(c, "dashboard")) && existsSync(join(c, "dashboard", "model.js"))) return c;
  }
  return here;
}

function readPngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function readJpegSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 9 < buf.length) {
    if (buf[pos] !== 0xff) return null;
    const marker = buf[pos + 1];
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = buf.readUInt16BE(pos + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(pos + 5), w: buf.readUInt16BE(pos + 7) };
    }
    pos += 2 + len;
  }
  return null;
}

function walkFiles(dir: string, base: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = base ? base + "/" + name : name;
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, rel, out);
    else if (st.isFile()) out.push(rel);
  }
}

function verifyGate(outDir: string, board: any, snapshot: any): void {
  // 1. dashboard_files
  const dashDir = join(outDir, "dashboard");
  const dashFiles: string[] = [];
  walkFiles(dashDir, "", dashFiles);
  if (dashFiles.length === 0 || dashFiles.length > 400) fail("dashboard: file count " + dashFiles.length);
  if (!dashFiles.includes("index.html")) fail("dashboard: index.html missing");
  if (!dashFiles.some((f) => f.endsWith(".css"))) fail("dashboard: no .css file");
  if (!dashFiles.some((f) => f.endsWith(".js"))) fail("dashboard: no .js file");
  let dashBytes = 0;
  for (const f of dashFiles) {
    if (!/^[A-Za-z0-9._-]+$/.test(f.split("/").pop() || "")) fail("dashboard: bad name " + f);
    const buf = readFileSync(join(dashDir, f));
    dashBytes += buf.length;
    const text = buf.toString("utf8");
    if (text.includes("http://") || text.includes("https://")) fail("dashboard: network address in " + f);
  }
  if (dashBytes > 4 * 1024 * 1024) fail("dashboard: over 4 MiB");

  // 2. board_file + 3. sorted_by_value + 4. coverage + 5. farm_steps
  const rows = board.rows;
  if (!Array.isArray(rows) || rows.length < 100 || rows.length > 4000) fail("board: row count " + (rows?.length ?? 0));
  const boardBytes = Buffer.byteLength(JSON.stringify(board), "utf8");
  if (boardBytes > 8 * 1024 * 1024) fail("board: over 8 MiB");
  const slugs = new Set((snapshot.protocols || []).map((p: any) => p.slug));
  const seenRanks = new Set<number>();
  let allSame = true;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (typeof r.slug !== "string" || !slugs.has(r.slug)) fail("board: unknown slug at row " + i);
    if (typeof r.name !== "string" || r.name.length === 0) fail("board: empty name at row " + i);
    if (!Number.isInteger(r.rank) || r.rank <= 0) fail("board: bad rank at row " + i);
    if (seenRanks.has(r.rank)) fail("board: duplicate rank " + r.rank);
    seenRanks.add(r.rank);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      fail("board: bad implied_value_usd at row " + i);
    }
    if (i > 0 && r.implied_value_usd !== rows[i - 1].implied_value_usd) allSame = false;
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      fail("board: farm_steps count at row " + i);
    }
    for (const s of r.farm_steps) {
      if (typeof s !== "string" || s.trim().length < 20 || s.trim().length > 600) {
        fail("board: farm step length at row " + i + " (" + (typeof s === "string" ? s.trim().length : "?") + ")");
      }
    }
  }
  if (rows.length >= 2 && allSame) fail("board: all implied values equal");
  for (let i = 1; i <= rows.length; i++) if (!seenRanks.has(i)) fail("board: rank " + i + " missing");
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd) fail("board: implied rises at rank " + rows[i].rank);
  }
  const rowSlugs = new Set(rows.map((r: any) => r.slug));
  for (const w of snapshot.watchlist || []) {
    if (!rowSlugs.has(w)) fail("board: watchlist slug missing: " + w);
  }

  // 6. screenshots
  const shotDir = join(outDir, "screenshots");
  const shots = readdirSync(shotDir).filter((n) => !n.startsWith(".")).sort();
  if (shots.length < 3 || shots.length > 4) fail("screenshots: count " + shots.length);
  for (const name of shots) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) fail("screenshots: bad name " + name);
    const buf = readFileSync(join(shotDir, name));
    if (buf.length > 512 * 1024) fail("screenshots: " + name + " over 512 KiB");
    const size = readPngSize(buf) ?? readJpegSize(buf);
    if (!size) fail("screenshots: " + name + " is not a whole PNG or JPEG");
    const longSide = Math.max(size.w, size.h), shortSide = Math.min(size.w, size.h);
    if (longSide > 1440 || shortSide < 800) fail("screenshots: " + name + " is " + size.w + "x" + size.h);
  }

  // 7. dossier_matches (buildDossier returns canonical JSON *bytes*)
  const dossierPath = join(outDir, "dossier.json");
  const written = readFileSync(dossierPath);
  const rebuilt = buildDossier(outDir, { text_max_bytes: 65536 });
  if (!written.equals(rebuilt)) fail("dossier: written dossier does not match buildDossier output");
  if (written.length > 1536 * 1024) fail("dossier: over 1.5 MiB");
}

function main(): void {
  const argv = process.argv.slice(2);
  const stage = argv.includes("--stage");
  const root = resolveRoot();
  const inputPath =
    flagValue(argv, "--input") ||
    (existsSync("/input/snapshot.json") ? "/input/snapshot.json" : join(root, "input", "snapshot.json"));
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || join(root, "out");
  const snapshot = JSON.parse(readFileSync(inputPath, "utf8"));
  const built = RadarModel.buildBoard(snapshot);

  mkdirSync(outDir, { recursive: true });
  const board = { as_of: built.asOf, model: "launch-radar: comps-fitted size curve, logistic launch odds from peers, blind-tested", rows: built.rows };
  writeFileSync(join(outDir, "board.json"), JSON.stringify(board, null, 2) + "\n");
  const dataScript = "window.RADAR_DATA = " + JSON.stringify(built) + ";\n" +
    "window.RADAR_SNAPSHOT = " + JSON.stringify(snapshot) + ";\n";
  writeFileSync(join(outDir, "data.js"), dataScript);
  cpSync(join(root, "dashboard"), join(outDir, "dashboard"), { recursive: true });
  const shotSrc = join(root, "screenshots");
  mkdirSync(join(outDir, "screenshots"), { recursive: true });
  if (existsSync(shotSrc)) {
    for (const name of readdirSync(shotSrc).filter((n) => !n.startsWith("."))) {
      cpSync(join(shotSrc, name), join(outDir, "screenshots", name));
    }
  }
  if (!stage) {
    writeFileSync(join(outDir, "dossier.json"), buildDossier(outDir, { text_max_bytes: 65536 }));
    verifyGate(outDir, board, snapshot);
  }
  const top = built.rows[0];
  console.log(
    `token radar: wrote ${join(outDir, "board.json")}, ${join(outDir, "data.js")}, ` +
      `${join(outDir, "dashboard")} (${readdirSync(join(outDir, "dashboard")).length} files), ` +
      `${join(outDir, "screenshots")} (${readdirSync(join(outDir, "screenshots")).length} images)` +
      (stage ? " [staged, no dossier]" : " and dossier.json") +
      `\nboard: ${built.rows.length} rows, watchlist ${built.watchlistCovered}/${built.watchlistCount}, ` +
      `set aside ${built.setAsideCount}, Worth farming ${built.counts.farm} / Marginal ${built.counts.thin} / Skip ${built.counts.skip}` +
      `\ncurve: log10(mcap) = ${built.curve.a.toFixed(4)} + ${built.curve.b.toFixed(4)}*log10(TVL), n=${built.curve.n}` +
      `\nvalidation: leave-one-out median miss x${built.validation.looMedian.toFixed(2)} vs flat x${built.validation.flatMedian.toFixed(2)}` +
      `, within 3x ${(100 * built.validation.looWithin3).toFixed(1)}% vs ${(100 * built.validation.flatWithin3).toFixed(1)}%` +
      `; time split x${built.validation.timeCurveMedian?.toFixed(2)} vs x${built.validation.timeFlatMedian?.toFixed(2)}` +
      `\ntop row: ${top.name} implied ${RadarModel.fmtMoney(top.implied_value_usd)} (${top.verdict} ${RadarModel.fmtSigned(top.net_usd)})`,
  );
}

main();
