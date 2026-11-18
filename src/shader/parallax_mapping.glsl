// Parallax occlusion mapping for building walls. Included into the fragment shaders
// with '#include "parallax_mapping"' and only active if USE_POM is defined.
//
// Needs the extension OES_standard_derivatives, the varying vModelPos (position in model space),
// and the uniforms below. All distances are in meters.

#ifdef USE_POM

// positions in model space need more than half precision
#ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
#endif

varying vec3 vModelPos;

uniform vec3 uCameraPos;              // camera position in model space
uniform sampler2D uHeightTexIndex;    // height field, 1.0 = wall surface, 0.0 = deepest point
uniform float uPomHeightScale;        // depth of the relief
uniform float uPomLayers;             // number of ray marching steps, <= POM_MAX_LAYERS
uniform vec2 uPomFade;                // camera distance where the effect starts / ends to fade out

const int POM_MAX_LAYERS = 32;

// Returns the texture coordinates where the view ray meets the height field.
//
// The wall is treated as a plane. The ray enters it at 'texCoord' and moves down in equally spaced layers
// until it is below the height field, then the hit is placed between the last two samples by linear interpolation.
//
// There is no early exit and no early return, because texture sampling and derivatives
// must stay in uniform control flow in GLSL ES 1.00.
vec2 parallaxTexCoord(vec2 texCoord) {

  vec3 toCamera = uCameraPos - vModelPos;
  float dist = length(toCamera);
  vec3 viewDir = toCamera / dist;

  // change of position and texture coordinates per screen pixel
  vec3 dpx = dFdx(vModelPos);
  vec3 dpy = dFdy(vModelPos);
  vec2 dtx = dFdx(texCoord);
  vec2 dty = dFdy(texCoord);

  vec3 n = cross(dpx, dpy);
  float nn = max(dot(n, n), 1e-12);
  float cosView = abs(dot(n, viewDir)) / sqrt(nn);

  // gradients of u and v over the wall plane (texture units per meter),
  // chosen so that dot(gradient, dp) reproduces the observed change of the texture coordinate
  vec3 gradU = (dtx.x * cross(dpy, n) + dty.x * cross(n, dpx)) / nn;
  vec3 gradV = (dtx.y * cross(dpy, n) + dty.y * cross(n, dpx)) / nn;

  // fade to plain texturing with distance, a relief of depth 0 does not shift anything
  float fade = 1.0 - smoothstep(uPomFade.x, max(uPomFade.y, uPomFade.x + 0.001), dist);
  float depth = uPomHeightScale * fade;

  // shift of the texture coordinates when the ray has gone down by the full relief depth
  vec2 fullShift = -vec2(dot(gradU, viewDir), dot(gradV, viewDir)) / max(cosView, 0.1) * depth;

  vec2 result = texCoord + fullShift;
  float found = 0.0;

  vec2 previousCoord = texCoord;
  float previousRay = 0.0;
  float previousSurface = 1.0 - texture2D(uHeightTexIndex, texCoord).r;

  for (int i = 0; i < POM_MAX_LAYERS; i++) {
    if (float(i) < uPomLayers) {
      float ray = float(i + 1) / uPomLayers;
      vec2 coord = texCoord + fullShift * ray;
      float surface = 1.0 - texture2D(uHeightTexIndex, coord).r;

      // first layer where the ray is below the surface
      float hit = (1.0 - found) * step(surface, ray);

      float above = previousSurface - previousRay;  // distance to the surface before the step
      float below = ray - surface;                  // distance below the surface after the step
      float t = clamp(above / max(above + below, 1e-5), 0.0, 1.0);

      result = mix(result, mix(previousCoord, coord, t), hit);
      found = max(found, hit);

      previousCoord = coord;
      previousRay = ray;
      previousSurface = surface;
    }
  }

  return result;
}

#endif
