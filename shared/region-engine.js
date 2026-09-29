"use strict";

// ── Shared region engine ───────────────────────────────────────────────────────
// Single source of resolution + recommendation + command-building logic for both
// the /config wizard and the /map selector. Data is loaded once from /regions.json
// plus the polygon layer in /regions.geo.json (browser), or injected via
// setRegions()/setPolygons() (Node tests). The exported HIERARCHY / METRO_GROUPS /
// OPTIONAL_TAGS are live bindings — importers see them populate after load.
//
// Forked from Adam Gessaman's Pacific Northwest MeshCore Regions
// (https://gessaman.com/) with permission. The substantive divergence: region
// extent is a polygon layer rather than additively-weighted Voronoi seeds, because
// Intermountain West coverage is valley-constrained and does not approximate well
// as circles around seed points. See shared/polygon-resolver.js.

import { buildPolygonIndex, resolveByPolygon } from "./polygon-resolver.js";

export let HIERARCHY = {};
export let METRO_GROUPS = [];
export let OPTIONAL_TAGS = [];
export let BORDERS = [];
export let CROSS_BORDER_RULES = [];
export let META = {};

// Polygon layer: the raw FeatureCollection (for map rendering) and the flattened
// index the resolver walks.
export let REGION_GEOJSON = null;
export let POLYGON_INDEX = [];

export function setRegions(data) {
  HIERARCHY = data.hierarchy ?? {};
  METRO_GROUPS = data.metroGroups ?? [];
  OPTIONAL_TAGS = (data.optionalTags ?? []).filter(o => o && o.tag);
  BORDERS = Array.isArray(data.borders) ? data.borders : [];
  CROSS_BORDER_RULES = data.crossBorderRules ?? [];
  META = data.meta ?? {};
  return data;
}

export function setPolygons(geojson) {
  REGION_GEOJSON = geojson;
  POLYGON_INDEX = buildPolygonIndex(geojson, {
    tagProperty: META.polygons?.tagProperty ?? "region"
  });
  return geojson;
}

// Resolve both files relative to this module (repo-root/shared/region-engine.js),
// so the tools work regardless of where the repo is mounted. Callers may override.
export async function loadRegions(url, geoUrl) {
  const target = url ?? new URL("../regions.json", import.meta.url);
  const res = await fetch(target);
  if (!res.ok) throw new Error(`Failed to load region data (${target})`);
  const data = setRegions(await res.json());

  const geoFile = META.polygons?.file ?? "regions.geo.json";
  const geoTarget = geoUrl ?? new URL(`../${geoFile}`, import.meta.url);
  const geoRes = await fetch(geoTarget);
  if (!geoRes.ok) throw new Error(`Failed to load region polygons (${geoTarget})`);
  setPolygons(await geoRes.json());

  return data;
}

// ── Geo ─────────────────────────────────────────────────────────────────────

export function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const a = Math.sin(dLat/2)**2 +
            Math.sin(dLon/2)**2 * Math.cos(rad(aLat)) * Math.cos(rad(bLat));
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Borders ───────────────────────────────────────────────────────────────────
// Each border is a polyline of [lon, lat] sorted ascending by lon. latAtLon gives
// the border latitude at a longitude; a point north of it is on the far side. Note
// this can only express borders that pass the vertical line test — fine for the
// ID/UT line at 42°N, impossible for a north-south line like ID/WY.
//
// With polygon resolution, borders no longer filter the candidate pool (polygons
// already encode which side of a line a region covers). They survive as a
// classifier so crossBorderRules can gate on pointState / pointCountry.

function latAtLon(line, lon) {
  if (!Array.isArray(line) || line.length === 0) return null;
  if (lon <= line[0][0]) return line[0][1];
  if (lon >= line[line.length - 1][0]) return line[line.length - 1][1];
  for (let i = 1; i < line.length; i++) {
    if (lon <= line[i][0]) {
      const [x0, y0] = line[i - 1];
      const [x1, y1] = line[i];
      const t = (lon - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return line[line.length - 1][1];
}

// Classify a point against every configured border, returning a map of
// { [border.field]: sideValue } (e.g. { stateOrProvince: "ID" }).
export function classifyPoint(lat, lon) {
  const out = {};
  for (const b of BORDERS) {
    const ll = latAtLon(b.line, lon);
    if (ll === null) continue;
    out[b.field] = lat > ll ? b.north : b.south;
  }
  return out;
}

function ruleMatches(rule, ctx) {
  const w = rule.when ?? {};
  if (w.top2HasAll && !w.top2HasAll.every(t => ctx.top2.has(t))) return false;
  if (w.primaryTagIn && !w.primaryTagIn.includes(ctx.primary.tag)) return false;
  if (w.primaryState !== undefined && ctx.primary.stateOrProvince !== w.primaryState) return false;
  if (w.pointState !== undefined && ctx.classified.stateOrProvince !== w.pointState) return false;
  if (w.primaryCountry !== undefined && ctx.primary.country !== w.primaryCountry) return false;
  if (w.pointCountry !== undefined && ctx.classified.country !== w.pointCountry) return false;
  if (w.repeaterTypeIn && !w.repeaterTypeIn.includes(ctx.repeaterType)) return false;
  return true;
}

// Evaluate every crossBorderRule against ctx, returning the union of addTags/notes
// for rules that match. ctx.repeaterType is optional — omitting it (or passing none)
// excludes any rule gated with `repeaterTypeIn`, since that gate can only be
// evaluated once the operator has picked a repeater type.
function matchRules(ctx) {
  const tags = [];
  const notes = [];
  for (const rule of CROSS_BORDER_RULES) {
    if (ruleMatches(rule, ctx)) {
      tags.push(...(rule.addTags ?? []));
      if (rule.note) notes.push(rule.note);
    }
  }
  return { tags, notes };
}

// ── Resolver ─────────────────────────────────────────────────────────────────

export function ancestryFor(tag) {
  const chain = [];
  const seen = new Set();
  let cur = tag;
  while (cur) {
    if (seen.has(cur)) break;
    seen.add(cur);
    chain.unshift(cur);
    cur = HIERARCHY[cur]?.parent ?? null;
  }
  return chain;
}

function entryOut(e) {
  if (!e) return null;
  return { tag: e.tag, label: e.label, km: e.km, inside: e.inside,
           insetKm: e.insetKm, depth: e.depth, ancestry: e.ancestry };
}

/**
 * Resolve a point to a region.
 *
 * Primary is the deepest polygon containing the point; ties within that depth
 * (intentional dual-carry overlaps) break by furthest-inside. Everything else
 * ranks by distance to boundary.
 *
 * Returns null-safe fields even when the point is outside the mesh entirely —
 * check `outOfArea` before reading `primary`.
 */
export function resolveLocation(lat, lon, forcePrimaryTag = null) {
  const classified = classifyPoint(lat, lon);

  const r = resolveByPolygon(lat, lon, POLYGON_INDEX, HIERARCHY, {
    extentTag: META.polygons?.extentTag ?? "imw",
    snapKm:    META.snapKm    ?? 50,
    overlapKm: META.overlapKm ?? 12,
    topN:      5
  });

  const base = {
    country:         classified.country ?? null,
    stateOrProvince: classified.stateOrProvince ?? null,
    outOfArea:       r.outOfArea,
    snapped:         r.snapped
  };

  if (!r.primary) {
    return { ...base, nearestKm: null, top5: [], containing: [],
             primary: null, secondary: null, overlapLikely: false, gapKm: null,
             extraTags: [], extraNotes: [], ruleCtx: null };
  }

  // The candidate list only ever offers tags from top5, so an override is
  // satisfied from there; the next-best peer becomes the new secondary.
  let primary = r.primary;
  let secondary = r.secondary;
  if (forcePrimaryTag) {
    const forced = r.top5.find(e => e.tag === forcePrimaryTag);
    if (forced) {
      primary = forced;
      secondary = r.top5.find(e => e.tag !== forced.tag) ?? null;
    }
  }

  const top2 = new Set([primary.tag, secondary?.tag]);

  // Data-driven cross-border / dual-carry rules (see crossBorderRules in
  // regions.json). Some rules are gated on repeaterType, which isn't known yet at
  // this point in the flow — ruleCtx is kept on the result so computeRecommendation
  // can re-evaluate once the operator picks a type. extraTags/extraNotes below cover
  // only the type-agnostic rules, for callers wanting a preview before a type is
  // chosen.
  //
  // Under polygon resolution a region has no intrinsic state/country the way a seed
  // did, so primaryState/primaryCountry fall back to the point's own classification.
  const ruleCtx = {
    top2,
    primary: { tag: primary.tag,
               stateOrProvince: classified.stateOrProvince ?? null,
               country: classified.country ?? null },
    classified
  };
  const { tags: extraTags, notes: extraNotes } = matchRules(ruleCtx);

  return {
    ...base,
    nearestKm:     primary.km,          // 0 when the point is inside the region
    top5:          r.top5.map(entryOut),
    containing:    r.containing.map(entryOut),
    primary: {
      tag:      primary.tag,
      label:    primary.label,
      km:       primary.km,
      insetKm:  primary.insetKm,
      ancestry: ancestryFor(primary.tag)
    },
    secondary: secondary ? {
      tag:      secondary.tag,
      label:    secondary.label,
      km:       secondary.km,
      ancestry: ancestryFor(secondary.tag)
    } : null,
    overlapLikely: !!secondary && secondary.km <= (META.overlapKm ?? 12),
    gapKm:         secondary ? secondary.km : null,
    extraTags,
    extraNotes,
    ruleCtx
  };
}

// ── Policy ────────────────────────────────────────────────────────────────────

export function unique(arr) {
  const seen = new Set(); return arr.filter(v => seen.has(v) ? false : seen.add(v));
}
export function sharedPrefix(a, b) {
  const out = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) break;
    out.push(a[i]);
  }
  return out;
}

// gapKm is now distance to the secondary region's boundary (0 when the point is
// inside both), so the thresholds are scaled to overlapKm rather than to the PNW's
// seed-score gaps.
export function highSiteStrategy(res) {
  if (!res.secondary || !res.overlapLikely) return "single-metro";
  const d = res.gapKm ?? 999;
  const overlapKm = META.overlapKm ?? 12;
  if (d <= overlapKm / 2) return "dual-metro";
  return "single-metro";
}

// Two regions are "siblings" when they share a parent. This replaces the upstream
// `ancestry[3] === pA[3]` check, which hardcoded the PNW's uniform 5-deep tree —
// at IMW depth, index 3 is the state, so every pair of Idaho regions looked like a
// boundary pair. Comparing parents is depth-independent and survives re-parenting.
function isSibling(a, b) {
  const pa = HIERARCHY[a]?.parent ?? null;
  const pb = HIERARCHY[b]?.parent ?? null;
  return pa !== null && pa === pb;
}

/**
 * Pick the tag for `region default`: the sub-state area if the point has one
 * (e-id, c-id, n-ut, s-ut …), otherwise the state (wy, mt …).
 *
 * Derived structurally rather than by hardcoded depth, so it survives
 * re-parenting: states are the children of the extent tag (imw), sub-state areas
 * are their children. meta.defaultRegionOffset overrides the 2 for a fork whose
 * tree is shaped differently.
 */
export function defaultRegionFor(ancestry) {
  if (!Array.isArray(ancestry) || ancestry.length === 0) return null;
  const extentTag = META.polygons?.extentTag ?? null;
  const offset = META.defaultRegionOffset ?? 2;
  const i = extentTag ? ancestry.indexOf(extentTag) : -1;
  if (i === -1) return ancestry[ancestry.length - 1] ?? null;
  // Prefer the sub-state area; fall back to the state; then to the extent itself.
  return ancestry[i + offset] ?? ancestry[i + 1] ?? ancestry[i] ?? null;
}

/**
 * @param {Object}   res            from resolveLocation()
 * @param {string}   repeaterType   "residential" | "urban" | "high-site"
 * @param {string[]} selectedMetros high-site metro selection
 * @param {string[]} optIn          operator-selected overlay tags (see optionalTags)
 */
export function computeRecommendation(res, repeaterType, selectedMetros = [], optIn = []) {
  if (!res || !res.primary) {
    return { strategy: "single-metro", tags: [], notes: [], defaultTag: null };
  }

  const pA   = res.primary.ancestry;
  const pTag = res.primary.tag;
  // Always from the primary's own ancestry, never the flattened tag union — a
  // high-site spanning two states would otherwise be ambiguous.
  const defaultTag = defaultRegionFor(pA);
  // Re-evaluate crossBorderRules now that repeaterType is known, so rules gated with
  // `repeaterTypeIn` (e.g. high-site-only good-neighbor tags) are included correctly.
  const { tags: extra, notes: extraNotes } = res.ruleCtx
    ? matchRules({ ...res.ruleCtx, repeaterType })
    : { tags: res.extraTags ?? [], notes: res.extraNotes ?? [] };

  // A home node should dual-carry only where the mapped polygons genuinely
  // overlap. `overlapLikely` also includes points merely close to a sibling
  // boundary (within meta.overlapKm), which is useful for infrastructure but
  // was incorrectly adding Utah County to Sandy-area residential nodes.
  const actualSiblingOverlap = !!res.secondary &&
    isSibling(res.secondary.tag, pTag) &&
    (res.containing ?? []).some(entry => entry.tag === res.secondary.tag);

  // Operator-selected overlay tags. Never geographic, never inferred —
  // appended after the rule-driven tags so they sort last in the command, and run
  // through the same unique() and length check as everything else.
  const applyOptIn = (tags, notes) => {
    // mode "add" (the default): an overlay tag the operator asked for.
    for (const tag of optIn ?? []) {
      const def = OPTIONAL_TAGS.find(d => d.tag === tag);
      if (def && def.mode === "strip") continue;       // handled below
      if (!HIERARCHY[tag] || tags.includes(tag)) continue;
      tags.push(tag);
      notes.push(
        `${HIERARCHY[tag].label ?? tag} (${tag}) added at your request — an opt-in ` +
        `overlay, not part of the geographic hierarchy.`
      );
    }

    // mode "strip": a wide scope that IS part of the normal ancestry but is left
    // off unless the operator opts in. Applies only to the repeater types listed
    // in showFor, so a home node is unaffected by a high-site-only toggle.
    const strip = new Set();
    for (const def of OPTIONAL_TAGS) {
      if (def.mode !== "strip") continue;
      if (Array.isArray(def.showFor) && !def.showFor.includes(repeaterType)) continue;
      if ((optIn ?? []).includes(def.tag)) continue;
      strip.add(def.tag);
    }
    // Remove EVERY occurrence: a high-site unions the primary ancestry with one
    // ancestry per selected metro, so a root tag appears several times before
    // unique() runs.
    const dropped = [];
    for (let i = tags.length - 1; i >= 0; i--) {
      if (!strip.has(tags[i])) continue;
      if (!dropped.includes(tags[i])) dropped.push(tags[i]);
      tags.splice(i, 1);
    }
    dropped.reverse();
    if (dropped.length) {
      notes.push(
        `Wide scope${dropped.length > 1 ? "s" : ""} ${dropped.join(", ")} left off. ` +
        `Consider enabling above if there isn't a current problem with congestion.`
      );
    }
  };

  if (repeaterType === "residential") {
    const tags  = [...pA];
    const notes = ["Home profile — full ancestry for the selected local area."];
    if (actualSiblingOverlap) {
      tags.push(res.secondary.tag);
      notes.push(`Mapped coverage overlap detected — dual local carry added (${pTag} + ${res.secondary.tag}).`);
    }
    tags.push(...extra);
    const all = [...notes, ...extraNotes];
    applyOptIn(tags, all);
    return { strategy: actualSiblingOverlap ? "dual-metro" : "single-metro",
             tags: unique(tags), notes: all, defaultTag };
  }

  if (repeaterType === "urban") {
    const tags  = [...pA];
    const notes = ["Urban infrastructure — one metro with full ancestry."];
    if (res.secondary && res.overlapLikely) {
      tags.push(res.secondary.tag);
      notes.push(`Dual-carry added — point is in overlapping coverage (${pTag} + ${res.secondary.tag}).`);
    }
    const baseLen = pA.length;
    tags.push(...extra);
    const all = [...notes, ...extraNotes];
    applyOptIn(tags, all);
    return { strategy: tags.length > baseLen ? "dual-metro" : "single-metro",
             tags: unique(tags), notes: all, defaultTag };
  }

  if (repeaterType === "high-site") {
    const metros = selectedMetros.length > 0 ? selectedMetros : [pTag];
    const allTags = [...pA];
    for (const tag of metros) allTags.push(...ancestryFor(tag));
    allTags.push(...extra);
    const notes = metros.length > 1
      ? [`High-site serving ${metros.length} areas: ${metros.join(", ")}.`, ...extraNotes]
      : ["High-site — single metro affiliation with full ancestry.", ...extraNotes];
    applyOptIn(allTags, notes);
    return { strategy: metros.length > 1 ? "multi-metro" : "single-metro",
             tags: unique(allTags), notes, defaultTag };
  }

  const tags = [...pA];
  const notes = [];
  applyOptIn(tags, notes);
  return { strategy: "single-metro", tags: unique(tags), notes, defaultTag };
}

// ── Command builder ───────────────────────────────────────────────────────────

// Build the token sequence for a single `region def` command (firmware 1.16+).
// tags must be in root-to-leaf order as produced by unique(ancestryFor(...)).
// Each token is either "tag" (cursor moves to tag) or "tag|jump" (create tag,
// then reposition cursor to the named existing region).
//
// A root-level optional tag (parent null) emits "*" as its jump
// target, the same token a missing hierarchy entry would produce, so the cursor
// returns to the root rather than to a named parent.
export function buildRegionDefTokens(tags) {
  const tokens = [];
  const present = new Set(tags);
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (i === tags.length - 1) {
      tokens.push(tag);  // last token — no jump needed
    } else {
      // A parent that was stripped from the list (or is a root) can't be jumped
      // to — fall back to "*" so the cursor returns to the root instead.
      const rawParent = HIERARCHY[tags[i + 1]]?.parent ?? null;
      const nextParent = rawParent && present.has(rawParent) ? rawParent : "*";
      // If the next tag's parent IS this tag, the cursor will naturally land here.
      // Otherwise emit tag|nextParent so the cursor is positioned for the next tag.
      tokens.push(nextParent === tag ? tag : `${tag}|${nextParent}`);
    }
  }
  return tokens;
}

export function buildCommandLines(tags, firmware, defaultTag = null) {
  // `region default <tag>` sits between the region definition and `region save`.
  // Only emitted when the tag is actually being carried — setting a default to a
  // region the node has no scope for would be meaningless.
  const dflt = defaultTag && tags.includes(defaultTag)
    ? [{ type: "default", tag: defaultTag }]
    : [];

  if (firmware === "1.16") {
    const tokens = buildRegionDefTokens(tags);
    const defText = `region def ${tokens.join(" ")}`;
    const lines = [{ type: "def", text: defText, tokens, tooLong: defText.length > 160 }];
    lines.push(...dflt);
    lines.push({ type: "save" });
    return lines;
  }

  const lines = [];
  const added = new Set();
  const present = new Set(tags);
  for (const tag of tags) {
    if (added.has(tag)) continue;
    // Same guard as above: never `region put x y` where y isn't being created.
    const rawParent = HIERARCHY[tag]?.parent ?? null;
    const parent = rawParent && present.has(rawParent) ? rawParent : null;
    lines.push({ type: "put", tag, parent });
    if (firmware === "1.14") lines.push({ type: "allowf", tag });
    added.add(tag);
  }
  lines.push(...dflt);
  lines.push({ type: "save" });
  return lines;
}

export function rawText(lines) {
  return lines.map(l => {
    if (l.type === "def")    return l.text;
    if (l.type === "put")    return l.parent ? `region put ${l.tag} ${l.parent}` : `region put ${l.tag}`;
    if (l.type === "allowf")  return `region allowf ${l.tag}`;
    if (l.type === "default")  return `region default ${l.tag}`;
    return "region save";
  }).join("\n");
}

export const esc = s => String(s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

export function perLineHtml(lines) {
  return lines.map(l => {
    let inner, raw;
    if (l.type === "def") {
      const tokenHtml = l.tokens.map(t => {
        const [name, jump] = t.split("|");
        return `<span class="c-tag">${name}</span>${jump ? `<span class="c-par">|${jump}</span>` : ""}`;
      }).join(" ");
      inner = `<span class="c-kw">region def</span> ${tokenHtml}`;
      raw   = l.text;
      if (l.tooLong) inner += ` <span title="Command may exceed 160-char serial limit — use v1.15 mode if this causes issues" style="color:var(--gold-warm);cursor:help">⚠</span>`;
    } else if (l.type === "put") {
      const par = l.parent ? ` <span class="c-par">${l.parent}</span>` : "";
      inner = `<span class="c-kw">region put</span> <span class="c-tag">${l.tag}</span>${par}`;
      raw   = l.parent ? `region put ${l.tag} ${l.parent}` : `region put ${l.tag}`;
    } else if (l.type === "allowf") {
      inner = `<span class="c-af">region allowf ${l.tag}</span>`;
      raw   = `region allowf ${l.tag}`;
    } else if (l.type === "default") {
      inner = `<span class="c-kw">region default</span> <span class="c-tag">${l.tag}</span>`;
      raw   = `region default ${l.tag}`;
    } else {
      inner = `<span class="c-save">region save</span>`;
      raw   = "region save";
    }
    return `<div class="cmd-line" data-cmd="${esc(raw)}" title="Click to copy">${inner}<span class="cmd-copy-icon" aria-hidden="true">⎘</span></div>`;
  }).join("");
}

// ── Display helpers ─────────────────────────────────────────────────────────

// Deterministic color per tag, shared so map layers and legends stay consistent.
export function colorForTag(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i += 1) {
    hash = (hash * 31 + tag.charCodeAt(i)) % 360;
  }
  return `hsl(${hash}, 58%, 47%)`;
}
