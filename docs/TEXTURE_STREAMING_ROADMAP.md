# Roadmap: streamed textures per OSM entity

Status: draft · scope: phase 1 covers **walls only** · **implemented (experimental): walls and node faces with the `web` derivative, see [TEXTURE_SET.md](TEXTURE_SET.md)** · data format: `osm3d-texset/0.3` (texture set records served as static files, see the client specification of the
texture project: `docs/TEXTURE_CLIENT_SPEC.md` and `docs/TEXTURE_FORMAT.md` in https://github.com/alexschultze/dev-open-3d-builder)

## Goal

OSM Buildings keeps drawing the buildings it builds from OSM data. For walls that have a photo-derived texture, it loads that texture by a stable key and draws it on the
wall instead of the built-in procedural wall texture. Everything else keeps today's look. Textures belong to OSM objects, not to meshes; OSM Buildings does not need new
server logic, only static files.

## What the client must do (conformance level 1: walls)

1. Load `latest.json` -> `manifest.json` from a configurable entry URL; pick a mirror; fail over on `429`/`5xx`.
2. For every visible cell (XYZ z16) load `cells/<z>/<x>/<y>.json`; a surface is listed once, in the cell of its centre, so load all cells that touch a building's bounding box.
3. Form the wall key `<w|r><way id>:wall:<node a>-<node b>`. **OSM Buildings' tiles are GeoJSON without node ids**, so the client matches by position instead: the index stores
   `edge: [lon_a, lat_a, lon_b, lat_b]` for every wall (tolerance 0.3 m).
4. Build the wall quad on the edge (u from a to b in metres, v up from the wall base), outer face only, and map the stored `uv` rectangle with `origin`/`size_m`.
5. Choose a mip by screen-space texel size; start with T0 (colour from the index) and refine.
6. Show one attribution line assembled from the records (manifest + loaded cells), one link per entry.
7. Anything unmatched, a `geom_hash` mismatch, an unsupported format or a failed request: keep the current procedural wall (T0).

No OSM tag is needed; there is no per-object request.

## Constraints specific to this code base

- **Geometry** is created in a worker (`src/features/worker.js`, `src/triangulate/split.js`); each building becomes one set of merged, non-indexed buffers per tile. Walls are
  extruded with a repeating 64x64 wall texture (`texCoords`, `extrusion` in `split.js`). Per-wall surface keys and atlas uvs have to travel through the worker as extra data.
- **WebGL1 / GLSL ES 1.00**: no KTX2/Basis transcoder in the code base; use the optional **`web` derivative** (WebP page, same uv, one plain file) of the format. NPOT and
  mip restrictions of WebGL1 apply (atlas pages are power-of-two).
- **Atlas layout** (16 px aligned rectangles with an 8 px gutter, `manifest.atlas`): the wall shader must clamp, not repeat, and clamp to the rectangle when it sources neighbouring texels.
- The existing opt-in parallax mapping (branch `dev_parallalmapping`) can later use `depth` pages (`h = 1 - stored`, white = surface); out of scope for phase 1.
- The render loop and the three-pass shadow pipeline are costly (see the separate performance analysis); texture streaming should not add per-frame work.

## Phases

### Phase 0 - Prototype
- Hand-written cell index and one page for a single building; draw it on one wall with a debug flag to check orientation (u a -> b, mirrored pages for clockwise rings) and the outer-face rule.

### Phase 1 - Walls
- Worker: carry wall edges (coordinates), outline orientation and base height per building into the buffers or a side table.
- Loader: `latest.json`, manifest, cell index and web-derivative pages with caching; mirror selection and failover.
- Shader: a textured-wall path with atlas uv per vertex, selected per wall; fallback to the existing wall texture.
- Attribution: assemble the single line from the records; hooks in the existing attribution control.
- Test: fixed index and page fixtures in headless Chromium; compare with and without data.

### Phase 2 - More surfaces
- Roofs (matched by `plane`), node faces such as billboards (`n<id>:face`), ground pyramid.

### Phase 3 - Quality
- Mip streaming by screen-space size, optional `depth`/`normal` pages with parallax mapping, KTX2 where a transcoder is available.

## Open questions

- How to carry per-wall data through the merged per-tile buffers without a per-wall draw call (atlas uv in an attribute is the obvious route).
- Where the tile server (GeoJSON) gets building-part outlines and `min_height` so that the wall base matches the generator's.
- Licence: OSM Buildings mixes BSD-style, MIT and GPL-3.0 fragments (`LICENSE.md`); new client code is written independently and must follow the project's own licence.
- Mapillary-derived textures need their logo and link in the attribution line (taken from the record, not hard-coded).
