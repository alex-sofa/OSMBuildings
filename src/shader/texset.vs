precision highp float;

// textured surfaces from a texture set (walls, node faces); see src/texset/Texset.js

attribute vec4 aPosition;
attribute vec2 aTexCoord;
attribute vec3 aNormal;

uniform mat4 uMatrix;
uniform mat4 uModelMatrix;

uniform vec2 uViewDirOnMap;
uniform vec2 uLowerEdgePoint;

varying vec2 vTexCoord;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float verticalDistanceToLowerEdge;

void main() {
  gl_Position = uMatrix * aPosition;
  vTexCoord = aTexCoord;
  vNormal = aNormal;

  vec4 worldPos = uModelMatrix * aPosition;
  vWorldPos = worldPos.xyz / worldPos.w;
  vec2 dirFromLowerEdge = vWorldPos.xy - uLowerEdgePoint;
  verticalDistanceToLowerEdge = dot(dirFromLowerEdge, uViewDirOnMap);
}
