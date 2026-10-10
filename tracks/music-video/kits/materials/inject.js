// Inject the GLSL library into any shader object ({uniforms, fragmentShader}) right after `#include <common>`.
// Works for three built-in materials (onBeforeCompile) and for custom ShaderMaterials that include <common>.
import {MAT_GLSL} from './glsl.js';
export function injectMaterialLibrary(shader, uniforms) {
  if (!shader?.fragmentShader?.includes('#include <common>')) throw new Error('fragment shader must contain #include <common>');
  Object.assign(shader.uniforms, uniforms);
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec4 uSnowP, uSnowP2, uIceP, uIceP2;\n' + MAT_GLSL);
  return shader;
}
