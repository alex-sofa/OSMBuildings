# Texture sets (experimental, off by default)

OSM Buildings can show photo textures that a texture server publishes per OSM object, in the format `osm3d-texset/0.4`
(specification: `docs/TEXTURE_FORMAT.md` and `docs/TEXTURE_CLIENT_SPEC.md` in https://github.com/alexschultze/dev-open-3d-builder).
The geometry stays OSM Buildings' own; textures are looked up by surface and drawn on top of it.

```js
const osmb = new OSMBuildings({
  container: 'map',
  position: { latitude: 47.67216, longitude: 9.49049 },
  zoom: 19,
  textureSet: {
    bootstrap: 'https://textures.malpy.de/',   // or a list; serves textures/<region>/latest.json
    region: 'bodensee'
  }
});
```

## What is supported

| Spec item | Status |
| --- | --- |
| `latest.json` -> mirror (weighted random, failover on network errors, 429, 5xx) -> `manifest.json` | yes |
| format check (`osm3d-texset/0.4` exactly; anything else, including older versions: no textures) | yes |
| cells (XYZ z16) for the bounding boxes of the loaded buildings, 404 = no textures there | yes |
| **walls** (level 1): matched **by position** against the stored `edge` (both end points within 0.3 m, either direction), because the GeoJSON tiles have no OSM node ids, and accepted only if the outer normal of the client edge is within 45° of `outward`; wall frame u = a -> b, v up from the wall base; outer face from the ring winding (inner rings face the courtyard) | yes |
| party walls (`outward`, `shared`): the 45° test picks the side; among several survivors the edge of the same OSM object wins (feature `id` = record object, relation or way of the key); only the exposed rectangle is in the data | yes |
| **height model** (`wall_m`): v in metres from the client's base, clipped at its wall top (T0 above); stretched by `own height / (top - base)` only when `basis.height` is `assumed` | yes |
| **wall chains** (`:walls:`, level 2): the client ring is walked from the first to the last chain node (either direction), its edges get u by cumulative arc length, scaled to the stored length if they differ by less than 2 % (else T0); outward test on the chord | yes |
| **part walls on outlines** (`outline_key`, level 2): when no client edge matches the part edge, the client edge that contains it (both end points within 0.3 m of the segment, outward test) gets the part texture at the part's position and at `wall_m[0]` above the client base | yes |
| **node faces** (`n<id>:face`, e.g. billboards): drawn as free-standing quads from `plane` and `size_m`, front = `u x v`, back in the T0 colour; OSM Buildings has no own model of them, so `basis` does not change anything | yes |
| T0: the surface colour is shown until the page has loaded | yes |
| pages: the `web` derivative (WebP), checked against `sha256`; no KTX2/Basis transcoder (WebGL1) | yes |
| attribution: one line, one link per record entry (de-duplicated by `id`), logo if the entry has one; `scope`: manifest entries once, `cell` entries while a surface of the cell is drawn, `surface` entries while one of their `keys` is drawn; **one** credits link, the cell under the view centre | yes |
| `regions` (level 3): not read; the attribution uses all entries of the cell, which covers all sources of the surface | no |
| roofs, ground, relief (depth/normal pages), mip streaming by screen size | no (they keep the normal look) |

## How it is built

- `src/features/worker.js` adds the wall edges of every building (`[lonA, latA, lonB, latB, side, base, top, id, ring id, index in ring]`, wall base and top with the same rules as the triangulation, which are the height model of the format) to the loaded items.
- `src/texset/Texset.js` loads the records, matches them and builds one quad per surface and client edge (3 cm in front of the wall).
- `src/view/Texset.js` and `src/shader/texset.*` draw the quads after the buildings, with the same fog as the base map;
  front/back is decided per pixel from the surface normal and the camera position.

## Limits

- The quads are an overlay; the building walls under them are unchanged. Shadow and ambient-occlusion passes ignore them.
- Pages are uploaded whole (one WebP per page, about T2 quality); no range requests.
- Position matching works as well as the building outlines of the tiles agree with OSM (0.3 m).
