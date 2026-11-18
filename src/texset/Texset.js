
/**
 * Client for streamed texture sets (format osm3d-texset/0.4): conformance level 1 (walls, height model, outward test,
 * attribution scope) and the wall parts of level 2 (wall chains, part walls on outlines, node faces with basis).
 *
 * Flow: bootstrap URL -> textures/<region>/latest.json -> mirror -> manifest.json -> cell index (XYZ z16)
 * -> `web` derivative of the atlas page (WebP; WebGL1 has no KTX2/Basis transcoder here).
 *
 * Matching: the GeoJSON data of OSM Buildings has no OSM node ids, so walls are matched by position: a building
 * edge matches a stored `edge` when both end points are within 0.3 m (either direction) and its outer normal is
 * within 45° of the record's `outward`; this replaces the geom_hash check. Node faces (e.g. billboards) have no object in OSM Buildings and are drawn as
 * free-standing quads from `plane` and `size_m`. Anything unmatched keeps the normal procedural look (T0).
 */
class Texset {

  constructor (options = {}) {
    this.format = 'osm3d-texset/0.4'; // exact match, no other version is read
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
    this.shownKeys = {};  // surface key -> true while drawn
    this.shownCells = {}; // cell key -> true while one of its surfaces is drawn
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
        this.updateAttribution(true);
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
    } else {
      this.updateAttribution(); // the credits link follows the cell under the view centre
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

  // building walls of all loaded features: [lonA, latA, lonB, latB, side, base, top, feature id, ring id, index in ring]
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
    this.shownKeys = {};
    this.shownCells = {};

    const clientEdges = this.collectClientEdges();
    let rings = null; // ring id -> edges in ring order, built on demand for wall chains

    for (let key in this.cells) {
      const cell = this.cells[key];
      if (!cell || cell === 'loading') {
        continue;
      }
      cell.objects.forEach(object => {
        object.surfaces.forEach(surface => {
          if (this.shownKeys[surface.key]) {
            return; // listed once per release, but cells may overlap during updates
          }
          const page = cell.pages[surface.page];
          let pieces = [];
          if (/:wall:/.test(surface.key)) {
            pieces = this.buildWall(surface, object, page, clientEdges);
          } else if (/:walls:/.test(surface.key)) {
            rings = rings || Texset.groupRings(clientEdges);
            pieces = this.buildChain(surface, object, page, rings);
          } else if (surface.plane && /:face$/.test(surface.key)) {
            pieces = [this.buildNodeFace(surface, page)];
          } // roofs and others: not implemented -> T0
          pieces = pieces.filter(Boolean);
          if (pieces.length) {
            this.shownKeys[surface.key] = true;
            this.shownCells[key] = true;
            this.surfaces.push(...pieces);
            this.loadPage(page);
          }
        });
      });
    }
    this.updateAttribution(true);
    this.onChange();
  }

  static groupRings (clientEdges) {
    const rings = {};
    clientEdges.forEach(e => {
      if (e[8] !== undefined) {
        (rings[e[8]] = rings[e[8]] || [])[e[9]] = e;
      }
    });
    return rings;
  }

  // local metres east/north of (lon, lat) relative to (lon0, lat0)
  static enu (lon0, lat0, lon, lat) {
    return [
      (lon - lon0) * METERS_PER_DEGREE_LATITUDE * Math.cos(lat0 / 180 * Math.PI),
      (lat - lat0) * METERS_PER_DEGREE_LATITUDE
    ];
  }

  static dist (lon1, lat1, lon2, lat2) {
    const [e, n] = Texset.enu(lon1, lat1, lon2, lat2);
    return Math.hypot(e, n);
  }

  // azimuth (0 = north, clockwise) of the outer normal of a directed segment whose outer face is on the right for side +1
  static outwardAzimuth (lonA, latA, lonB, latB, side) {
    const [e, n] = Texset.enu(lonA, latA, lonB, latB);
    return (Math.atan2(side * n, -side * e) * 180 / Math.PI + 360) % 360;
  }

  static angleDiff (a, b) {
    return Math.abs(((a - b) % 360 + 540) % 360 - 180);
  }

  // P1: a candidate is accepted only if its outward normal is within 45° of the record's `outward`
  outwardOk (surface, lonA, latA, lonB, latB, side) {
    return Texset.angleDiff(Texset.outwardAzimuth(lonA, latA, lonB, latB, side), surface.outward) <= Texset.OUTWARD_TOLERANCE;
  }

  static ids (surface, object) {
    return [object.osm, object.relation, surface.key.split(':')[0]].filter(Boolean).map(String);
  }

  // Position matching (both end points within the tolerance, either direction) plus the outward test, which decides
  // party walls without ids and independent of ring direction; among several survivors the same OSM object wins.
  findEdge (surface, object, clientEdges) {
    const [lonA, latA, lonB, latB] = surface.edge;
    const tol = this.tolerance;
    const ids = Texset.ids(surface, object);
    let best = null, bestScore = -1;
    for (let i = 0; i < clientEdges.length; i++) {
      const e = clientEdges[i];
      let match = null;
      if (Texset.dist(e[0], e[1], lonA, latA) <= tol && Texset.dist(e[2], e[3], lonB, latB) <= tol) {
        match = { a: [e[0], e[1]], b: [e[2], e[3]], side: e[4], base: e[5], top: e[6] };
      } else if (Texset.dist(e[2], e[3], lonA, latA) <= tol && Texset.dist(e[0], e[1], lonB, latB) <= tol) {
        // reversed: keep the stored direction a -> b; the outer side flips with the direction
        match = { a: [e[2], e[3]], b: [e[0], e[1]], side: -e[4], base: e[5], top: e[6] };
      }
      if (!match || !this.outwardOk(surface, ...match.a, ...match.b, match.side)) {
        continue;
      }
      const score = e[7] !== undefined && ids.indexOf(String(e[7])) >= 0 ? 1 : 0;
      if (score > bestScore) {
        best = match;
        bestScore = score;
      }
    }
    return best;
  }

  // P4: a part wall drawn by a client that only has the outline: the client edge that contains the part edge
  findOutlineEdge (surface, object, clientEdges) {
    const [lonA, latA, lonB, latB] = surface.edge;
    const tol = this.tolerance;
    const ids = Texset.ids(surface, object);
    let best = null, bestScore = -1;
    for (let i = 0; i < clientEdges.length; i++) {
      const e = clientEdges[i];
      const [be, bn] = Texset.enu(e[0], e[1], e[2], e[3]);
      const len = Math.hypot(be, bn);
      if (len < 0.01) {
        continue;
      }
      const d = [be / len, bn / len];
      const project = (lon, lat) => {
        const [pe, pn] = Texset.enu(e[0], e[1], lon, lat);
        return [pe * d[0] + pn * d[1], Math.abs(pe * d[1] - pn * d[0])]; // along, across
      };
      const pa = project(lonA, latA), pb = project(lonB, latB);
      if (pa[1] > tol || pb[1] > tol || Math.min(pa[0], pb[0]) < -tol || Math.max(pa[0], pb[0]) > len + tol) {
        continue;
      }
      // orient the client edge like the part edge
      const forward = pb[0] >= pa[0];
      const match = forward ?
        { a: [e[0], e[1]], b: [e[2], e[3]], side: e[4], base: e[5], top: e[6], u: pa[0] } :
        { a: [e[2], e[3]], b: [e[0], e[1]], side: -e[4], base: e[5], top: e[6], u: len - pa[0] };
      if (!this.outwardOk(surface, ...match.a, ...match.b, match.side)) {
        continue;
      }
      const score = e[7] !== undefined && ids.indexOf(String(e[7])) >= 0 ? 1 : 0;
      if (score > bestScore) {
        best = match;
        bestScore = score;
      }
    }
    return best;
  }

  // P2: v is mapped in metres from the client's own base; stretched only when the record's height is assumed
  vScale (surface, base, top) {
    const wm = surface.wall_m;
    if (surface.basis && surface.basis.height === 'assumed' && wm && wm[1] > wm[0] && top > base) {
      return (top - base) / (wm[1] - wm[0]);
    }
    return 1;
  }

  buildWall (surface, object, page, clientEdges) {
    const match = this.findEdge(surface, object, clientEdges);
    if (match) {
      return [this.buildPiece(surface, page, match, 0, 1, 0)];
    }
    if (surface.outline_key) {
      const outline = this.findOutlineEdge(surface, object, clientEdges);
      if (outline) {
        // part frame: u from the part's first node, v from the part's base (wall_m[0]) above the client's base
        return [this.buildPiece(surface, page, outline, -outline.u, 1, surface.wall_m[0] - outline.base)];
      }
    }
    return [];
  }

  // P3: wall chain = consecutive client edges of one ring from the first to the last chain node, u = arc length
  buildChain (surface, object, page, rings) {
    const chain = surface.chain;
    if (!chain || chain.length < 3) {
      return [];
    }
    const meanLat = chain.reduce((sum, p) => sum + p[1], 0) / chain.length;
    const k = Math.cos(meanLat / 180 * Math.PI) * Texset.METERS_PER_DEGREE;
    let stored = 0;
    for (let i = 1; i < chain.length; i++) {
      stored += Math.hypot((chain[i][0] - chain[i - 1][0]) * k, (chain[i][1] - chain[i - 1][1]) * Texset.METERS_PER_DEGREE);
    }
    const [first, last] = [chain[0], chain[chain.length - 1]];
    const tol = this.tolerance;
    const ids = Texset.ids(surface, object);

    let best = null, bestScore = -1;
    for (let id in rings) {
      const ring = rings[id].filter(Boolean);
      const n = ring.length;
      if (n !== rings[id].length || n < 2) {
        continue;
      }
      const near = (e, p) => Texset.dist(e[0], e[1], p[0], p[1]) <= tol; // start vertex of edge e
      for (let i0 = 0; i0 < n; i0++) {
        if (!near(ring[i0], first)) {
          continue;
        }
        for (let dir of [1, -1]) {
          // walk the ring; dir -1 uses the edges in reverse
          const run = [];
          let v = i0;
          for (let step = 0; step < n; step++) {
            const e = dir > 0 ? ring[v] : ring[(v - 1 + n) % n];
            run.push(dir > 0 ?
              { a: [e[0], e[1]], b: [e[2], e[3]], side: e[4], base: e[5], top: e[6] } :
              { a: [e[2], e[3]], b: [e[0], e[1]], side: -e[4], base: e[5], top: e[6] });
            v = (v + dir + n) % n;
            if (near(ring[v], last)) {
              break;
            }
          }
          const end = run[run.length - 1].b;
          if (Texset.dist(end[0], end[1], last[0], last[1]) > tol) {
            continue;
          }
          const lengths = run.map(m => Texset.dist(m.a[0], m.a[1], m.b[0], m.b[1]));
          const total = lengths.reduce((a, b) => a + b, 0);
          if (Math.abs(total - stored) > 0.02 * stored) {
            continue; // arc lengths differ by 2 % or more: T0
          }
          // outward test on the chord first -> last (TEXTURE_FORMAT.md, wall chains)
          if (!this.outwardOk(surface, run[0].a[0], run[0].a[1], end[0], end[1], run[0].side)) {
            continue;
          }
          const fid = ring[0][7];
          const score = fid !== undefined && ids.indexOf(String(fid)) >= 0 ? 1 : 0;
          if (score > bestScore) {
            best = { run, lengths, scale: stored / total };
            bestScore = score;
          }
        }
      }
    }
    if (!best) {
      return [];
    }
    let arc = 0;
    return best.run.map((m, i) => {
      const piece = this.buildPiece(surface, page, m, arc, best.scale, 0);
      arc += best.lengths[i] * best.scale;
      return piece;
    });
  }

  /**
   * One quad on a client edge a -> b (outer face given by side). Texture u at the edge start is uStart, u grows by
   * uPerMetre along the edge; v is metres above the record's wall base, placed at vShift above the client's base.
   * The texture rectangle (origin, size_m) is clipped to the client edge and to its wall height.
   */
  buildPiece (surface, page, match, uStart, uPerMetre, vShift) {
    const anchor = match.a;
    const [be, bn] = Texset.enu(anchor[0], anchor[1], match.b[0], match.b[1]);
    const len = Math.hypot(be, bn);
    if (len < 0.01) {
      return null;
    }
    const d = [be / len, bn / len];
    const outward = [match.side * d[1], -match.side * d[0]]; // side +1: outer face to the right of a -> b

    const [u0, v0] = surface.origin, [w, h] = surface.size_m;
    const wallHeight = match.top !== undefined && match.top !== null ? match.top - match.base : Infinity;
    const vs = this.vScale(surface, match.base, match.top);
    // clip the texture rectangle (texture metres) to the edge and the wall
    const s0 = Math.max(u0, uStart), s1 = Math.min(u0 + w, uStart + len * uPerMetre);
    const t0 = Math.max(v0, -vShift / vs), t1 = Math.min(v0 + h, (wallHeight - vShift) / vs);
    if (s1 <= s0 || t1 <= t0) {
      return null;
    }
    const uv = surface.uv;
    const pageU = s => uv[0] + (s - u0) / w * (uv[2] - uv[0]);
    const pageV = t => uv[3] - (t - v0) / h * (uv[3] - uv[1]); // page v grows downwards

    const off = this.wallOffset;
    const corner = (s, t) => {
      const x = (s - uStart) / uPerMetre;
      const e = d[0] * x + outward[0] * off, n = d[1] * x + outward[1] * off;
      return [e, -n, match.base + vShift + t * vs]; // OSM Buildings frame: x east, y south, z up
    };
    const normal = [outward[0], -outward[1], 0];
    return new TexsetSurface(surface, page, anchor, [
      corner(s0, t0), corner(s1, t0), corner(s1, t1), corner(s0, t1)
    ], [
      [pageU(s0), pageV(t0)], [pageU(s1), pageV(t0)], [pageU(s1), pageV(t1)], [pageU(s0), pageV(t1)]
    ], normal, false);
  }

  // node face: free-standing quad from plane (origin [lon, lat, height above terrain], u, v in east-north-up);
  // OSM Buildings has no own model of such objects, so the record's plane is always used (basis does not matter)
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
  // attribution: one line, one link per entry, de-duplicated by id (P7 scope)

  // manifest entries once; cell entries while a surface of that cell is shown; surface entries while one of their
  // keys is shown; one credits link: the cell under the centre of the view
  updateAttribution (force = false) {
    if (!this.manifest) {
      return;
    }
    const centre = Texset.cellOf(APP.position.longitude, APP.position.latitude);
    const centreKey = `${centre[0]},${centre[1]}`;
    if (!force && centreKey === this.centreKey) {
      return;
    }
    this.centreKey = centreKey;

    const entries = [], seen = {};
    const add = entry => {
      if (!seen[entry.id]) {
        seen[entry.id] = true;
        entries.push(entry);
      }
    };
    (this.manifest.attribution || []).forEach(add);
    for (let key in this.shownCells) {
      (this.cells[key].attribution || []).forEach(entry => {
        if (entry.scope !== 'surface' || (entry.keys || []).some(k => this.shownKeys[k])) {
          add(entry);
        }
      });
    }
    const cell = this.cells[centreKey];
    if (cell && cell !== 'loading' && this.mirrors.length) {
      add({
        id: 'texset-credits', text: 'texture credits',
        url: `${this.mirrors[this.mirrorIndex].url}textures/${this.region}/${this.release}/credits/16/${centre[0]}/${centre[1]}.html`
      });
    }
    const signature = JSON.stringify(entries.map(e => [e.id, e.url]));
    if (signature !== this.attributionSignature) {
      this.attributionSignature = signature;
      this.attribution = entries;
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
Texset.OUTWARD_TOLERANCE = 45; // degrees, TEXTURE_FORMAT.md wall rules (P1)
Texset.METERS_PER_DEGREE = 111319.49; // arc lengths of wall chains (TEXTURE_FORMAT.md)

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
