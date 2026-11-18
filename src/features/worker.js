
// const EARTH_RADIUS_IN_METERS = 6378137;
// const EARTH_CIRCUMFERENCE_IN_METERS = EARTH_RADIUS_IN_METERS * Math.PI * 2;
// const METERS_PER_DEGREE_LATITUDE = EARTH_CIRCUMFERENCE_IN_METERS / 360;
const METERS_PER_DEGREE_LATITUDE = 6378137 * Math.PI / 180;

//*****************************************************************************

function getOrigin (geometry) {
  const coordinates = geometry.coordinates;
  switch (geometry.type) {
    case 'Point':
      return coordinates;

    case 'MultiPoint':
    case 'LineString':
      return coordinates[0];

    case 'MultiLineString':
    case 'Polygon':
      return coordinates[0][0];

    case 'MultiPolygon':
      return coordinates[0][0][0];
  }
}

// Wall edges for texture sets (src/texset/Texset.js): [lonA, latA, lonB, latB, side, base, top, id] per edge of every ring.
// side = +1 when the outer face lies to the right of A -> B, -1 when it lies to the left. The outer face of an outer ring
// faces away from the polygon, the one of an inner ring faces into the courtyard (away from the building solid).
function getWallEdges (geometry, properties, id) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] :
    geometry.type === 'MultiPolygon' ? geometry.coordinates : [];

  const levelHeight = 3; // METERS_PER_LEVEL of the triangulation
  const base = properties.minHeight || (properties.minLevel ? properties.minLevel * levelHeight : 0);
  // same rules as the wall height of the triangulation (src/triangulate/index.js)
  let roofHeight = properties.roofHeight || (properties.roofLevels ? properties.roofLevels * levelHeight : 0);
  switch (properties.roofShape) {
    case 'gabled': case 'hipped': case 'half-hipped': case 'skillion': case 'gambrel': case 'mansard': case 'round':
      roofHeight = roofHeight || levelHeight;
      break;
    case 'cone': case 'pyramid': case 'dome': case 'onion':
      break; // depends on the radius; not needed for walls of other shapes
    default:
      roofHeight = 0;
  }
  let top = 10; // DEFAULT_HEIGHT of the triangulation
  if (properties.height !== undefined) {
    top = properties.height - Math.min(roofHeight, properties.height);
  } else if (properties.levels !== undefined) {
    top = properties.levels * levelHeight;
  }

  const edges = [];
  polygons.forEach(rings => {
    rings.forEach((ring, ringIndex) => {
      let area = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      }
      const ccw = area > 0;
      const side = (ringIndex === 0) === ccw ? 1 : -1;
      for (let i = 0; i < ring.length - 1; i++) {
        edges.push([ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1], side, base, top, id]);
      }
    });
  });
  return edges;
}

function getPickingColor (i) {
  i++;
  return [0, (i & 0xff) / 255, ((i >> 8) & 0xff) / 255];
}

//*****************************************************************************

onmessage = function(e) {
  const params = e.data;

  if (params.type === 'GeoJSON') {
    loadGeoJSON(params.url, params.options);
  }

  if (params.type === 'OBJ') {
    loadOBJ(params.url, params.options);
  }
};

function postResult(items, position, tri) {
  const res = {
    items: items,
    position: position,
    vertices: new Float32Array(tri.vertices),
    normals: new Float32Array(tri.normals),
    colors: new Float32Array(tri.colors),
    texCoords: new Float32Array(tri.texCoords),
    heights: new Float32Array(tri.heights),
    pickingColors: new Float32Array(tri.pickingColors)
  };

  postMessage(res, [
    res.vertices.buffer,
    res.normals.buffer,
    res.colors.buffer,
    res.texCoords.buffer,
    res.heights.buffer,
    res.pickingColors.buffer
  ]);
}

//*****************************************************************************

function loadGeoJSON (url, options = {}) {
  if (typeof url === 'object') {
    postMessage('load');
    processGeoJSON(url, options);
  } else {
    Request.getJSON(url, (err, geojson) => {
      if (err) {
        postMessage('error');
      } else {
        postMessage('load');
        processGeoJSON(geojson, options);
      }
    });
  }
}

function processGeoJSON (geojson, options) {
  if (!geojson || !geojson.features.length) {
    postMessage('error'); // TODO: not really an error
    return;
  }

  const tri = {
    vertices: [],
    normals: [],
    colors: [],
    texCoords: [],
    heights: [],
    pickingColors: []
  };

  const
    items = [],
    origin = getOrigin(geojson.features[0].geometry),
    position = { latitude: origin[1], longitude: origin[0] };

  geojson.features.forEach((feature, index) => {
    // APP.events.emit('loadfeature', feature); // TODO

    const
      properties = feature.properties,
      id = options.id || feature.id,
      pickingColor = getPickingColor(index); // picks per part id - could perhaps use building id

    const walls = getWallEdges(feature.geometry, properties, id); // before triangulation, which may change the geometry

    let vertexCount = tri.vertices.length;
    triangulate(tri, feature, origin);
    vertexCount = (tri.vertices.length - vertexCount) / 3;

    for (let i = 0; i < vertexCount; i++) {
      tri.heights.push(properties.height);
      tri.pickingColors.push(...pickingColor);
    }

    properties.bounds = getGeoJSONBounds(feature.geometry);
    items.push({ id: id, properties: properties, vertexCount: vertexCount, walls: walls });
  });

  postResult(items, position, tri);
}

//*****************************************************************************

function loadOBJ (url, options = {}) {
  Request.getText(url, (err, obj) => {
    if (err) {
      postMessage('error');
      return;
    }

    let match = obj.match(/^mtllib\s+(.*)$/m);
    if (!match) {
      postMessage('load');
      processOBJ(obj, null, options);
    } else {
      Request.getText(url.replace(/[^\/]+$/, '') + match[1], (err, mtl) => {
        if (err) {
          postMessage('error');
        } else {
          postMessage('load');
          processOBJ(obj, mtl, options);
        }
      });
    }
  });
}

function processOBJ(obj, mtl, options = {}) {
  const tri = {
    vertices: [],
    normals: [],
    colors: [],
    texCoords: [],
    heights: [],
    pickingColors: []
  };

  const
    items = [],
    optionColor = Qolor.parse(options.color).toArray(),
    position = options.position;

  const meshes = OBJ.parse(obj, mtl, options.flipYZ);

  meshes.forEach((mesh, index) => {
    // APP.events.emit('loadfeature', mesh); // TODO

    tri.vertices.push(...mesh.vertices);
    tri.normals.push(...mesh.normals);
    tri.texCoords.push(...mesh.texCoords);

    const
      id = options.id || mesh.id,
      properties = {},
      colorVariance = (id / 2 % 2 ? -1 : +1) * (id % 2 ? 0.03 : 0.06),
      color = optionColor || mesh.color || DEFAULT_COLOR,
      vertexCount = mesh.vertices.length / 3,
      pickingColor = getPickingColor(index);

    for (let i = 0; i < vertexCount; i++) {
      tri.colors.push(color[0]+colorVariance, color[1]+colorVariance, color[2]+colorVariance);
      tri.heights.push(mesh.height);
      tri.pickingColors.push(...pickingColor);
    }

    properties.height = mesh.height;
    properties.color = mesh.color;
    properties.bounds = getOBJBounds(mesh.vertices);

    items.push({ id: id, properties: properties, vertexCount: vertexCount });
  });

  postResult(items, position, tri);
}
