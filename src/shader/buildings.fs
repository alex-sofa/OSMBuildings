#ifdef USE_POM
  #extension GL_OES_standard_derivatives : enable
#endif

#ifdef GL_ES
  precision mediump float;
#endif

varying vec3 vColor;
varying vec2 vTexCoord;
varying float verticalDistanceToLowerEdge;

uniform vec3 uFogColor;
uniform float uFogDistance;
uniform float uFogBlurDistance;
uniform sampler2D uWallTexIndex;

#include "parallax_mapping"

void main() {
    
  float fogIntensity = (verticalDistanceToLowerEdge - uFogDistance) / uFogBlurDistance;
  fogIntensity = clamp(fogIntensity, 0.0, 1.0);

  vec2 texCoord = vTexCoord;
#ifdef USE_POM
  texCoord = parallaxTexCoord(vTexCoord);
#endif

  gl_FragColor = vec4(vColor * texture2D(uWallTexIndex, texCoord).rgb, 1.0-fogIntensity);
}
