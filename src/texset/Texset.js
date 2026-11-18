
/**
 * Client for streamed texture sets (format osm3d-texset/0.3), conformance level 1 (walls) plus node faces.
 *
 * Flow: bootstrap URL -> textures/<region>/latest.json -> mirror -> manifest.json -> cell index (XYZ z16)
 * -> `web` derivative of the atlas page (WebP; WebGL1 has no KTX2/Basis transcoder here).
 *
 * Matching: the GeoJSON data of OSM Buildings has no OSM node ids, so walls are matched by position: a building
 * edge matches a stored `edge` when both end points are within 0.3 m (either direction); this tolerance test
 * replaces the geom_hash check. Node faces (e.g. billboards) have no object in OSM Buildings and are drawn as
 * free-standing quads from `plane` and `size_m`. Anything unmatched keeps the normal procedural look (T0).
 */
class Texset {

  constructor (options = {}) {
    this.format = 'osm3d-texset/0.3';
    this.bootstrap = [].concat(options.bootstrap || Texset.DEFAULT_BOOTSTRAP);
    this.region = options.region || 'bodensee';
    this.tolerance = options.tolerance || 0.3; // metres, TEXTURE_FORMAT.md position matching
    this.wallOffset = 0.03; // metres in front of the wall, against z-fighting

    this.mirrors = [];
    this.mirrorIndex = 0;
    this.release = null;
    this.manifest = null;

    this.cells = {};      // key "x,y" -> cell index record, null (404) or 'loading'
    this.pages = {};      // file -> { texture, ready }
    this.surfaces = [];   // drawable surfaces
    this.attribution = [];
    this.dirty = false;
    this.featureCount = -1;

    this.onAttribution = options.onAttribution || (() => {});
    this.onChange = options.onChange || (() => {});

    this.start();
  }

  //***************************************************************************
  // loading

  fetchJSON (url) {
    return fetch(url).then(res => {
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
  }

  // tries the current mirror, fails over to the next one on network errors, 429 and 5xx
  fetchFromMirror (path, type = 'json') {
    const tryMirror = attempt => {
      if (attempt >= this.mirrors.length) {
        return Promise.reject(new Error(`no mirror delivered ${path}`));
      }
      const mirror = this.mirrors[(this.mirrorIndex + attempt) % this.mirrors.length];
      const url = `${mirror.url}textures/${this.region}/${path}`;
      const request = type === 'json' ? this.fetchJSON(url) : fetch(url).then(res => {
        if (res.status === 404) {
          return null;
        }
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} for ${url}`);
          err.status = res.status;
          throw err;
        }
        return res.arrayBuffer();
      });
      return request.catch(err => {
        if (!err.status || err.status === 429 || err.status >= 500) {
          return tryMirror(attempt + 1);
        }
        throw err;
      });
    };
    return tryMirror(0);
  }

  start () {
    const tryBootstrap = i => {
      if (i >= this.bootstrap.length) {
        console.warn('OSMBuildings texture set: no bootstrap URL answered');
        return Promise.resolve(null);
      }
      return this.fetchJSON(`${this.bootstrap[i]}textures/${this.region}/latest.json`)
        .catch(() => null)
        .then(latest => latest || tryBootstrap(i + 1));
    };

    tryBootstrap(0).then(latest => {
      if (!latest || latest.format !== this.format) {
        if (latest) {
          console.warn(`OSMBuildings texture set: unsupported format ${latest.format}, showing T0 only`);
        }
        return;
      }
      this.release = latest.release;
      this.mirrors = this.pickMirrorOrder(latest.mirrors || []);
      return this.fetchFromMirror(latest.manifest).then(manifest => {
        if (!manifest || manifest.format !== this.format) {
          console.warn('OSMBuildings texture set: manifest missing or of another format');
          return;
        }
        this.manifest = manifest;
        this.mergeAttribution(manifest.attribution);
        this.timer = setInterval(() => this.update(), 500);
        this.update();
      });
    }).catch(err => console.warn('OSMBuildings texture set:', err.message));
  }

  // weighted random first mirror, the others as failover in their listed order
  pickMirrorOrder (mirrors) {
    if (!mirrors.length) {
      return [];
    }
    const total = mirrors.reduce((sum, m) => sum + (m.weight || 1), 0);
    let r = Math.random() * total, first = 0;
    for (let i = 0; i < mirrors.length; i++) {
      r -= (mirrors[i].weight || 1);
      if (r <= 0) {
        first = i;
        break;
      }
    }
    return mirrors.slice(first).concat(mirrors.slice(0, first));
  }

  //***************************************************************************
  // cells

  static cellOf (lon, lat, z = 16) {
    const n = Math.pow(2, z);
    const x = Math.floor((lon + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
    return [x, y];
  }

  // all cells touched by the bounding boxes of the loaded buildings
  update () {
    if (!this.manifest || !APP.features) {
      return;
    }

    let count = 0;
    const needed = {};
    APP.features.forEach(feature => {
      (feature.items || []).forEach(item => {
        count++;
        const b = item.properties && item.properties.bounds;
        if (!b) {
          return;
        }
        const [x0, y0] = Texset.cellOf(b.min[0], b.max[1]); // north-west corner
        const [x1, y1] = Texset.cellOf(b.max[0], b.min[1]); // south-east corner
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            needed[`${x},${y}`] = [x, y];
          }
        }
      });
    });

    for (let key in needed) {
      if (this.cells[key] === undefined) {
        this.loadCell(...needed[key]);
      }
    }

    if (count !== this.featureCount) {
      this.featureCount = count;
      this.dirty = true;
    }

    if (this.dirty) {
      this.dirty = false;
      this.rebuild();
    }
  }

  loadCell (x, y) {
    const key = `${x},${y}`;
    this.cells[key] = 'loading';
    this.fetchFromMirror(`${this.release}/cells/16/${x}/${y}.json`).then(cell => {
      if (cell && cell.format !== this.format) {
        cell = null; // other format: T0 only
      }
      this.cells[key] = cell;
      if (cell) {
        this.mergeAttribution(cell.attribution, `${this.mirrors[this.mirrorIndex].url}textures/${this.region}/${this.release}/credits/16/${x}/${y}.html`);
        this.dirty = true;
      }
    }).catch(err => {
      this.cells[key] = null;
      console.warn('OSMBuildings texture set:', err.message);
    });
  }

  //***************************************************************************
  // pages (web derivative)

  loadPage (page) {
    const web = page.web;
    if (!web || this.pages[web.file]) {
      return;
    }
    const entry = this.pages[web.file] = { texture: null, ready: false };

    this.fetchFromMirror(`${this.release}/${web.file}`, 'binary').then(buffer => {
      if (!buffer) {
        return;
      }
      const check = (web.sha256 && window.crypto && crypto.subtle) ?
        crypto.subtle.digest('SHA-256', buffer).then(hash => {
          const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
          if (hex !== web.sha256) {
            throw new Error(`sha256 mismatch for ${web.file}`);
          }
        }) : Promise.resolve();

      return check.then(() => {
        const url = URL.createObjectURL(new Blob([buffer], { type: 'image/webp' }));
        const image = new Image();
        image.onload = () => {
          const texture = new GLX.texture.Image();
          texture.set(image); // no flipY: v = 0 is the top row of the page
          GL.bindTexture(GL.TEXTURE_2D, texture.id);
          GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.CLAMP_TO_EDGE);
          GL.texParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_T, GL.CLAMP_TO_EDGE);
          GL.bindTexture(GL.TEXTURE_2D, null);
          URL.revokeObjectURL(url);
          entry.texture = texture;
          entry.ready = true;
          this.onChange();
        };
        image.src = url;
      });
    }).catch(err => console.warn('OSMBuildings texture set:', err.message));
  }

  //***************************************************************************
  // matching and geometry

  // building walls of all loaded features: [lonA, latA, lonB, latB, side, base, top]
  collectClientEdges () {
    const edges = [];
    APP.features.forEach(feature => {
      (feature.items || []).forEach(item => {
        (item.walls || []).forEach(w => edges.push(w));
      });
    });
    return edges;
  }

  rebuild () {
    this.surfaces.forEach(s => s.destroy());
    this.surfaces = [];

    const clientEdges = this.collectClientEdges();
    const seen = {};

    for (let key in this.cells) {
      const cell = this.cells[key];
      if (!cell || cell === 'loading') {
        continue;
      }
      cell.objects.forEach(object => {
        object.surfaces.forEach(surface => {
          if (seen[surface.key]) {
            return; // listed once per release, but cells may overlap during updates
          }
          const page = cell.pages[surface.page];
          let drawable = null;
          if (surface.edge) {
            drawable = this.buildWall(surface, page, clientEdges);
          } else if (surface.plane && /:face$/.test(surface.key)) {
            drawable = this.buildNodeFace(surface, page);
          } // roofs and others: conformance level 2, not implemented -> T0
          if (drawable) {
            seen[surface.key] = true;
            this.surfaces.push(drawable);
            this.loadPage(page);
          }
        });
      });
    }
    this.onChange();
  }

  findEdge (surface, clientEdges) {
    const [lonA, latA, lonB, latB] = surface.edge;
    const mLon = METERS_PER_DEGREE_LATITUDE * Math.cos(latA / 180 * Math.PI);
    const dist = (lon1, lat1, lon2, lat2) => Math.hypot((lon1 - lon2) * mLon, (lat1 - lat2) * METERS_PER_DEGREE_LATITUDE);
    const tol = this.tolerance;
    for (let i = 0; i < clientEdges.length; i++) {
      const e = clientEdges[i];
      if (dist(e[0], e[1], lonA, latA) <= tol && dist(e[2], e[3], lonB, latB) <= tol) {
        return { a: [e[0], e[1]], b: [e[2], e[3]], side: e[4], base: e[5], top: e[6] };
      }
      if (dist(e[2], e[3], lonA, latA) <= tol && dist(e[0], e[1], lonB, latB) <= tol) {
        // reversed: keep the stored direction a -> b; the outer side flips with the direction
        return { a: [e[2], e[3]], b: [e[0], e[1]], side: -e[4], base: e[5], top: e[6] };
      }
    }
    return null;
  }

  // wall frame: u from a to b in metres, v up from the wall base; texture on the outer face
  buildWall (surface, page, clientEdges) {
    const match = this.findEdge(surface, clientEdges);
    if (!match) {
      return null;
    }
    const anchor = match.a;
    const mLon = METERS_PER_DEGREE_LATITUDE * Math.cos(anchor[1] / 180 * Math.PI);
    // local east/north metres of b relative to a
    const be = (match.b[0] - anchor[0]) * mLon, bn = (match.b[1] - anchor[1]) * METERS_PER_DEGREE_LATITUDE;
    const len = Math.hypot(be, bn);
    if (len < 0.01) {
      return null;
    }
    const d = [be / len, bn / len];
    const outward = [match.side * d[1], -match.side * d[0]]; // side +1: outer face to the right of a -> b

    const [u0, v0] = surface.origin, [w, h] = surface.size_m;
    const wallHeight = match.top !== undefined && match.top !== null ? match.top - match.base : Infinity;
    // clip the texture rectangle to the wall (0..len, 0..wallHeight)
    const s0 = Math.max(u0, 0), s1 = Math.min(u0 + w, len);
    const t0 = Math.max(v0, 0), t1 = Math.min(v0 + h, wallHeight);
    if (s1 <= s0 || t1 <= t0) {
      return null;
    }
    const uv = surface.uv;
    const pageU = s => uv[0] + (s - u0) / w * (uv[2] - uv[0]);
    const pageV = t => uv[3] - (t - v0) / h * (uv[3] - uv[1]); // page v grows downwards

    const off = this.wallOffset;
    const corner = (s, t) => {
      const e = d[0] * s + outward[0] * off, n = d[1] * s + outward[1] * off;
      return [e, -n, match.base + t]; // OSM Buildings frame: x east, y south, z up
    };
    const normal = [outward[0], -outward[1], 0];
    return new TexsetSurface(surface, page, anchor, [
      corner(s0, t0), corner(s1, t0), corner(s1, t1), corner(s0, t1)
    ], [
      [pageU(s0), pageV(t0)], [pageU(s1), pageV(t0)], [pageU(s1), pageV(t1)], [pageU(s0), pageV(t1)]
    ], normal, false);
  }

  // node face: free-standing quad from plane (origin [lon, lat, height above terrain], u, v in east-north-up)
  buildNodeFace (surface, page) {
    const p = surface.plane;
    const anchor = [p.origin[0], p.origin[1]];
    const z0 = p.origin[2];
    const [u0, v0] = surface.origin, [w, h] = surface.size_m;
    const uv = surface.uv;
    const corner = (s, t) => {
      const e = p.u[0] * s + p.v[0] * t, n = p.u[1] * s + p.v[1] * t, up = p.u[2] * s + p.v[2] * t;
      return [e, -n, z0 + up];
    };
    // front = u x v (east-north-up), converted to x east, y south, z up
    const f = [
      p.u[1] * p.v[2] - p.u[2] * p.v[1],
      p.u[2] * p.v[0] - p.u[0] * p.v[2],
      p.u[0] * p.v[1] - p.u[1] * p.v[0]
    ];
    return new TexsetSurface(surface, page, anchor, [
      corner(u0, v0), corner(u0 + w, v0), corner(u0 + w, v0 + h), corner(u0, v0 + h)
    ], [
      [uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]], [uv[0], uv[1]]
    ], [f[0], -f[1], f[2]], true);
  }

  //***************************************************************************
  // attribution: one line, one link per entry, de-duplicated by id

  mergeAttribution (entries = [], creditsUrl = null) {
    let changed = false;
    entries.forEach(entry => {
      if (!this.attribution.some(a => a.id === entry.id)) {
        this.attribution.push(entry);
        changed = true;
      }
    });
    if (creditsUrl && !this.attribution.some(a => a.url === creditsUrl)) {
      this.attribution.push({ id: `credits:${creditsUrl}`, text: 'texture credits', url: creditsUrl });
      changed = true;
    }
    if (changed) {
      this.onAttribution(this.attribution);
    }
  }

  getPage (page) {
    const entry = page && page.web && this.pages[page.web.file];
    return entry && entry.ready ? entry.texture : null;
  }

  destroy () {
    clearInterval(this.timer);
    this.surfaces.forEach(s => s.destroy());
    this.surfaces = [];
    for (let file in this.pages) {
      if (this.pages[file].texture) {
        this.pages[file].texture.destroy();
      }
    }
    this.pages = {};
  }
}

Texset.DEFAULT_BOOTSTRAP = ['https://textures.malpy.de/'];

//*****************************************************************************

class TexsetSurface {

  constructor (record, page, anchor, corners, texCoords, normal, isNodeFace) {
    this.key = record.key;
    this.page = page;
    this.anchor = anchor; // lon, lat of the local origin
    this.isNodeFace = isNodeFace;
    this.color = Qolor.parse(record.t0 && record.t0.color || '#cccccc').toArray();

    const order = [0, 1, 2, 0, 2, 3];
    const vertices = [], uvs = [], normals = [];
    order.forEach(i => {
      vertices.push(...corners[i]);
      uvs.push(...texCoords[i]);
      normals.push(...normal);
    });
    this.vertexBuffer = new GLX.Buffer(3, new Float32Array(vertices));
    this.texCoordBuffer = new GLX.Buffer(2, new Float32Array(uvs));
    this.normalBuffer = new GLX.Buffer(3, new Float32Array(normals));
  }

  getMatrix () {
    const matrix = new GLX.Matrix();
    matrix.translateBy(
      (this.anchor[0] - APP.position.longitude) * METERS_PER_DEGREE_LONGITUDE,
      (APP.position.latitude - this.anchor[1]) * METERS_PER_DEGREE_LATITUDE,
      0
    );
    return matrix;
  }

  destroy () {
    this.vertexBuffer.destroy();
    this.texCoordBuffer.destroy();
    this.normalBuffer.destroy();
  }
}
