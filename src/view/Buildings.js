
View.Buildings = class {

  constructor () {
    // optional parallax occlusion mapping, see options.parallaxMapping
    this.parallaxMapping = APP.view.parallaxMapping;
    if (this.parallaxMapping && !GL.getExtension('OES_standard_derivatives')) {
      console.warn('Parallax mapping is disabled because your GPU does not support OES_standard_derivatives');
      this.parallaxMapping = null;
    }

    const pomUniforms = this.parallaxMapping ?
      ['uCameraPos', 'uHeightTexIndex', 'uPomHeightScale', 'uPomLayers', 'uPomFade'] : [];

    this.shader = !APP.view.shadowsEnabled ?
      new GLX.Shader({
        source: this.getSource(shaders.buildings),
        attributes: ['aPosition', 'aTexCoord', 'aColor', 'aNormal', 'aHeight', 'aTintColor', 'aZScale'],
        uniforms: [
          'uModelMatrix',
          'uViewDirOnMap',
          'uMatrix',
          'uNormalTransform',
          'uLightColor',
          'uLightDirection',
          'uLowerEdgePoint',
          'uFogDistance',
          'uFogBlurDistance',
          'uFade',
          'uWallTexIndex'
        ].concat(pomUniforms)
      }) : new GLX.Shader({
      source: this.getSource(shaders.buildings_with_shadows),
      attributes: ['aPosition', 'aTexCoord', 'aColor', 'aNormal', 'aHeight', 'aTintColor', 'aZScale'],
      uniforms: [
        'uFogDistance',
        'uFogBlurDistance',
        'uLightColor',
        'uLightDirection',
        'uLowerEdgePoint',
        'uMatrix',
        'uModelMatrix',
        'uSunMatrix',
        'uShadowTexIndex',
        'uShadowTexDimensions',
        'uFade',
        'uViewDirOnMap',
        'uWallTexIndex'
      ].concat(pomUniforms)
    });

    this.wallTexture = new GLX.texture.Image();
    this.wallTexture.color([1,1,1]);
    this.wallTexture.load(BUILDING_TEXTURE);

    if (this.parallaxMapping) {
      this.heightTexture = new GLX.texture.Image();
      this.heightTexture.color([1, 1, 1]); // flat until the real height map is loaded
      if (this.parallaxMapping.heightMap) {
        this.heightTexture.load(this.parallaxMapping.heightMap);
      } else {
        this.loadHeightMapFromWallTexture();
      }
    }
  }

  // returns the shader source, with the parallax mapping code switched on if needed
  getSource (source) {
    if (!this.parallaxMapping) {
      return source;
    }
    return {
      name: source.name,
      vs: '#define USE_POM\n' + source.vs,
      fs: '#define USE_POM\n' + source.fs
    };
  }

  // default height map: the brightness of the wall texture, stretched to the full range
  loadHeightMapFromWallTexture () {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('CANVAS');
      canvas.width = image.width;
      canvas.height = image.height;

      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      let min = 255, max = 0;
      for (let i = 0; i < data.length; i += 4) {
        min = Math.min(min, data[i]);
        max = Math.max(max, data[i]);
      }

      const range = Math.max(max - min, 1);
      for (let i = 0; i < data.length; i += 4) {
        const h = (data[i] - min) / range * 255;
        data[i] = data[i+1] = data[i+2] = h;
        data[i+3] = 255;
      }

      context.putImageData(imageData, 0, 0);
      this.heightTexture.set(canvas);
    };
    image.src = BUILDING_TEXTURE;
  }

  // camera position in the coordinates of the map, which are the view of a model without its own offset
  getCameraPosition () {
    const inv = GLX.Matrix.invert(APP.view.viewMatrix.data);
    const v = APP.view.cameraViewPos;
    return [
      inv[0]*v[0] + inv[4]*v[1] + inv[8]*v[2]  + inv[12],
      inv[1]*v[0] + inv[5]*v[1] + inv[9]*v[2]  + inv[13],
      inv[2]*v[0] + inv[6]*v[1] + inv[10]*v[2] + inv[14]
    ];
  }

  render (depthFramebuffer) {
    const shader = this.shader;
    shader.enable();

    // if (this.showBackfaces) {
    //   GL.disable(GL.CULL_FACE);
    // }

    shader.setParam('uFogDistance',     '1f',  APP.view.fogDistance);
    shader.setParam('uFogBlurDistance', '1f',  APP.view.fogBlurDistance);
    shader.setParam('uLightColor',      '3fv', [0.5, 0.5, 0.5]);
    shader.setParam('uLightDirection',  '3fv', View.Sun.direction);
    shader.setParam('uLowerEdgePoint',  '2fv', APP.view.lowerLeftOnMap);
    shader.setParam('uViewDirOnMap',    '2fv', APP.view.viewDirOnMap);

    if (!APP.view.shadowsEnabled) {
      const matrix3 = new Float32Array([
        1, 0, 0,
        0, 1, 0,
        0, 0, 1
      ]);

      shader.setMatrix('uNormalTransform', '3fv', matrix3);
    }

    shader.setTexture('uWallTexIndex', 0, this.wallTexture);

    let cameraPosition;
    if (this.parallaxMapping) {
      const pm = this.parallaxMapping;
      shader.setParam('uPomHeightScale', '1f',  pm.heightScale);
      shader.setParam('uPomLayers',      '1f',  pm.layers);
      shader.setParam('uPomFade',        '2fv', [pm.fadeStart, pm.fadeEnd]);
      shader.setTexture('uHeightTexIndex', 2, this.heightTexture);
      cameraPosition = this.getCameraPosition();
    }

    if (depthFramebuffer) {
      shader.setParam('uShadowTexDimensions', '2fv', [depthFramebuffer.width, depthFramebuffer.height]);
      shader.setTexture('uShadowTexIndex', 1, depthFramebuffer.depthTexture);
    }

    APP.features.forEach(item => {
      // no visibility check needed, Grid.purge() is taking care
      // TODO: but not for individual features

      if (APP.zoom < item.minZoom || APP.zoom > item.maxZoom) {
        return;
      }

      const modelMatrix = item.getMatrix();

      if (!modelMatrix) {
        return;
      }

      shader.setParam('uFade', '1f', item.getFade());

      if (cameraPosition) {
        // vertices are relative to the feature, which is only translated by its model matrix
        shader.setParam('uCameraPos', '3fv', [
          cameraPosition[0] - modelMatrix.data[12],
          cameraPosition[1] - modelMatrix.data[13],
          cameraPosition[2] - modelMatrix.data[14]
        ]);
      }

      shader.setMatrix('uModelMatrix', '4fv', modelMatrix.data);
      shader.setMatrix('uMatrix',      '4fv', GLX.Matrix.multiply(modelMatrix, APP.view.viewProjMatrix));

      if (APP.view.shadowsEnabled) {
        shader.setMatrix('uSunMatrix', '4fv', GLX.Matrix.multiply(modelMatrix, View.Sun.viewProjMatrix));
      }

      shader.setBuffer('aPosition', item.vertexBuffer);
      shader.setBuffer('aTexCoord', item.texCoordBuffer);
      shader.setBuffer('aNormal', item.normalBuffer);
      shader.setBuffer('aColor', item.colorBuffer);
      shader.setBuffer('aHeight', item.heightBuffer);
      shader.setBuffer('aTintColor', item.tintBuffer);
      shader.setBuffer('aZScale', item.zScaleBuffer);

      GL.drawArrays(GL.TRIANGLES, 0, item.vertexBuffer.numItems);
    });


    // if (this.showBackfaces) {
    //   GL.enable(GL.CULL_FACE);
    // }

    shader.disable();
  }

  destroy () {
    if (this.heightTexture) {
      this.heightTexture.destroy();
    }
  }
};