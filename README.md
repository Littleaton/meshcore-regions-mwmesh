# MountainWest MeshCore Region Tools

Static region-selection tools for the MountainWest Mesh community. The site is
published at [regions.mwmesh.com](https://regions.mwmesh.com/) and provides:

- a visual region and zone map;
- a guided MeshCore region configuration generator;
- firmware-aware, ready-to-paste `region` commands; and
- mapped coverage for Utah, Idaho, and surrounding Intermountain West areas.

The project is based on [Adam Gessaman](https://gessaman.com/)'s Pacific
Northwest MeshCore Regions and is used with permission.

## Current region policy

Region scope is intentionally limited so local traffic stays local. A node's
tags come from its location and intended coverage, not every parent scope that
could be added.

- `imw` (Intermountain West) is the root of the normal generated hierarchy.
- The former `us` and `west` regions have been removed.
- The former ERC region and its setting have been removed.
- There are currently no operator-selectable optional region tags.
- `pnw` and `inw` remain non-geographic community scopes used only by declared
  cross-carry rules.
- Utah recommendations carry the independent `wd-ut` wardriving scope.
- Idaho and the other surrounding states do not receive `wd-*` scopes; those
  communities manage wardriving differently.

For example, a Salt Lake City recommendation can produce:

```text
region def imw ut wf slc|* wd-ut
region default wf
region save
```

In firmware 1.16 syntax, `|*` returns the definition cursor to the root before
adding the independent wardriving scope.

Older firmware receives the equivalent `region put` sequence; firmware 1.14
also receives `region allowf` where required.

## Site structure

| Path | Purpose |
|---|---|
| [`index.html`](index.html) | MWMesh landing page |
| [`config/`](config/) | Guided configuration generator |
| [`map/`](map/) | Interactive zone map and tag selector |
| [`regions.json`](regions.json) | Canonical hierarchy, rules, labels, and metro groups |
| [`regions.geo.json`](regions.geo.json) | Canonical GeoJSON coverage polygons |
| [`shared/`](shared/) | Region engine, geocoder, shared theme, and UI helpers |
| [`assets/`](assets/) | MWMesh light and dark logo assets |
| [`Dockerfile`](Dockerfile) | Static Nginx container image |
| [`compose.yaml`](compose.yaml) | Local and production container definition |
| [`docker/nginx.conf`](docker/nginx.conf) | Container routes, `/healthz`, and `/meshcore/` compatibility |

The frontend uses the MWMesh light/dark theme. Theme preference is stored in the
`mwmesh_theme` cookie. The public contact link points to **Littleaton** through
the MWMesh Discord server.

## Run with Docker

Docker is the supported way to run the complete site. It supplies the rewrite
needed by the map's `/meshcore/map/` base path; a plain static file server does
not provide that compatibility route automatically.

```bash
docker compose up --build -d
docker compose ps
curl -f http://127.0.0.1:8080/healthz
```

Open:

- `http://localhost:8080/`
- `http://localhost:8080/config/`
- `http://localhost:8080/map/`

The container listens on port 80 internally. Compose publishes it on host port
8080 by default. Override the binding with `PORT`:

```bash
# Linux/macOS
PORT=8090 docker compose up --build -d

# PowerShell
$env:PORT = "8090"
docker compose up --build -d
```

Useful commands:

```bash
docker compose logs --tail=100 web
docker compose restart web
docker compose down
```

## Validate changes

Run these from the repository root after changing the region hierarchy,
geometry, rules, or command generation:

```bash
node map/scripts/validate-regions.mjs
node map/scripts/validate-regions.mjs -v
node map/scripts/test-fixtures.mjs
node map/scripts/test-fixtures.mjs --print
```

The current expected result is:

```text
regions.json OK — 35 regions, 32 polygons, 1 borders, 2 rules, 0 optional tags.
Fixture tests passed: 23
```

Before delivery, also run:

```bash
node --check shared/region-engine.js
node --check shared/optional-tags.js
git diff --check
```

After changing shared CSS, increment the `mwmesh-theme.css?v=` value in
`index.html`, `config/index.html`, and `map/index.html` so browsers and
Cloudflare do not retain the previous stylesheet. The current version is `v=3`.
After changing the shared region engine, likewise increment its import version
in `config/index.html` and `map/src/main.js`, plus the `main.js?v=` loader in
`map/index.html`. The current engine/main version is `v=4`. When changing
`regions.json`, also update its `version` and `REGION_DATA_VERSION` in
`shared/region-engine.js`; both are currently `0.3.1`.

## How region resolution works

A point resolves to the deepest polygon containing it. Depth comes from the
hierarchy rather than geometry, so a simplified polygon cannot create an
incorrect ancestry chain.

Same-depth polygons may overlap intentionally. In an overlap, the point
furthest inside a polygon determines the primary region. A nearby sibling can
be included as a dual-carry tag. Home/residential nodes receive that secondary
tag only when the point is actually inside both sibling polygons; merely being
within `meta.overlapKm` of the neighboring boundary is not enough. Urban
Infrastructure may use that proximity allowance, while high-site coverage is
controlled through its metro selections. A broader sub-region can also act as
a rural backstop when no metro polygon contains the point.

Points in small gaps snap to the nearest region within `meta.snapKm`. Points
outside the `extentTag` polygon are reported as out of area.

`regions.json` contains the non-spatial configuration:

- `hierarchy` defines administrative parentage and generated command order;
- `meta.polygons` identifies the GeoJSON source and in-area extent;
- `meta.snapKm` and `meta.overlapKm` control gap and overlap behavior;
- `metroGroups` provides high-site multi-select groupings;
- `borders` classifies a point by state or country for applicable rules;
- `crossBorderRules` declares community-scope and dual-carry additions;
- `meta.wardriveTags` maps Utah to its independent `wd-ut` scope;
- `optionalTags` is currently an empty array and remains available for future
  explicitly approved settings.

`regions.geo.json` is a WGS84 GeoJSON `FeatureCollection`. Each feature's
`region` property must match a hierarchy tag.

## Production deployment

The production checkout lives at:

```text
/home/ace/meshcore-regions-mwmesh
```

The public request path is:

```text
Cloudflare → host Nginx/Certbot → http://127.0.0.1:8081 → Docker Nginx
```

### 1. Create a read-only GitHub deploy key

Run as the `ace` user on the coverage server:

```bash
sudo -iu ace
mkdir -p /home/ace/.ssh
chmod 700 /home/ace/.ssh
ssh-keygen -t ed25519 -C "coverage server regions.mwmesh.com" \
  -f /home/ace/.ssh/meshcore_regions_deploy
chmod 600 /home/ace/.ssh/meshcore_regions_deploy
chmod 644 /home/ace/.ssh/meshcore_regions_deploy.pub
cat /home/ace/.ssh/meshcore_regions_deploy.pub
```

Add the printed public key in GitHub under:

`Littleaton/meshcore-regions-mwmesh` → **Settings** → **Deploy keys** →
**Add deploy key**.

Leave **Allow write access** unchecked.

Add this host entry to `/home/ace/.ssh/config`:

```sshconfig
Host github.com-meshcore-regions
    HostName github.com
    User git
    IdentityFile /home/ace/.ssh/meshcore_regions_deploy
    IdentitiesOnly yes
```

Then secure and test it:

```bash
chmod 600 /home/ace/.ssh/config
ssh -T git@github.com-meshcore-regions
```

GitHub normally responds that authentication succeeded but shell access is not
provided. That is expected.

### 2. Clone and start the service

For a new checkout:

```bash
git clone \
  git@github.com-meshcore-regions:Littleaton/meshcore-regions-mwmesh.git \
  /home/ace/meshcore-regions-mwmesh
cd /home/ace/meshcore-regions-mwmesh
```

Create `/home/ace/meshcore-regions-mwmesh/.env` with:

```dotenv
PORT=127.0.0.1:8081
```

This binds the container only to loopback so the host Nginx proxy is the public
entry point.

```bash
docker compose up --build -d
docker compose ps
curl -f http://127.0.0.1:8081/healthz
```

The upstream uses plain HTTP. Do not configure the host proxy with
`proxy_pass https://127.0.0.1:8081`; that causes connection resets and HTTP 502
responses because TLS terminates at the host Nginx server.

### 3. Configure host Nginx and Certbot

Use a single site file at `/etc/nginx/sites-available/regions.mwmesh.com`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name regions.mwmesh.com;

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable and test the site:

```bash
sudo ln -s /etc/nginx/sites-available/regions.mwmesh.com \
  /etc/nginx/sites-enabled/regions.mwmesh.com
sudo nginx -t
sudo systemctl reload nginx
```

If the symlink already exists, do not create a duplicate. Remove duplicated
`server` blocks for the same hostname before continuing.

Once DNS reaches the coverage server and ports 80/443 are open:

```bash
sudo certbot --nginx -d regions.mwmesh.com
sudo nginx -t
sudo systemctl reload nginx
```

Certbot will add the certificate paths and HTTP-to-HTTPS redirect. Keep only one
port-80 redirect block and one port-443 application block for this hostname.

### 4. Configure Cloudflare

- Create or update the `regions` DNS record to the coverage server's public IP.
- Use Cloudflare SSL/TLS mode **Full (strict)** after Certbot succeeds.
- Do not use **Flexible**, because the origin already has a valid certificate.
- If certificate issuance fails through the proxy, temporarily switch the DNS
  record to **DNS only**, issue the certificate, then re-enable the proxy.

Verify every layer independently:

```bash
curl -f http://127.0.0.1:8081/healthz
sudo nginx -t
curl -f https://regions.mwmesh.com/healthz
curl -I https://regions.mwmesh.com/
```

A healthy Docker container proves only the container layer. It does not by
itself verify host Nginx, DNS, TLS, Cloudflare, or the public browser path.

## Updating production

After reviewed changes are committed and pushed:

```bash
sudo -iu ace
cd /home/ace/meshcore-regions-mwmesh
git pull --ff-only
docker compose up --build -d
docker compose ps
curl -f http://127.0.0.1:8081/healthz
curl -f https://regions.mwmesh.com/healthz
```

If a visual change appears stale, confirm that its asset version was incremented
and purge only the affected Cloudflare cache entry if necessary.

## Acknowledgments

Built on Adam Gessaman's Pacific Northwest MeshCore Regions, used with
permission. Thanks to the CascadiaMesh and PugetMesh communities whose work
shaped the original scheme.
