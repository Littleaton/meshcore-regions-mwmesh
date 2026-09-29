# Intermountain West MeshCore Regions

Region tools for a coordinated tagging scheme on the Intermountain West mesh —
Idaho and Utah, with coverage reaching into Wyoming, Montana, Nevada, and
Arizona. Forked with permission from [Adam Gessaman](https://gessaman.com/)'s
Pacific Northwest MeshCore Regions.

Scope is about intent: local traffic stays local, and wider scopes provide reach
only as far as needed. A node's tags come from where it sits and what it can
reach — not the whole hierarchy by default.

The substantive divergence from upstream is how a point becomes a region. The PNW
tools use additively-weighted Voronoi around seed points, which assumes roughly
even propagation outward from a metro centre. That fits Puget Sound; it fits the
Intermountain West badly, where a ridge can mean two towns 15 km apart never hear
each other while one 60 km down the valley comes in fine. Here, region extent is
drawn as polygons in GIS and resolved by containment.

## Contents

| Path | Purpose |
|------|---------|
| [regions.json](regions.json) | **Canonical region data** — hierarchy, borders, cross-carry rules, metro groups, optional tags |
| [regions.geo.json](regions.geo.json) | **Canonical region geometry** — the polygon layer `regions.json` points at |
| [shared/](shared/) | Resolution engine, polygon resolver, geocoder, and the optional-tag UI |
| [config/](config/) | Config generator — step-by-step wizard from location to `region` commands |
| [map/](map/) | Zone map and repeater tag selector |
| [index.html](index.html) | Landing page |

## Running locally

Everything is static — no PHP, no build step. Serve the **repository root** so
both tools can reach `regions.json`, `regions.geo.json`, and `shared/` by
relative path:

```bash
npx http-server -p 8080     # or: python3 -m http.server 8080
```

- `http://localhost:8080/` — landing page
- `http://localhost:8080/config/` — config generator
- `http://localhost:8080/map/` — zone map selector

### Docker

The included Compose setup serves the static site with Nginx and supports the
map's production `/meshcore/map/` base path:

```bash
docker compose up --build -d
```

Open `http://localhost:8080/`. To use another host port, set `PORT` when
starting Compose (for example, `PORT=8090 docker compose up --build -d` on
Linux/macOS or `$env:PORT=8090; docker compose up --build -d` in PowerShell).

Useful lifecycle commands:

```bash
docker compose ps
docker compose logs -f web
docker compose down
```

In production this is served through Nginx at `regions.mwmesh.com`.
`map/index.html` retains `<base href="/meshcore/map/">`; the container provides
that compatibility route alongside `/map/`.

### Checking your edits

```bash
cd map
node scripts/validate-regions.mjs        # hierarchy, geometry, and rule integrity
node scripts/validate-regions.mjs -v     # also reports same-depth polygon overlaps
node scripts/test-fixtures.mjs           # locks in resolution for known points
node scripts/test-fixtures.mjs --print   # dump actual output instead of asserting
```

Run both after any change to `regions.json` or the polygon layer. `--print` is
the fastest way to see what actually moved.

## How resolution works

A point resolves to the **deepest polygon containing it**. Depth comes from the
hierarchy, not from geometry, so if a simplified Utah metro boundary pokes
outside its parent area, the ancestry chain stays coherent.

Polygons overlap on purpose — that is how dual-carry zones are expressed. Where
two same-depth regions both contain a point, the one the point sits **furthest
inside** becomes primary and the other becomes the secondary candidate. If the
two are siblings (same parent) and close enough, the secondary is added as a
dual-carry tag.

Regions may nest fully or partially. A sub-region drawn larger than the metros
inside it acts as a rural backstop: a point in rural central Utah can be inside
`c-ut` but no metro, and resolves to `c-ut` with no metro tag.

Points falling in a gap snap to the nearest region within `meta.snapKm`. Points
outside the `extentTag` polygon entirely are reported out of area.

## Editing regions

`regions.json` holds every non-spatial input:

- **`hierarchy`** — the region tag tree. Purely administrative: region scopes are
  matched per-tag in firmware, so the tree exists for human legibility and for
  building `region def` commands, not for propagation. A tag with no polygon
  (`pnw`, `inw`) is never a resolution result — it is
  carried via `crossBorderRules` or `optionalTags` instead.
- **`meta.polygons`** — the geometry file, the feature property holding each
  polygon's tag, and the `extentTag` used as the in-area mask.
- **`meta.snapKm` / `meta.overlapKm`** — how far outside every polygon a point may
  sit before snapping to the nearest region, and how close a secondary region
  must be to trigger dual-carry.
- **`metroGroups`** — groupings for the high-site multi-select.
- **`borders`** — polylines for classifying a point by state or country, feeding
  `crossBorderRules`. Only expressible for lines that pass the vertical line test
  (latitude as a function of longitude) — fine for the ID/UT line at 42°N,
  impossible for a north-south line like ID/WY.
- **`crossBorderRules`** — declarative dual-carry and community-tag rules; a
  `when` condition plus `addTags` and a `note`. The current community-scope
  additions are working examples.
- **`optionalTags`** — operator-selectable checkboxes on the repeater-type step.
  Two modes:
  - `add` (default) — an overlay tag added on request rather than inferred from
    geography.
  - `strip` — inverts the checkbox. The tag is part of the normal ancestry and is
    **removed** unless opted in. It can be scoped to selected repeater types with
    `showFor` when a future region needs that behavior.

`regions.geo.json` is a GeoJSON `FeatureCollection` in WGS84; each feature's
`region` property matches a `hierarchy` tag. It is exported from GIS and
simplified to roughly 500 m — good enough to decide which tags a repeater
carries, and about 40× smaller than the raw shapefile.

Nothing in `config/`, `map/src/`, or the scripts hard-codes a place name, tag,
viewport, or border.

## Generated commands

Both tools emit the same three-part sequence, adapted to the selected firmware:

```
region def imw ut wf slc
region default wf
region save
```

`region default` is set to the sub-state area (`wf`, `wb`, `n-ut`, `c-ut`, `s-ut`)
when the point has one, or the state (`wy`, `mt`) when it does not. On v1.15 and
v1.14 the first line becomes a series of `region put` commands, with `region
allowf` added on v1.14.

## Acknowledgments

Built on [Adam Gessaman](https://gessaman.com/)'s Pacific Northwest MeshCore
Regions, used with permission. Thanks to the CascadiaMesh and PugetMesh
communities, whose discussion shaped the original scheme this one inherits.
