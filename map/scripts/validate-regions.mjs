#!/usr/bin/env node

// Integrity checks for the canonical regions.json + regions.geo.json.
//
// Region extent is a polygon layer, not seeds, so the seed checks from upstream are
// replaced by geometry checks: every geographic tag has a polygon, every polygon has
// a hierarchy entry, and same-depth overlaps are reported (they are legitimate
// dual-carry zones, but a surprise one usually means a digitizing slip).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(ROOT, "..");
const REGIONS_PATH = path.join(REPO_ROOT, "regions.json");

// Tags that exist in the hierarchy but deliberately have no geometry: roots,
// cross-carry community scopes, and opt-in overlays. They are carried via
// crossBorderRules or optionalTags, never resolved from a point.
const NON_GEOGRAPHIC = new Set(["pnw", "inw"]);

// Same-depth intersections below this (in square degrees) are treated as
// digitizing slivers rather than intended dual-carry, and only reported with -v.
const SLIVER_SQ_DEG = 0.02;

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const verbose = process.argv.includes("-v") || process.argv.includes("--verbose");

function ancestry(tag, hierarchy) {
  const out = [];
  const seen = new Set();
  let cur = tag;
  while (cur) {
    if (seen.has(cur)) {
      fail(`hierarchy cycle at ${cur}`);
      break;
    }
    seen.add(cur);
    out.unshift(cur);
    cur = hierarchy[cur]?.parent ?? null;
  }
  return out;
}

const depthOf = (tag, hierarchy) => ancestry(tag, hierarchy).length - 1;

// ── Minimal planar geometry (sufficient for validation-scale checks) ──────────

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a) / 2;
}

function polygonsOf(feature) {
  const g = feature.geometry;
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  return [];
}

function areaOf(polygons) {
  let a = 0;
  for (const poly of polygons) {
    a += ringArea(poly[0]);
    for (let h = 1; h < poly.length; h++) a -= ringArea(poly[h]);
  }
  return a;
}

function bboxOf(polygons) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polygons) {
    for (const [lon, lat] of poly[0]) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  }
  return [w, s, e, n];
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygons(lon, lat, polygons) {
  for (const poly of polygons) {
    if (!pointInRing(lon, lat, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lon, lat, poly[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

// Monte-Carlo intersection area over the shared bbox. Cheap, approximate, and
// plenty precise for "is this a deliberate overlap or a sliver?".
function intersectionArea(a, b, samples = 12000) {
  const [aw, as, ae, an] = bboxOf(a);
  const [bw, bs, be, bn] = bboxOf(b);
  const w = Math.max(aw, bw), s = Math.max(as, bs);
  const e = Math.min(ae, be), n = Math.min(an, bn);
  if (e <= w || n <= s) return 0;
  const boxArea = (e - w) * (n - s);
  let hits = 0;
  for (let i = 0; i < samples; i++) {
    const lon = w + Math.random() * (e - w);
    const lat = s + Math.random() * (n - s);
    if (pointInPolygons(lon, lat, a) && pointInPolygons(lon, lat, b)) hits++;
  }
  return (hits / samples) * boxArea;
}

// ── Checks ───────────────────────────────────────────────────────────────────

async function main() {
  const data = JSON.parse(await fs.readFile(REGIONS_PATH, "utf8"));
  const hierarchy = data.hierarchy ?? {};
  const meta = data.meta ?? {};

  // Comment keys are allowed anywhere; skip them when iterating tags.
  const tags = Object.keys(hierarchy).filter(k => !k.startsWith("_"));

  // Hierarchy: every parent must exist; every chain must reach a root.
  for (const tag of tags) {
    const node = hierarchy[tag];
    if (node.parent !== null && node.parent !== undefined && !hierarchy[node.parent]) {
      fail(`hierarchy: ${tag} has unknown parent ${node.parent}`);
    }
    if (!node.label) warn(`hierarchy: ${tag} has no label`);
    ancestry(tag, hierarchy);
  }

  // Polygon layer.
  const geoFile = meta.polygons?.file ?? "regions.geo.json";
  const tagProp = meta.polygons?.tagProperty ?? "region";
  const extentTag = meta.polygons?.extentTag ?? null;
  const geoPath = path.join(REPO_ROOT, geoFile);

  let geo = null;
  try {
    geo = JSON.parse(await fs.readFile(geoPath, "utf8"));
  } catch (err) {
    fail(`could not read polygon layer ${geoFile}: ${err.message}`);
  }

  const polys = new Map();
  if (geo) {
    if (geo.type !== "FeatureCollection") fail(`${geoFile}: expected a FeatureCollection`);
    for (const f of geo.features ?? []) {
      const tag = (f.properties ?? {})[tagProp];
      if (!tag) { fail(`${geoFile}: a feature has no "${tagProp}" property`); continue; }
      if (polys.has(tag)) fail(`${geoFile}: duplicate polygon for ${tag}`);
      if (!hierarchy[tag]) fail(`${geoFile}: polygon ${tag} is not in the hierarchy`);
      const p = polygonsOf(f);
      if (!p.length) fail(`${geoFile}: ${tag} has no Polygon/MultiPolygon geometry`);
      for (const poly of p) {
        for (const ring of poly) {
          if (ring.length < 4) fail(`${geoFile}: ${tag} has a ring with < 4 positions`);
          const [x0, y0] = ring[0];
          const [xn, yn] = ring[ring.length - 1];
          if (x0 !== xn || y0 !== yn) fail(`${geoFile}: ${tag} has an unclosed ring`);
          for (const [lon, lat] of ring) {
            if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
              fail(`${geoFile}: ${tag} has an out-of-range coordinate — is this WGS84?`);
              break;
            }
          }
        }
      }
      polys.set(tag, p);
    }

    if (extentTag && !polys.has(extentTag)) {
      fail(`meta.polygons.extentTag "${extentTag}" has no polygon — out-of-area detection will not work`);
    }

    // Every geographic tag needs geometry; every non-geographic tag must not.
    for (const tag of tags) {
      if (NON_GEOGRAPHIC.has(tag)) {
        if (polys.has(tag)) {
          warn(`${tag} is listed NON_GEOGRAPHIC but has a polygon — it will never win depth resolution`);
        }
      } else if (!polys.has(tag)) {
        fail(`${tag} has no polygon in ${geoFile} (add one, or list it in NON_GEOGRAPHIC)`);
      }
    }

    // Same-depth overlaps: legitimate dual-carry zones, but worth eyeballing.
    const geoTags = [...polys.keys()].filter(t => t !== extentTag);
    for (let i = 0; i < geoTags.length; i++) {
      for (let j = i + 1; j < geoTags.length; j++) {
        const a = geoTags[i], b = geoTags[j];
        if (depthOf(a, hierarchy) !== depthOf(b, hierarchy)) continue;
        const inter = intersectionArea(polys.get(a), polys.get(b));
        if (inter <= 0) continue;
        const pa = (100 * inter) / areaOf(polys.get(a));
        const pb = (100 * inter) / areaOf(polys.get(b));
        const line = `same-depth overlap ${a} × ${b}: ~${inter.toFixed(3)} sq-deg (${pa.toFixed(1)}% / ${pb.toFixed(1)}%)`;
        if (inter < SLIVER_SQ_DEG) {
          if (verbose) warn(`${line} — sliver, likely a digitizing artifact`);
        } else if (verbose) {
          warn(`${line} — dual-carry zone`);
        }
      }
    }
  }

  // Metro groups: every referenced tag must exist in the hierarchy.
  for (const g of data.metroGroups ?? []) {
    for (const tag of g.tags ?? []) {
      if (!hierarchy[tag]) fail(`metroGroup "${g.label}" references unknown tag ${tag}`);
    }
  }

  // Optional (operator-selectable) overlay tags.
  const TYPES = new Set(["residential", "urban", "high-site"]);
  for (const o of data.optionalTags ?? []) {
    if (!o.tag) continue;  // comment-only entries are fine
    if (!hierarchy[o.tag]) fail(`optionalTags: unknown tag ${o.tag}`);
    if (!o.label) fail(`optionalTags: ${o.tag} has no label`);
    const mode = o.mode ?? "add";
    if (!["add", "strip"].includes(mode)) fail(`optionalTags: ${o.tag} has invalid mode ${o.mode}`);
    if (mode === "add" && o.default === true) {
      warn(`optionalTags: ${o.tag} defaults to checked — overlays are normally opt-in`);
    }
    // A strip tag only does something if it is actually in some ancestry, which
    // means it must be a real (usually non-geographic) parent in the tree.
    if (mode === "strip" && !Object.keys(hierarchy).some(t => hierarchy[t]?.parent === o.tag)) {
      warn(`optionalTags: ${o.tag} is mode "strip" but nothing has it as a parent — stripping it will never change a command`);
    }
    for (const t of o.showFor ?? []) {
      if (!TYPES.has(t)) fail(`optionalTags: ${o.tag} showFor has unknown repeater type ${t}`);
    }
  }

  // Borders: well-formed polylines + sane mode/field, sorted ascending by lon.
  for (const b of data.borders ?? []) {
    if (!Array.isArray(b.line) || b.line.length < 2) {
      fail(`border ${b.field} needs a line of >= 2 points`);
      continue;
    }
    if (!["hard", "soft"].includes(b.mode)) fail(`border ${b.field} has invalid mode ${b.mode}`);
    for (let i = 1; i < b.line.length; i++) {
      if (b.line[i][0] <= b.line[i - 1][0]) {
        fail(`border ${b.field}: line must be sorted ascending by longitude (breaks at index ${i})`);
        break;
      }
    }
  }

  // Cross-border rules: every added tag must exist.
  for (const rule of data.crossBorderRules ?? []) {
    for (const tag of rule.addTags ?? []) {
      if (!hierarchy[tag]) fail(`crossBorderRule ${rule.id} adds unknown tag ${tag}`);
    }
    for (const tag of rule.when?.primaryTagIn ?? []) {
      if (!hierarchy[tag]) fail(`crossBorderRule ${rule.id} matches unknown tag ${tag}`);
    }
  }

  for (const w of warnings) console.warn(`! ${w}`);

  if (errors.length) {
    console.error(`regions.json validation failed (${errors.length}):`);
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }

  console.log(
    `regions.json OK — ${tags.length} regions, ${polys.size} polygons, ` +
    `${(data.borders ?? []).length} borders, ${(data.crossBorderRules ?? []).length} rules, ` +
    `${(data.optionalTags ?? []).filter(o => o.tag).length} optional tags.`
  );
}

await main();
