# Texture sets (experimental, off by default)

OSM Buildings can show photo textures that a texture server publishes per OSM object, in the format `osm3d-texset/0.3`
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
| format check (`osm3d-texset/0.3` exactly; anything else: no textures) | yes |
| cells (XYZ z16) for the bounding boxes of the loaded buildings, 404 = no textures there | yes |
| **walls** (conformance level 1): matched **by position** against the stored `edge` (both end points within 0.3 m, either direction), because the GeoJSON tiles have no OSM node ids; wall frame u = a -> b, v up from the wall base; outer face from the ring winding (inner rings face the courtyard); texture rectangle clipped to the wall | yes |
| **node faces** (`n<id>:face`, e.g. billboards): drawn as free-standing quads from `plane` and `size_m`, front = `u x v`, back in the T0 colour | yes |
| T0: the surface colour is shown until the page has loaded | yes |
| pages: the `web` derivative (WebP), checked against `sha256`; no KTX2/Basis transcoder (WebGL1) | yes |
| attribution: one line, one link per record entry (de-duplicated by `id`), logo if the entry has one, link to the credits page of each cell | yes |
| roofs, ground, relief (depth/normal pages), mip streaming by screen size | no (they keep the normal look) |

## How it is built

- `src/features/worker.js` adds the wall edges of every building (`[lonA, latA, lonB, latB, side, base, top]`) to the loaded items.
- `src/texset/Texset.js` loads the records, matches them and builds one quad per surface (3 cm in front of the wall).
- `src/view/Texset.js` and `src/shader/texset.*` draw the quads after the buildings, with the same fog as the base map;
  front/back is decided per pixel from the surface normal and the camera position.

## Limits

- The quads are an overlay; the building walls under them are unchanged. Shadow and ambient-occlusion passes ignore them.
- Pages are uploaded whole (one WebP per page, about T2 quality); no range requests.
- Position matching works as well as the building outlines of the tiles agree with OSM (0.3 m).
