// VHSC (VHS-C camcorder look) post-processing shader for Three.js.
// Ported from LICHEN's vhsc.js — same blur → sharpen → posterize chain.
//
// Used as a full-screen-quad ShaderMaterial rendered to the default framebuffer
// after the main scene has been drawn to an offscreen WebGLRenderTarget.

import * as THREE from 'three';

export const vhscVertexShader = `
varying vec2 vTexCoord;

void main() {
  vTexCoord = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const vhscFragmentShader = `
precision highp float;
varying vec2 vTexCoord;
uniform sampler2D tex0;
uniform float gamma;
uniform float posterizeLevels;
uniform vec2 texelSize;

void main() {
  vec3 centerColor = texture2D(tex0, vTexCoord).rgb;
  vec3 leftColor = texture2D(tex0, vTexCoord - vec2(texelSize.x, 0.0)).rgb;
  vec3 rightColor = texture2D(tex0, vTexCoord + vec2(texelSize.x, 0.0)).rgb;
  vec3 topColor = texture2D(tex0, vTexCoord + vec2(0.0, texelSize.y)).rgb;
  vec3 bottomColor = texture2D(tex0, vTexCoord - vec2(0.0, texelSize.y)).rgb;

  vec3 blurredColor = topColor * 0.10 + leftColor * 0.20 + centerColor * 0.40 + rightColor * 0.20 + bottomColor * 0.10;
  vec3 sharpenedColor = blurredColor * 5.0 - (leftColor + rightColor + topColor + bottomColor);
  vec3 posterizedColor = floor(sharpenedColor * posterizeLevels) / posterizeLevels;

  gl_FragColor = vec4(posterizedColor, 1.0);
}
`;

// Convenience: a ready-made ShaderMaterial, fullscreen quad, and ortho camera
// for a two-pass render (scene → renderTarget, then renderTarget → screen via
// this material).

export function createVHSCPass(width, height) {
    const renderTarget = new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat
    });

    const material = new THREE.ShaderMaterial({
        uniforms: {
            tex0: { value: renderTarget.texture },
            gamma: { value: 1.2 },
            posterizeLevels: { value: 90.0 },
            texelSize: { value: new THREE.Vector2(0.008, 0.008 * 1.375) }
        },
        vertexShader: vhscVertexShader,
        fragmentShader: vhscFragmentShader,
        depthWrite: false,
        depthTest: false
    });

    const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        material
    );

    const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const orthoScene = new THREE.Scene();
    orthoScene.add(quad);

    return { renderTarget, material, quad, orthoCamera, orthoScene };
}
