import {
  HIERARCHY,
  METRO_GROUPS,
  OPTIONAL_TAGS,
  REGION_GEOJSON,
  loadRegions,
  ancestryFor,
  resolveLocation,
  computeRecommendation,
  buildCommandLines,
  rawText,
  perLineHtml,
  esc,
  colorForTag,
  META
} from "../../shared/region-engine.js?v=2";
import { geocode } from "../../shared/geocode.js";
import { mountOptionalTags } from "../../shared/optional-tags.js";

// Viewport defaults; overridden from META.map after regions load.
let MAP_CENTER = [43.0, -113.0];
let MAP_BOUNDS = [
  [36.8, -117.4],
  [49.1, -108.9]
];

const TYPE_LABELS = {
  residential: "Home / Residential",
  urban: "Urban Infrastructure",
  "high-site": "Mountaintop / High-Site"
};
const STRATEGY_LABELS = {
  "single-metro": "single metro",
  "dual-metro": "dual metro",
  "state-only": "state / province only",
  "multi-metro": "multi-metro"
};

const S = {
  lat: null,
  lon: null,
  stateOrProvince: null,
  geocodedName: "",
  forcePrimaryTag: null,
  repeaterType: "residential",
  firmware: "1.16",
  selectedMetros: [],
  optionalTags: [],
  resolution: null
};

const el = {};
const geoTagSet = new Set();

let map;
let marker = null;
let regionLayer = null;
let optTags = null;
const layerByTag = new Map();

const $ = (id) => document.getElementById(id);

function setStatus(msg, type) {
  el.locStatus.innerHTML = msg ? `<div class="status-msg ${type}">${msg}</div>` : "";
}

// Region identity comes from META (the badge + document title); the heading and
// tagline are the generic tool name, shared across regions.
function applyBranding() {
  if (META.title) document.title = META.title;
  const badge = $("brandBadge");
  if (badge && META.badge) badge.textContent = META.badge;
  const mapEl = $("map");
  if (mapEl && META.name) mapEl.setAttribute("aria-label", `${META.name} map`);
}

// ── Map layers ────────────────────────────────────────────────────────────

// Depth in the hierarchy — shallower regions draw first so metros sit on top of
// their sub-region and state backdrops.
const depthOf = (tag) => ancestryFor(tag).length - 1;

const BASE_STYLE = { weight: 1, opacity: 0.55, fillOpacity: 0.12 };

function styleFor(tag, state) {
  const color = colorForTag(tag);
  if (state === "primary") return { color: "#1b4332", weight: 3, opacity: 1,   fillColor: color, fillOpacity: 0.5 };
  if (state === "carried") return { color: "#b8860b", weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.32 };
  return { color, ...BASE_STYLE, fillColor: color };
}

// Replaces the upstream canvas Voronoi rasteriser: regions are real polygons now,
// so Leaflet draws them directly. This also retires the inverse-Mercator correction
// the raster overlay needed to stop features drifting north.
function buildRegionLayer() {
  const extentTag = META.polygons?.extentTag ?? null;
  const tagProp = META.polygons?.tagProperty ?? "region";

  const features = (REGION_GEOJSON?.features ?? [])
    .filter((f) => {
      const tag = f.properties?.[tagProp];
      return tag && tag !== extentTag && HIERARCHY[tag];
    })
    .sort((a, b) => depthOf(a.properties[tagProp]) - depthOf(b.properties[tagProp]));

  layerByTag.clear();
  const group = L.featureGroup();
  for (const feature of features) {
    const tag = feature.properties[tagProp];
    // interactive:false so clicks fall through to the map's own click handler.
    const layer = L.geoJSON(feature, { style: styleFor(tag), interactive: false });
    layer._regionTag = tag;
    layerByTag.set(tag, layer);
    layer.addTo(group);
  }
  return group;
}

// ── Highlighting ──────────────────────────────────────────────────────────

function applyHighlight(res) {
  if (!res || !res.primary) return;
  const rec = currentRecommendation(res);
  const carried = new Set(rec.tags.filter((t) => geoTagSet.has(t)));
  const primaryTag = res.primary.tag;

  for (const [tag, layer] of layerByTag) {
    const state = tag === primaryTag ? "primary" : carried.has(tag) ? "carried" : null;
    layer.setStyle(styleFor(tag, state));
    if (state === "primary") layer.bringToFront();
  }
}

// ── Recommendation ──────────────────────────────────────────────────────────

function currentRecommendation(res) {
  return computeRecommendation(res, S.repeaterType, S.selectedMetros, S.optionalTags);
}

// rebuildMetros: the high-site metro chips are seeded from the resolved top5, so
// they are stale the moment the point moves. Callers that change the LOCATION pass
// true; the chips' own onchange handler must not, or ticking a box would
// immediately overwrite the selection with the defaults again.
function recompute({ rebuildMetros = false } = {}) {
  if (S.lat === null || S.lon === null) return;
  S.resolution = resolveLocation(S.lat, S.lon, S.forcePrimaryTag);
  if (S.resolution.outOfArea) {
    setStatus(
      `That point is outside the coverage area (${META.coverage ?? META.name ?? "this region"}).`,
      "warning"
    );
    el.resultSection.classList.add("hidden");
    el.candidatesSection.classList.add("hidden");
    return;
  }
  if (rebuildMetros && S.repeaterType === "high-site") {
    buildMetroSection();   // reseeds S.selectedMetros from the new top5
  }

  const rec = currentRecommendation(S.resolution);
  renderResult(S.resolution, rec);
  renderCandidates(S.resolution);
  applyHighlight(S.resolution);
  el.resultSection.classList.remove("hidden");
  el.candidatesSection.classList.remove("hidden");
}

function renderResult(res, rec) {
  const lines = buildCommandLines(rec.tags, S.firmware, rec.defaultTag);

  const locName = S.geocodedName || `${S.lat.toFixed(4)}, ${S.lon.toFixed(4)}`;
  const locHtml = `
    <div class="result-loc">
      <div class="pin">📍</div>
      <div>
        <div class="name">${esc(locName)}</div>
        <div class="region">
          ${esc(res.primary.label)} &nbsp;<code>${res.primary.tag}</code>
          <span class="strategy-badge">${esc(STRATEGY_LABELS[rec.strategy] ?? rec.strategy)}</span>
        </div>
      </div>
    </div>`;

  const ancestry = res.primary.ancestry;
  const extras = rec.tags.filter((t) => !ancestry.includes(t));
  const crumbs = ancestry
    .map((t, i) => `<span class="crumb${i === ancestry.length - 1 ? " leaf" : ""}">${t}</span>`)
    .join('<span class="sep" aria-hidden="true"> › </span>');
  const extraCrumbs = extras.map((t) => `<span class="crumb extra">${t}</span>`).join("");
  const breadHtml = `<div class="breadcrumb" title="Region ancestry">${crumbs}${
    extraCrumbs ? '<span class="sep" aria-hidden="true"> + </span>' + extraCrumbs : ""
  }</div>`;

  const notesHtml = rec.notes.length
    ? `<div class="notes">${rec.notes.map((n) => `<div class="note">${esc(n)}</div>`).join("")}</div>`
    : "";

  el.resultContent.innerHTML =
    locHtml +
    breadHtml +
    `<div class="cmds-header">
       <span>CLI · ${esc(TYPE_LABELS[S.repeaterType] ?? S.repeaterType)}</span>
       <button class="copy-btn" id="copyBtn" title="Copy all commands">Copy</button>
     </div>
     <pre class="commands" id="cmdPre">${perLineHtml(lines)}</pre>` +
    notesHtml;

  const raw = rawText(lines);
  $("copyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(raw);
    } catch {
      /* ignore */
    }
    const btn = $("copyBtn");
    btn.textContent = "Copied ✓";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
    }, 2000);
  });

  $("cmdPre").addEventListener("click", async (e) => {
    const line = e.target.closest(".cmd-line");
    if (!line) return;
    const icon = line.querySelector(".cmd-copy-icon");
    try {
      await navigator.clipboard.writeText(line.dataset.cmd);
    } catch {
      /* ignore */
    }
    line.classList.add("line-copied");
    if (icon) icon.textContent = "✓";
    setTimeout(() => {
      line.classList.remove("line-copied");
      if (icon) icon.textContent = "⎘";
    }, 1200);
  });
}

function renderCandidates(res) {
  el.candidateList.innerHTML = res.top5
    .map((entry, i) => {
      const tag = entry.tag;
      const selected = tag === res.primary.tag;
      const context = ancestryFor(tag)
        .slice(0, -1)
        .map((t) => HIERARCHY[t]?.label ?? t)
        .join(" › ");
      return `<div class="cand-card${selected ? " selected" : ""}" role="button" tabindex="0" data-tag="${tag}">
        <div class="cand-rank">${i + 1}</div>
        <div class="cand-info">
          <div class="cand-label">${esc(entry.label)} <code>${tag}</code></div>
          <div class="cand-sub">${esc(context)}</div>
        </div>
        <div class="cand-km">${entry.inside ? "inside" : `~${Math.round(entry.km)} km`}</div>
      </div>`;
    })
    .join("");

  el.candidateList.querySelectorAll(".cand-card").forEach((card) => {
    const pick = () => {
      S.forcePrimaryTag = card.dataset.tag;
      recompute();
    };
    card.addEventListener("click", pick);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    });
  });
}

// ── Point selection ───────────────────────────────────────────────────────

function placeMarker(lat, lon) {
  if (marker) {
    marker.setLatLng([lat, lon]);
  } else {
    marker = L.marker([lat, lon]).addTo(map);
  }
}

function selectPoint(lat, lon, { name = null, state = null, recenter = false } = {}) {
  S.lat = lat;
  S.lon = lon;
  S.stateOrProvince = state;
  S.geocodedName = name ?? "";
  S.forcePrimaryTag = null;
  // A new point means a new set of nearby regions — the previous high-site
  // selection refers to metros the operator never chose for this location.
  S.selectedMetros = [];
  placeMarker(lat, lon);
  if (recenter) map.setView([lat, lon], Math.max(map.getZoom(), 8));
  recompute({ rebuildMetros: true });
}

async function doLocate() {
  const value = el.locInput.value.trim();
  if (!value) {
    setStatus("Enter a city, ZIP, or postal code.", "error");
    return;
  }
  el.locateBtn.disabled = true;
  el.locateBtn.innerHTML = '<span class="spinner"></span>…';
  setStatus("", "");
  try {
    const geo = await geocode(value, META.geocoderCountryCodes ?? "us");
    const probe = resolveLocation(geo.lat, geo.lon);
    if (probe.outOfArea) {
      setStatus(
        `That location looks outside the coverage area (${META.coverage ?? META.name ?? "this region"}). Try a city in the region.`,
        "warning"
      );
      return;
    }
    selectPoint(geo.lat, geo.lon, {
      name: geo.name,
      state: geo.stateOrProvince,
      recenter: true
    });
  } catch (err) {
    setStatus(`Couldn't find that location. <em>(${esc(err.message)})</em>`, "error");
  } finally {
    el.locateBtn.disabled = false;
    el.locateBtn.textContent = "Find";
  }
}

// ── Controls ──────────────────────────────────────────────────────────────

function syncSegButtons(container, attr, value) {
  container.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset[attr] === value);
  });
}

function buildMetroSection() {
  const preselected = new Set((S.resolution?.top5 ?? []).slice(0, 2).map((e) => e.tag));
  el.metroGroups.innerHTML = METRO_GROUPS.map(
    (group) => `
    <div class="metro-group">
      <div class="metro-group-label">${esc(group.label)}</div>
      <div class="metro-chips">${group.tags
        .map((tag) => {
          const label = HIERARCHY[tag]?.label ?? tag;
          const chk = preselected.has(tag) ? " checked" : "";
          return `<label class="metro-chip"><input type="checkbox" name="metro" value="${tag}"${chk}><code>${tag}</code> ${esc(
            label
          )}</label>`;
        })
        .join("")}</div>
    </div>`
  ).join("");
  S.selectedMetros = [...preselected];
  el.metroGroups.onchange = () => {
    S.selectedMetros = [...el.metroGroups.querySelectorAll("input:checked")].map((cb) => cb.value);
    recompute();
  };
}

function wireControls() {
  optTags = mountOptionalTags({
    container: el.optTags,
    defs: OPTIONAL_TAGS,
    hierarchy: HIERARCHY,
    callout: META.optionalTagsCallout,
    calloutContainer: el.optTagsScope,
    divider: false,
    onChange: (tags) => {
      S.optionalTags = tags;
      recompute();
    }
  });
  el.optTags.classList.remove("hidden");   // visibility is driven by refresh()
  optTags.refresh(S.repeaterType);

  el.locateBtn.addEventListener("click", doLocate);
  el.locInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLocate();
  });

  el.typeCards.querySelectorAll(".type-card").forEach((card) => {
    const select = () => {
      el.typeCards.querySelectorAll(".type-card").forEach((c) => {
        c.classList.remove("selected");
        c.setAttribute("aria-pressed", "false");
      });
      card.classList.add("selected");
      card.setAttribute("aria-pressed", "true");
      S.repeaterType = card.dataset.type;
      if (optTags) optTags.refresh(S.repeaterType);
      if (S.repeaterType === "high-site") {
        buildMetroSection();
        el.multiMetroSection.classList.remove("hidden");
      } else {
        el.multiMetroSection.classList.add("hidden");
        S.selectedMetros = [];
      }
      recompute();
    };
    card.addEventListener("click", select);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select();
      }
    });
  });

  el.firmwareGroup.querySelectorAll(".seg-btn").forEach((btn) => {
    const select = () => {
      S.firmware = btn.dataset.fw;
      syncSegButtons(el.firmwareGroup, "fw", S.firmware);
      recompute();
    };
    btn.addEventListener("click", select);
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select();
      }
    });
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function init() {
  Object.assign(el, {
    locInput: $("locInput"),
    locateBtn: $("locateBtn"),
    locStatus: $("locStatus"),
    typeCards: $("typeCards"),
    multiMetroSection: $("multiMetroSection"),
    metroGroups: $("metroGroups"),
    optTags: $("optTags"),
    optTagsScope: $("optTagsScope"),
    firmwareGroup: $("firmwareGroup"),
    resultSection: $("resultSection"),
    resultContent: $("resultContent"),
    candidatesSection: $("candidatesSection"),
    candidateList: $("candidateList")
  });

  await loadRegions();
  const tagProp = META.polygons?.tagProperty ?? "region";
  for (const f of REGION_GEOJSON?.features ?? []) {
    const tag = f.properties?.[tagProp];
    if (tag) geoTagSet.add(tag);
  }
  if (META.map?.center) MAP_CENTER = META.map.center;
  if (META.map?.bounds) MAP_BOUNDS = META.map.bounds;
  applyBranding();

  map = L.map("map", { minZoom: 5, maxZoom: 13 });
  map.setView(MAP_CENTER, 6);
  map.fitBounds(MAP_BOUNDS);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  regionLayer = buildRegionLayer().addTo(map);
  wireControls();

  map.on("click", (event) => {
    selectPoint(event.latlng.lat, event.latlng.lng, { name: null, state: null });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
}

init().catch((err) => {
  const status = document.getElementById("locStatus");
  if (status) status.innerHTML = `<div class="status-msg error">Failed to initialize: ${err.message}</div>`;
  // eslint-disable-next-line no-console
  console.error(err);
});
