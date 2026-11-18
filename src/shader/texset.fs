#ifdef GL_ES
  precision mediump float;
#endif

// front side (normal towards the camera): page texture, or the T0 colour while the page is not loaded;
// back side: discarded for walls, T0 colour for free-standing node faces

uniform sampler2D uTexIndex;
uniform float uUseTexture;
uniform float uBackMode;
uniform vec3 uColor;
uniform vec3 uCameraPos;

uniform float uFogDistance;
uniform float uFogBlurDistance;

varying vec2 vTexCoord;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float verticalDistanceToLowerEdge;

void main() {
  bool front = dot(vNormal, uCameraPos - vWorldPos) > 0.0;
  vec3 color = uColor;

  if (!front) {
    if (uBackMode < 0.5) {
      discard;
    }
    color = uColor * 0.8;
  } else if (uUseTexture > 0.5) {
    vec4 texel = texture2D(uTexIndex, vTexCoord); // no flip: v = 0 is the top row of the page
    if (texel.a < 0.5) {
      discard; // straight alpha used as cut-out
    }
    color = texel.rgb;
  }

  float fogIntensity = clamp((verticalDistanceToLowerEdge - uFogDistance) / uFogBlurDistance, 0.0, 1.0);
  gl_FragColor = vec4(color, 1.0 - fogIntensity);
}
