// VHSC (VHS-C camcorder look) post-processing shader for p5.js (WEBGL mode).
// Ported from LICHEN's vhsc.js — same blur → sharpen → posterize chain.
//
// p5.js requires both a vertex and fragment shader. The vertex shader is the
// standard full-screen-quad passthrough; the fragment shader is the LICHEN
// original with the uniform names kept so the code reads the same way.

export const vhscVert = `
precision highp float;
attribute vec3 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;

void main() {
  vTexCoord = aTexCoord;
  vec4 positionVec4 = vec4(aPosition, 1.0);
  positionVec4.xy = positionVec4.xy * 2.0 - 1.0;
  gl_Position = positionVec4;
}
`;

export const vhscFrag = `
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
