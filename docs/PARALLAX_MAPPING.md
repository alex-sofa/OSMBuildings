# Parallax occlusion mapping (optional)

Parallax occlusion mapping (POM) makes the wall texture of buildings look like a relief (e.g. recessed windows)
without adding geometry. It is **off by default**. Without the option, the shaders and the rendering are unchanged.

## Enabling it

Pass `parallaxMapping` to the constructor. `true` uses the defaults:

```js
const osmb = new OSMBuildings({
  container: 'map',
  parallaxMapping: {
    heightScale: 0.3,  // depth of the relief in meters
    layers: 16,        // ray marching steps per pixel, 2 to 32
    fadeStart: 200,    // camera distance in meters where the effect starts to fade out
    fadeEnd: 400,      // camera distance in meters beyond which plain texturing is used
    heightMap: '...'   // optional, URL of a height map for the wall texture
  }
});
```

The option cannot be changed later, because it selects a different shader variant at start.
If the GPU does not offer the WebGL extension `OES_standard_derivatives`, a warning is logged and POM is disabled.

## Height data

The height map uses the same texture coordinates as the wall texture. White (1.0) is the wall surface, black (0.0) is
`heightScale` meters below it. Only the red channel is read. WebGL 1 requires power-of-two dimensions for a repeating,
mipmapped texture. Without `heightMap`, the height is taken from the brightness of the built-in wall texture, stretched to the
full range, so the darker window areas are recessed.

Note that wall textures are only applied to buildings with a `levels` property (or with `material: 'glass'`),
so POM is only visible on those.

## How it works

- `src/shader/parallax_mapping.glsl` holds the function `parallaxTexCoord`, which both fragment shaders include
  (`#include` is resolved by `build.js`). It marches the view ray through the height field in equally spaced layers and then
  interpolates linearly between the last two samples.
- The mapping between wall plane and texture space comes from screen space derivatives of the model space position
  and the texture coordinates, so no tangent attribute or per-vertex data is needed.
- `View.Buildings` compiles the shaders with `#define USE_POM`, loads the height texture, and passes the camera position in model
  space (`View.cameraViewPos` is the camera in view space, because the projection shifts the geometry).
- The effect fades out with distance by shrinking the relief depth to zero.

## Limitations

- Only wall textures of buildings are affected, not roofs, markers or the base map.
- No self shadowing, and no clipping at the edges of the wall (silhouettes stay straight).
- All buildings share one height map. The number of layers is the same for every pixel (GLSL ES 1.00 needs uniform control flow
  for texture sampling), so the cost is `layers` extra texture reads per wall pixel, until it fades out.
- Lighting is not changed by the relief.
