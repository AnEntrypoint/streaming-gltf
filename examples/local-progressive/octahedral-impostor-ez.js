// Octahedral impostor (lit, sprite-blended) — vendored + localized from
// @three.ez/octahedron-imposter (https://github.com/agargaro/octahedral-impostor),
// MIT License, (c) Andrea Gargaro. Ported TS -> JS, GLSL inlined, the
// full-octahedron encode/decode `// TODO` filled in (inverse of octaGridToDir),
// and the dev-only PNG export util dropped. Runtime dep: three only.
//
// vs the prior bespoke billboard impostor this captures a 2-target atlas
// (albedo + packed normal/depth), blends the 3 nearest octahedral sprites with
// per-sprite plane-projected UVs, and reconstructs normals so the impostor is
// LIT by the scene (baseType is a real MeshStandardMaterial).

import {
  GLSL3, LinearFilter, LinearMipmapLinearFilter, LinearSRGBColorSpace, Matrix4,
  Mesh, MeshStandardMaterial, NearestFilter, NearestMipMapNearestFilter,
  ObjectSpaceNormalMap, OrthographicCamera, PlaneGeometry, ShaderMaterial,
  Sphere, TangentSpaceNormalMap, UnsignedByteType, Vector2, Vector3, Vector4,
  WebGLRenderTarget,
} from 'three';

// ----------------------------------------------------------------- GLSL ----
// Atlas capture pass (MRT): albedo + packed normal/depth. Merged basic/normal/
// depth material, GLSL3.
const ATLAS_VERTEX = /* glsl */`
#define NORMAL
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
  varying vec3 vViewPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <normal_pars_vertex>
#include <color_pars_vertex>
varying vec2 vHighPrecisionZW;

void main() {
  #include <uv_vertex>
  #include <color_vertex>
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <normal_vertex>
  #include <begin_vertex>
  #include <displacementmap_vertex>
  #include <project_vertex>

  vHighPrecisionZW = gl_Position.zw;

#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
  vViewPosition = - mvPosition.xyz;
#endif
}`;

const ATLAS_FRAGMENT = /* glsl */`
#define NORMAL
uniform vec3 diffuse;
uniform float opacity;
#if defined( FLAT_SHADED ) || defined( USE_BUMPMAP ) || defined( USE_NORMALMAP_TANGENTSPACE )
  varying vec3 vViewPosition;
#endif
#include <packing>
#include <normal_pars_fragment>
#include <bumpmap_pars_fragment>
#include <normalmap_pars_fragment>
#include <common>
#include <color_pars_fragment>
#include <uv_pars_fragment>
#include <map_pars_fragment>
#include <alphamap_pars_fragment>
#include <alphatest_pars_fragment>
#include <alphahash_pars_fragment>
varying vec2 vHighPrecisionZW;

layout(location = 0) out vec4 gAlbedo;
layout(location = 1) out vec4 gNormalDepth;

void main() {
  vec4 diffuseColor = vec4( diffuse, opacity );
  #include <map_fragment>
  #include <color_fragment>
  #include <alphamap_fragment>
  #include <alphatest_fragment>
  #include <alphahash_fragment>

  if (diffuseColor.a <= 0.2) {
    discard;
  }

  #ifdef OPAQUE
    diffuseColor.a = 1.0;
  #endif
  #ifdef USE_TRANSMISSION
    diffuseColor.a *= material.transmissionAlpha;
  #endif
  gAlbedo = diffuseColor;
  gAlbedo = linearToOutputTexel( gAlbedo );
  #ifdef PREMULTIPLIED_ALPHA
    gAlbedo.rgb *= gAlbedo.a;
  #endif

  #include <normal_fragment_begin>
  #include <normal_fragment_maps>

  float fragCoordZ = 0.5 * vHighPrecisionZW[ 0 ] / vHighPrecisionZW[ 1 ] + 0.5;
  gNormalDepth = vec4( packNormalToRGB( normal ), 1.0 - fragCoordZ );
}`;

// Impostor runtime chunks (patched into MeshStandardMaterial). The
// encode/decode functions implement BOTH hemi- and full-octahedron (the
// upstream full path was a TODO; filled here as the exact inverse of the JS
// octaGridToDir used by the atlas baker, so bake and render agree).
const IMPOSTOR_PARAMS_VERTEX = /* glsl */`
#include <clipping_planes_pars_vertex>

uniform mat4 impostorTransform;
uniform float spritesPerSide;

flat varying vec4 vSpritesWeight;
flat varying vec2 vSprite1;
flat varying vec2 vSprite2;
flat varying vec2 vSprite3;
varying vec2 vSpriteUV1;
varying vec2 vSpriteUV2;
varying vec2 vSpriteUV3;

vec2 encodeDirection(vec3 direction) {
  #ifdef EZ_USE_HEMI_OCTAHEDRON
  vec3 octahedron = direction / dot(direction, sign(direction));
  return vec2(1.0 + octahedron.x + octahedron.z, 1.0 + octahedron.z - octahedron.x) * 0.5;
  #else
  // Full octahedron: inverse of octaGridToDir (y up). Normalize to the L1
  // octahedron, fold the lower hemisphere, map square [-1,1] -> grid [0,1].
  vec3 o = direction / (abs(direction.x) + abs(direction.y) + abs(direction.z));
  float ox = o.x;
  float oz = o.z;
  if (o.y < 0.0) {
    ox = (o.x >= 0.0 ? 1.0 : -1.0) * (1.0 - abs(o.z));
    oz = (o.z >= 0.0 ? 1.0 : -1.0) * (1.0 - abs(o.x));
  }
  return vec2(ox * 0.5 + 0.5, oz * 0.5 + 0.5);
  #endif
}

vec3 decodeDirection(vec2 gridIndex, vec2 spriteCountMinusOne) {
  vec2 gridUV = gridIndex / spriteCountMinusOne;

  #ifdef EZ_USE_HEMI_OCTAHEDRON
  vec3 position = vec3(gridUV.x - gridUV.y, 0.0, -1.0 + gridUV.x + gridUV.y);
  position.y = 1.0 - abs(position.x) - abs(position.z);
  #else
  vec3 position = vec3(2.0 * (gridUV.x - 0.5), 0.0, 2.0 * (gridUV.y - 0.5));
  float ax = abs(position.x);
  float az = abs(position.z);
  position.y = 1.0 - ax - az;
  if (position.y < 0.0) {
    position.x = (position.x >= 0.0 ? 1.0 : -1.0) * (1.0 - az);
    position.z = (position.z >= 0.0 ? 1.0 : -1.0) * (1.0 - ax);
  }
  #endif

  return normalize(position);
}

void computePlaneBasis(vec3 normal, out vec3 tangent, out vec3 bitangent) {
  vec3 up = vec3(0.0, 1.0, 0.0);
  if(normal.y > 0.999)
    up = vec3(-1.0, 0.0, 0.0);
  #ifndef EZ_USE_HEMI_OCTAHEDRON
  if(normal.y < -0.999)
    up = vec3(1.0, 0.0, 0.0);
  #endif
  tangent = normalize(cross(up, normal));
  bitangent = cross(normal, tangent);
}

vec3 projectVertex(vec3 normal) {
  vec3 x, y;
  computePlaneBasis(normal, x, y);
  return x * position.x + y * position.y;
}

void computeSpritesWeight(vec2 gridFract) {
  vSpritesWeight = vec4(min(1.0 - gridFract.x, 1.0 - gridFract.y), abs(gridFract.x - gridFract.y), min(gridFract.x, gridFract.y), ceil(gridFract.x - gridFract.y));
}

vec2 projectToPlaneUV(vec3 normal, vec3 tangent, vec3 bitangent, vec3 cameraPosition, vec3 viewDir) {
  float denom = dot(viewDir, normal);
  float t = -dot(cameraPosition, normal) / denom;
  vec3 hit = cameraPosition + viewDir * t;
  vec2 uv = vec2(dot(tangent, hit), dot(bitangent, hit));
  return uv + 0.5;
}

vec3 projectDirectionToBasis(vec3 dir, vec3 normal, vec3 tangent, vec3 bitangent) {
  return vec3(dot(dir, tangent), dot(dir, bitangent), dot(dir, normal));
}
`;

const IMPOSTOR_VERTEX = /* glsl */`
vec2 spritesMinusOne = vec2(spritesPerSide - 1.0);

#if defined USE_INSTANCING || defined USE_INSTANCING_INDIRECT
mat4 transformedInstanceMatrix = instanceMatrix * impostorTransform;
vec3 cameraPosLocal = (inverse(transformedInstanceMatrix * modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
#else
vec3 cameraPosLocal = (inverse(impostorTransform * modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
#endif

vec3 cameraDir = normalize(cameraPosLocal);

vec3 projectedVertex = projectVertex(cameraDir);
vec3 viewDirLocal = normalize(projectedVertex - cameraPosLocal);

vec2 grid = encodeDirection(cameraDir) * spritesMinusOne;
vec2 gridFloor = min(floor(grid), spritesMinusOne);

vec2 gridFract = fract(grid);

computeSpritesWeight(gridFract);

vSprite1 = gridFloor;
vSprite2 = min(vSprite1 + mix(vec2(0.0, 1.0), vec2(1.0, 0.0), vSpritesWeight.w), spritesMinusOne);
vSprite3 = min(vSprite1 + vec2(1.0), spritesMinusOne);

vec3 spriteNormal1 = decodeDirection(vSprite1, spritesMinusOne);
vec3 spriteNormal2 = decodeDirection(vSprite2, spritesMinusOne);
vec3 spriteNormal3 = decodeDirection(vSprite3, spritesMinusOne);

vec3 planeX1, planeY1, planeX2, planeY2, planeX3, planeY3;
computePlaneBasis(spriteNormal1, planeX1, planeY1);
computePlaneBasis(spriteNormal2, planeX2, planeY2);
computePlaneBasis(spriteNormal3, planeX3, planeY3);

vSpriteUV1 = projectToPlaneUV(spriteNormal1, planeX1, planeY1, cameraPosLocal, viewDirLocal);
vSpriteUV2 = projectToPlaneUV(spriteNormal2, planeX2, planeY2, cameraPosLocal, viewDirLocal);
vSpriteUV3 = projectToPlaneUV(spriteNormal3, planeX3, planeY3, cameraPosLocal, viewDirLocal);

vec4 mvPosition = vec4(projectedVertex, 1.0);

#if defined USE_INSTANCING || defined USE_INSTANCING_INDIRECT
    mvPosition = transformedInstanceMatrix * mvPosition;
# else
    mvPosition = impostorTransform * mvPosition;
#endif

mvPosition = modelViewMatrix * mvPosition;

gl_Position = projectionMatrix * mvPosition;
`;

const IMPOSTOR_PARAMS_FRAGMENT = /* glsl */`
#include <clipping_planes_pars_fragment>

uniform float spritesPerSide;
uniform float alphaClamp;

#ifdef EZ_USE_ORM
uniform sampler2D ormMap;
#endif

flat varying vec4 vSpritesWeight;
flat varying vec2 vSprite1;
flat varying vec2 vSprite2;
flat varying vec2 vSprite3;
varying vec2 vSpriteUV1;
varying vec2 vSpriteUV2;
varying vec2 vSpriteUV3;

#ifdef EZ_USE_NORMAL
vec3 blendNormals(vec2 uv1, vec2 uv2, vec2 uv3) {
  vec3 normalDepth1 = unpackRGBToNormal(texture2D(normalMap, uv1).rgb);
  vec3 normalDepth2 = unpackRGBToNormal(texture2D(normalMap, uv2).rgb);
  vec3 normalDepth3 = unpackRGBToNormal(texture2D(normalMap, uv3).rgb);
  return normalize(normalDepth1.xyz * vSpritesWeight.x + normalDepth2.xyz * vSpritesWeight.y + normalDepth3.xyz * vSpritesWeight.z);
}
#endif

vec2 getUV(vec2 uv_f, vec2 frame, float frame_size) {
  uv_f = clamp(uv_f, vec2(0), vec2(1));
  uv_f =  frame_size * (frame + uv_f);
  return clamp(uv_f, vec2(0), vec2(1));
}
`;

const IMPOSTOR_MAP_FRAGMENT = /* glsl */`
float spriteSize = 1.0 / spritesPerSide;

vec2 uv1 = getUV(vSpriteUV1, vSprite1, spriteSize);
vec2 uv2 = getUV(vSpriteUV2, vSprite2, spriteSize);
vec2 uv3 = getUV(vSpriteUV3, vSprite3, spriteSize);

vec4 sprite1, sprite2, sprite3;
float test = 1.0 - alphaClamp;

if (vSpritesWeight.x >=  test) {
  sprite1 = texture(map, uv1);
  if (sprite1.a <= alphaClamp) discard;
  sprite2 = texture(map, uv2);
  sprite3 = texture(map, uv3);
} else if (vSpritesWeight.y >=  test) {
  sprite2 = texture(map, uv2);
  if (sprite2.a <= alphaClamp) discard;
  sprite1 = texture(map, uv1);
  sprite3 = texture(map, uv3);
} else if (vSpritesWeight.z >=  test) {
  sprite3 = texture(map, uv3);
  if (sprite3.a <= alphaClamp) discard;
  sprite1 = texture(map, uv1);
  sprite2 = texture(map, uv2);
} else {
  sprite1 = texture(map, uv1);
  sprite2 = texture(map, uv2);
  sprite3 = texture(map, uv3);
}

vec4 blendedColor = sprite1 * vSpritesWeight.x + sprite2 * vSpritesWeight.y + sprite3 * vSpritesWeight.z;

if (blendedColor.a <= alphaClamp) discard;

#ifndef EZ_TRANSPARENT
blendedColor = vec4(vec3(blendedColor.rgb) / blendedColor.a, 1.0);
#endif
`;

const IMPOSTOR_NORMAL_FRAGMENT_BEGIN = /* glsl */`
vec3 normal = blendNormals(uv1, uv2, uv3);
vec3 nonPerturbedNormal = normal;
`;

// ------------------------------------------------------------ octa utils ----
const _absolute = new Vector3();

export function hemiOctaGridToDir(grid, target = new Vector3()) {
  target.set(grid.x - grid.y, 0, -1 + grid.x + grid.y);
  target.y = 1 - Math.abs(target.x) - Math.abs(target.z);
  return target;
}

export function octaGridToDir(grid, target = new Vector3()) {
  target.set(2 * (grid.x - 0.5), 0, 2 * (grid.y - 0.5));
  _absolute.set(Math.abs(target.x), 0, Math.abs(target.z));
  target.y = 1 - _absolute.x - _absolute.z;
  if (target.y < 0) {
    target.x = Math.sign(target.x) * (1 - _absolute.z);
    target.z = Math.sign(target.z) * (1 - _absolute.x);
  }
  return target;
}

// ------------------------------------------------ bounding sphere helper ----
const _bsTmp = new Sphere();

// Remember to updateMatrixWorld first if needed.
export function computeObjectBoundingSphere(obj, target = new Sphere(), forceCompute = false) {
  target.makeEmpty();
  traverse(obj);
  return target;

  function traverse(o) {
    if (o.isMesh) {
      const geometry = o.geometry;
      if (forceCompute || !geometry.boundingSphere) geometry.computeBoundingSphere();
      _bsTmp.copy(geometry.boundingSphere).applyMatrix4(o.matrixWorld);
      target.union(_bsTmp);
    }
    for (const child of o.children) traverse(child);
  }
}

// -------------------------------------------------------- atlas baker ----
const _camera = new OrthographicCamera();
const _bSphere = new Sphere();
const _oldScissor = new Vector4();
const _oldViewport = new Vector4();
const _coords = new Vector2();
const USERDATA_MAT_KEY = 'ez_originalMaterial';

// params: { renderer, target, useHemiOctahedron, textureSize?=2048,
//           spritesPerSide?=16, cameraFactor?=1 }
// -> { renderTarget, albedo, normalDepth }
export function createTextureAtlas(params) {
  const { renderer, target, useHemiOctahedron } = params;
  if (!renderer) throw new Error('createTextureAtlas: "renderer" is mandatory.');
  if (!target) throw new Error('createTextureAtlas: "target" is mandatory.');
  if (useHemiOctahedron == null) throw new Error('createTextureAtlas: "useHemiOctahedron" is mandatory.');

  const atlasSize = params.textureSize ?? 2048;
  const countPerSide = params.spritesPerSide ?? 16;
  const countPerSideMinusOne = countPerSide - 1;
  const spriteSize = atlasSize / countPerSide;

  computeObjectBoundingSphere(target, _bSphere, true);
  const cameraFactor = params.cameraFactor ?? 1;
  updateCamera();

  const { renderTarget, oldPixelRatio, oldScissorTest, oldClearAlpha } = setupRenderer();
  overrideTargetMaterial(target);

  for (let row = 0; row < countPerSide; row++) {
    for (let col = 0; col < countPerSide; col++) renderView(col, row);
  }

  restoreRenderer();
  restoreTargetMaterial(target);

  return { renderTarget, albedo: renderTarget.textures[0], normalDepth: renderTarget.textures[1] };

  function overrideTargetMaterial(t) {
    t.traverse((mesh) => {
      if (mesh.material) {
        const material = mesh.material;
        mesh.userData[USERDATA_MAT_KEY] = material;
        mesh.material = Array.isArray(material) ? material.map((m) => createMaterial(m)) : createMaterial(material);
      }
    });
  }

  function createMaterial(material) {
    const hasMap = !!material.map;
    const hasAlphaMap = !!material.alphaMap;
    const hasNormalMap = !!material.normalMap;
    const hasBumpMap = !!material.bumpMap;
    const hasDisplacementMap = !!material.displacementMap;
    const hasAlphaTest = material.alphaTest > 0;

    const uniforms = {
      diffuse: { value: material.color },
      opacity: { value: material.opacity },
    };
    if (hasAlphaTest) uniforms.alphaTest = { value: material.alphaTest };
    if (hasMap) { uniforms.map = { value: material.map }; uniforms.mapTransform = { value: material.map.matrix }; }
    if (hasAlphaMap) { uniforms.alphaMap = { value: material.alphaMap }; uniforms.alphaMapTransform = { value: material.alphaMap.matrix }; }
    if (hasNormalMap) { uniforms.normalMap = { value: material.normalMap }; uniforms.normalScale = { value: material.normalScale }; uniforms.normalMapTransform = { value: material.normalMap.matrix }; }
    if (hasBumpMap) { uniforms.bumpMap = { value: material.bumpMap }; uniforms.bumpScale = { value: material.bumpScale }; uniforms.bumpMapTransform = { value: material.bumpMap.matrix }; }
    if (hasDisplacementMap) { uniforms.displacementMap = { value: material.displacementMap }; uniforms.displacementScale = { value: material.displacementScale }; uniforms.displacementBias = { value: material.displacementBias }; uniforms.displacementMapTransform = { value: material.displacementMap.matrix }; }

    const defines = {};
    if (hasMap || hasAlphaMap || hasNormalMap || hasBumpMap || hasDisplacementMap) defines.USE_UV = '';

    const shaderMaterial = new ShaderMaterial({
      uniforms, defines, vertexShader: ATLAS_VERTEX, fragmentShader: ATLAS_FRAGMENT, glslVersion: GLSL3,
      transparent: material.transparent, side: material.side, alphaHash: material.alphaHash,
      depthFunc: material.depthFunc, depthWrite: material.depthWrite, depthTest: material.depthTest,
      blending: material.blending, blendSrc: material.blendSrc, blendDst: material.blendDst,
      blendEquation: material.blendEquation, blendSrcAlpha: material.blendSrcAlpha, blendDstAlpha: material.blendDstAlpha,
      blendEquationAlpha: material.blendEquationAlpha, premultipliedAlpha: material.premultipliedAlpha,
      alphaToCoverage: material.alphaToCoverage, blendAlpha: material.blendAlpha, blendColor: material.blendColor,
      colorWrite: material.colorWrite, forceSinglePass: material.forceSinglePass, vertexColors: material.vertexColors,
      precision: material.precision, visible: material.visible,
    });

    shaderMaterial.onBeforeCompile = (shader) => {
      if (hasMap) { shader.map = true; shader.mapUv = 'uv'; }
      if (hasAlphaMap) { shader.alphaMap = true; shader.alphaMapUv = 'uv'; }
      if (hasNormalMap) {
        shader.normalMap = true; shader.normalMapUv = 'uv';
        shader.normalMapTangentSpace = material.normalMapType === TangentSpaceNormalMap;
        shader.normalMapObjectSpace = material.normalMapType === ObjectSpaceNormalMap;
      }
      if (hasBumpMap) { shader.bumpMap = true; shader.bumpMapUv = 'uv'; }
      if (hasDisplacementMap) { shader.displacementMap = true; shader.displacementMapUv = 'uv'; }
      shader.flatShading = material.flatShading;
      shader.alphaTest = hasAlphaTest;
    };

    return shaderMaterial;
  }

  function restoreTargetMaterial(t) {
    t.traverse((mesh) => {
      if (mesh.userData[USERDATA_MAT_KEY]) {
        mesh.material = mesh.userData[USERDATA_MAT_KEY];
        delete mesh.userData[USERDATA_MAT_KEY];
      }
    });
  }

  function renderView(col, row) {
    _coords.set(col / countPerSideMinusOne, row / countPerSideMinusOne);
    if (useHemiOctahedron) hemiOctaGridToDir(_coords, _camera.position);
    else octaGridToDir(_coords, _camera.position);

    _camera.position.setLength(_bSphere.radius * cameraFactor).add(_bSphere.center);
    _camera.lookAt(_bSphere.center);

    const xOffset = (col / countPerSide) * atlasSize;
    const yOffset = (row / countPerSide) * atlasSize;
    renderer.setViewport(xOffset, yOffset, spriteSize, spriteSize);
    renderer.setScissor(xOffset, yOffset, spriteSize, spriteSize);
    renderer.render(target, _camera);
  }

  function updateCamera() {
    _camera.left = -_bSphere.radius;
    _camera.right = _bSphere.radius;
    _camera.top = _bSphere.radius;
    _camera.bottom = -_bSphere.radius;
    _camera.zoom = cameraFactor;
    _camera.near = 0.001;
    _camera.far = _bSphere.radius * 2 + 0.001;
    _camera.updateProjectionMatrix();
  }

  function setupRenderer() {
    const oldPixelRatio = renderer.getPixelRatio();
    const oldScissorTest = renderer.getScissorTest();
    const oldClearAlpha = renderer.getClearAlpha();
    renderer.getScissor(_oldScissor);
    renderer.getViewport(_oldViewport);

    const renderTarget = new WebGLRenderTarget(atlasSize, atlasSize, { count: 2, generateMipmaps: true });

    renderTarget.textures[0].minFilter = LinearMipmapLinearFilter;
    renderTarget.textures[0].magFilter = LinearFilter;
    renderTarget.textures[0].type = UnsignedByteType;
    renderTarget.textures[0].colorSpace = LinearSRGBColorSpace;

    renderTarget.textures[1].minFilter = NearestMipMapNearestFilter;
    renderTarget.textures[1].magFilter = NearestFilter;
    renderTarget.textures[1].type = UnsignedByteType;
    renderTarget.textures[1].colorSpace = LinearSRGBColorSpace;

    renderer.setRenderTarget(renderTarget);
    renderer.setScissorTest(true);
    renderer.setPixelRatio(1);
    renderer.setClearAlpha(0);

    return { renderTarget, oldPixelRatio, oldScissorTest, oldClearAlpha };
  }

  function restoreRenderer() {
    renderer.setRenderTarget(null);
    renderer.setScissorTest(oldScissorTest);
    renderer.setViewport(_oldViewport.x, _oldViewport.y, _oldViewport.z, _oldViewport.w);
    renderer.setScissor(_oldScissor.x, _oldScissor.y, _oldScissor.z, _oldScissor.w);
    renderer.setPixelRatio(oldPixelRatio);
    renderer.setClearAlpha(oldClearAlpha);
  }
}

// ---------------------------------------------- impostor material patch ----
// params: CreateTextureAtlasParams + { baseType?=MeshStandardMaterial,
//          transparent?, alphaClamp?=0.4, transform?:Matrix4 }
// Returns a `baseType` material whose shader samples the octahedral atlas.
export function createOctahedralImpostorMaterial(params) {
  if (!params) throw new Error('createOctahedralImpostorMaterial: parameters is required.');
  if (params.useHemiOctahedron == null) throw new Error('createOctahedralImpostorMaterial: useHemiOctahedron is required.');

  const BaseType = params.baseType ?? MeshStandardMaterial;
  const { albedo, normalDepth } = createTextureAtlas(params);

  const material = new BaseType();
  material.isOctahedralImpostorMaterial = true;
  material.transparent = params.transparent ?? false;
  material.map = albedo;
  material.normalMap = normalDepth;

  material.ezImpostorDefines = {};
  if (params.useHemiOctahedron) material.ezImpostorDefines.EZ_USE_HEMI_OCTAHEDRON = true;
  if (params.transparent) material.ezImpostorDefines.EZ_TRANSPARENT = true;
  material.ezImpostorDefines.EZ_USE_NORMAL = true;

  material.ezImpostorUniforms = {
    spritesPerSide: { value: params.spritesPerSide ?? 16 },
    alphaClamp: { value: params.alphaClamp ?? 0.4 },
    impostorTransform: { value: params.transform ?? new Matrix4() },
  };

  overrideMaterialCompilation(material);
  return material;
}

function overrideMaterialCompilation(material) {
  const onBeforeCompileBase = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    shader.defines = { ...shader.defines, ...material.ezImpostorDefines };
    shader.uniforms = { ...shader.uniforms, ...material.ezImpostorUniforms };

    shader.vertexShader = shader.vertexShader
      .replace('#include <clipping_planes_pars_vertex>', IMPOSTOR_PARAMS_VERTEX)
      .replace('#include <project_vertex>', IMPOSTOR_VERTEX);

    shader.fragmentShader = shader.fragmentShader
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `${IMPOSTOR_MAP_FRAGMENT}\n vec4 diffuseColor = vec4( diffuse, opacity );`)
      .replace('#include <clipping_planes_pars_fragment>', IMPOSTOR_PARAMS_FRAGMENT)
      .replace('#include <normal_fragment_begin>', IMPOSTOR_NORMAL_FRAGMENT_BEGIN)
      .replace('#include <normal_fragment_maps>', '// #include <normal_fragment_maps>')
      .replace('#include <map_fragment>', 'diffuseColor *= blendedColor;');

    onBeforeCompileBase?.call(material, shader, renderer);
  };

  const customProgramCacheKeyBase = material.customProgramCacheKey;
  material.customProgramCacheKey = () => {
    const d = material.ezImpostorDefines;
    return `ez_${!!d.EZ_USE_HEMI_OCTAHEDRON}_${!!material.transparent}_${!!d.EZ_USE_NORMAL}_${!!d.EZ_USE_ORM}_${customProgramCacheKeyBase.call(material)}`;
  };
}

// ------------------------------------------------------- impostor mesh ----
// A camera-facing quad whose material samples the octahedral atlas. Pass either
// an already-built impostor material, or atlas params (incl. `target`) to bake.
export class OctahedralImpostor extends Mesh {
  constructor(materialOrParams) {
    super(new PlaneGeometry(), null);

    if (!materialOrParams.isOctahedralImpostorMaterial) {
      const mesh = materialOrParams.target;
      const sphere = computeObjectBoundingSphere(mesh, new Sphere(), true);
      const scale = sphere.radius * 2;
      materialOrParams.transform = new Matrix4().makeScale(scale, scale, scale).setPosition(sphere.center.clone());
      materialOrParams = createOctahedralImpostorMaterial(materialOrParams);
    }

    this.material = materialOrParams;
  }

  clone() {
    const impostor = new OctahedralImpostor(this.material);
    impostor.scale.copy(this.scale);
    impostor.position.copy(this.position);
    return impostor;
  }
}
