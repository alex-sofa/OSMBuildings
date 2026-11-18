View.Texset = class {

  constructor () {
    this.shader = new GLX.Shader({
      source: shaders.texset,
      attributes: ['aPosition', 'aTexCoord', 'aNormal'],
      uniforms: ['uMatrix', 'uModelMatrix', 'uTexIndex', 'uUseTexture', 'uBackMode', 'uColor', 'uCameraPos',
        'uFogDistance', 'uFogBlurDistance', 'uLowerEdgePoint', 'uViewDirOnMap']
    });
  }

  render () {
    const texset = APP.texset;
    if (!texset || !texset.surfaces.length) {
      return;
    }

    const shader = this.shader;
    shader.enable();

    // camera position in world coordinates (inverse view matrix applied to the origin)
    const inv = GLX.Matrix.invert(APP.view.viewMatrix.data);
    const cameraPos = inv ? [inv[12] / inv[15], inv[13] / inv[15], inv[14] / inv[15]] : [0, 0, 1e6];

    shader.setParam('uFogDistance', '1f', APP.view.fogDistance);
    shader.setParam('uFogBlurDistance', '1f', APP.view.fogBlurDistance);
    shader.setParam('uLowerEdgePoint', '2fv', APP.view.lowerLeftOnMap);
    shader.setParam('uViewDirOnMap', '2fv', APP.view.viewDirOnMap);
    shader.setParam('uCameraPos', '3fv', cameraPos);

    const cullFace = GL.isEnabled(GL.CULL_FACE);
    GL.disable(GL.CULL_FACE); // front/back is decided in the fragment shader
    GL.enable(GL.POLYGON_OFFSET_FILL);
    GL.polygonOffset(-1, -1);

    texset.surfaces.forEach(surface => {
      const modelMatrix = surface.getMatrix();
      shader.setMatrix('uModelMatrix', '4fv', modelMatrix.data);
      shader.setMatrix('uMatrix', '4fv', GLX.Matrix.multiply(modelMatrix, APP.view.viewProjMatrix));

      const texture = texset.getPage(surface.page);
      shader.setParam('uUseTexture', '1f', texture ? 1 : 0);
      shader.setParam('uBackMode', '1f', surface.isNodeFace ? 1 : 0);
      shader.setParam('uColor', '3fv', surface.color);
      if (texture) {
        shader.setTexture('uTexIndex', 0, texture);
      }

      shader.setBuffer('aPosition', surface.vertexBuffer);
      shader.setBuffer('aTexCoord', surface.texCoordBuffer);
      shader.setBuffer('aNormal', surface.normalBuffer);
      GL.drawArrays(GL.TRIANGLES, 0, surface.vertexBuffer.numItems);
    });

    GL.disable(GL.POLYGON_OFFSET_FILL);
    if (cullFace) {
      GL.enable(GL.CULL_FACE);
    }
    shader.disable();
  }

  destroy () {}
};
