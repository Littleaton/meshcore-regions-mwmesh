#!/usr/bin/env node

// Behavioural fixtures for the shared engine, Intermountain West edition.
//
// These lock in: unambiguous metro resolution, sibling dual-carry inside a
// sub-region, the pnw / inw cross-carries, high-site multi-metro union, opt-in
// overlay tags, and out-of-area detection.
//
// Run with --print to dump actual output instead of asserting — useful after
// editing regions.json or the polygon layer.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  setRegions,
  setPolygons,
  resolveLocation,
  computeRecommendation,
  buildCommandLines,
  rawText
} from "../../shared/region-engine.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(ROOT, "..");
const REGIONS_PATH = path.join(REPO_ROOT, "regions.json");

const PRINT = process.argv.includes("--print");

const fixtures = [
  // ── Unambiguous metros ────────────────────────────────────────────────────
  {
    name: "Idaho Falls ID",
    lat: 43.4917, lon: -112.0339,
    repeaterType: "residential",
    expectedTags: ["imw", "id", "e-id", "ida"],
    expectedDefault: "e-id"
  },
  {
    name: "Rexburg ID (inside the ida backstop)",
    lat: 43.8260, lon: -111.7897,
    repeaterType: "residential",
    expectedTags: ["imw", "id", "e-id", "ida"]
  },
  {
    name: "Pocatello ID",
    lat: 42.8713, lon: -112.4455,
    repeaterType: "residential",
    expectedTags: ["imw", "id", "e-id", "pih"]
  },
  {
    name: "Twin Falls ID",
    lat: 42.5558, lon: -114.4701,
    repeaterType: "residential",
    expectedTags: ["imw", "id", "s-id", "twf"]
  },
  {
    name: "Salt Lake City UT",
    lat: 40.7608, lon: -111.8910,
    repeaterType: "residential",
    expectedPrimary: "slc",
    expectedContainsTags: ["imw", "ut", "wf", "slc"],
    expectedMissingTags: ["us", "west"]
  },
  {
    name: "Cedar City UT",
    lat: 37.6775, lon: -113.0619,
    repeaterType: "residential",
    expectedTags: ["imw", "ut", "s-ut", "ced"]
  },

  // ── Sibling dual-carry (shared parent + overlapping polygons) ─────────────
  {
    name: "Blackfoot ID (ida/pih overlap — siblings under e-id)",
    lat: 43.1905, lon: -112.3449,
    repeaterType: "residential",
    expectedContainsTags: ["e-id", "pih", "ida"]
  },
  {
    name: "Salmon ID (now under c-id, not e-id)",
    lat: 45.1758, lon: -113.8958,
    repeaterType: "residential",
    expectedTags: ["imw", "id", "c-id", "smn"]
  },
  {
    name: "McCall ID (myl, inside the c-id/sw-id overlap)",
    lat: 44.9110, lon: -116.0993,
    repeaterType: "residential",
    expectedPrimary: "myl",
    expectedContainsTags: ["c-id", "myl"]
  },
  {
    name: "Ketchum ID (sun under s-id)",
    lat: 43.6805, lon: -114.3638,
    repeaterType: "residential",
    expectedTags: ["imw", "id", "s-id", "sun"]
  },

  // ── Cross-carry rules ─────────────────────────────────────────────────────
  {
    name: "Coeur d'Alene ID (inw + pnw cross-carry)",
    lat: 47.6777, lon: -116.7805,
    repeaterType: "residential",
    expectedContainsTags: ["n-id", "cda", "inw", "pnw"]
  },
  {
    name: "Boise ID (pnw cross-carry, no inw)",
    lat: 43.6150, lon: -116.2023,
    repeaterType: "residential",
    expectedContainsTags: ["sw-id", "boi", "pnw"],
    expectedMissingTags: ["inw"]
  },

  // ── Coverage reaching outside the nominal parent state ────────────────────
  {
    name: "Jackson WY (inside the e-id backstop, not a metro)",
    lat: 43.4799, lon: -110.7624,
    repeaterType: "residential",
    expectedTags: ["imw", "id", "e-id"],
    expectedDefault: "e-id"
  },
  {
    name: "Elko NV (no sub-state area — default falls back to the state)",
    lat: 40.8324, lon: -115.7631,
    repeaterType: "residential",
    expectedTags: ["imw", "nv"],
    expectedDefault: "nv"
  },
  {
    name: "Salt Lake City UT default is the sub-state area, not the metro",
    lat: 40.7608, lon: -111.8910,
    repeaterType: "residential",
    expectedDefault: "wf"
  },
  {
    name: "Moab UT (c-ut rural backstop)",
    lat: 38.5733, lon: -109.5498,
    repeaterType: "residential",
    expectedTags: ["imw", "ut", "c-ut"]
  },

  // ── Unknown opt-in tags are ignored ───────────────────────────────────────
  {
    name: "Idaho Falls ID — unknown opt-in tag is ignored",
    lat: 43.4917, lon: -112.0339,
    repeaterType: "residential",
    optIn: ["not-a-real-tag"],
    expectedTags: ["imw", "id", "e-id", "ida"]
  },

  // ── High-site multi-metro ─────────────────────────────────────────────────
  {
    name: "Eastern Idaho high-site serving four metros",
    lat: 43.4917, lon: -112.0339,
    repeaterType: "high-site",
    selectedMetros: ["ida", "pih", "dij", "smn"],
    expectedContainsTags: ["e-id", "ida", "pih", "dij", "c-id", "smn"],
    maxDefLength: 160
  },

  // ── Candidate override ────────────────────────────────────────────────────
  {
    name: "Blackfoot ID forced to ida",
    lat: 43.1905, lon: -112.3449,
    repeaterType: "residential",
    forcePrimaryTag: "ida",
    expectedPrimary: "ida"
  },

  // ── Out of area ───────────────────────────────────────────────────────────
  { name: "Denver CO",  lat: 39.7392, lon: -104.9903, expectOutOfArea: true },
  { name: "Seattle WA", lat: 47.6062, lon: -122.3321, expectOutOfArea: true }
];

function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main() {
  const data = JSON.parse(await fs.readFile(REGIONS_PATH, "utf8"));
  setRegions(data);
  const geoFile = data.meta?.polygons?.file ?? "regions.geo.json";
  setPolygons(JSON.parse(await fs.readFile(path.join(REPO_ROOT, geoFile), "utf8")));

  const failures = [];

  for (const f of fixtures) {
    const res = resolveLocation(f.lat, f.lon, f.forcePrimaryTag ?? null);

    if (PRINT) {
      if (res.outOfArea) {
        console.log(`${f.name.padEnd(52)} OUT OF AREA`);
      } else {
        const rec = computeRecommendation(res, f.repeaterType ?? "residential",
                                          f.selectedMetros ?? [], f.optIn ?? []);
        const def = rawText(buildCommandLines(rec.tags, "1.16", rec.defaultTag)).split("\n")[0];
        console.log(
          `${f.name.padEnd(52)} ${res.primary.tag.padEnd(6)} ` +
          `2nd=${String(res.secondary?.tag ?? "-").padEnd(6)} ` +
          `gap=${String(res.gapKm === null ? "-" : res.gapKm.toFixed(1)).padEnd(6)} ` +
          `[${rec.tags.join(" ")}]  len=${def.length}`
        );
      }
      continue;
    }

    const add = (msg) => failures.push(`${f.name}: ${msg}`);

    if (f.expectOutOfArea) {
      if (!res.outOfArea) add(`expected out of area, resolved to ${res.primary?.tag}`);
      continue;
    }
    if (res.outOfArea) { add("unexpectedly out of area"); continue; }

    if (f.expectedPrimary && res.primary.tag !== f.expectedPrimary) {
      add(`expected primary ${f.expectedPrimary}, got ${res.primary.tag}`);
    }

    const rec = computeRecommendation(res, f.repeaterType ?? "residential",
                                      f.selectedMetros ?? [], f.optIn ?? []);

    if (f.expectedTags && !sameArray(rec.tags, f.expectedTags)) {
      add(`expected [${f.expectedTags.join(", ")}], got [${rec.tags.join(", ")}] (primary ${res.primary.tag})`);
    }
    for (const tag of f.expectedContainsTags ?? []) {
      if (!rec.tags.includes(tag)) {
        add(`missing ${tag} in [${rec.tags.join(", ")}]`);
        break;
      }
    }
    for (const tag of f.expectedMissingTags ?? []) {
      if (rec.tags.includes(tag)) add(`unexpected ${tag} in [${rec.tags.join(", ")}]`);
    }
    if (f.expectedDefault !== undefined && rec.defaultTag !== f.expectedDefault) {
      add(`expected default region ${f.expectedDefault}, got ${rec.defaultTag}`);
    }
    if (f.maxDefLength) {
      const def = rawText(buildCommandLines(rec.tags, "1.16", rec.defaultTag)).split("\n")[0];
      if (def.length > f.maxDefLength) {
        add(`region def is ${def.length} chars, over ${f.maxDefLength}: ${def}`);
      }
    }
  }

  if (PRINT) return;

  if (failures.length > 0) {
    console.error(`Fixture test failures: ${failures.length}`);
    for (const msg of failures) console.error(`- ${msg}`);
    process.exit(1);
  }
  console.log(`Fixture tests passed: ${fixtures.length}`);
}

await main();
