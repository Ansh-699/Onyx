"use client";

// Animated chromatic-metal liquid-glass CTA.
// Layer 1: WebGL fragment shader — angled (108°) liquid-chrome bands that
//   flow and ripple on a perfectly seamless 4s loop (every time term is an
//   integer multiple of one 0→2π phase, so frame N == frame 0), with
//   per-channel sampling for chromatic fringes and a radial vignette.
//   Non-WebGL fallback: repeating-linear-gradient + SVG feTurbulence →
//   feDisplacementMap → per-channel feOffset/feBlend(screen) — same look.
// Layer 2: glass pill that refracts the metal behind it via
//   backdrop-filter: url(#displacement) (Chromium; blur+saturate elsewhere),
//   glass-body gradient + rim + inset shadows, gloss band, floating shadow,
//   and a conic-gradient stroke sweeping the perimeter forever.
// prefers-reduced-motion: static metal frame, no stroke sweep, no lift.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import styles from "./ChromeCta.module.css";

export interface ChromeCtaProps {
  href: string;
  label?: string;
  /** band frequency across the panel (default 7) */
  bands?: number;
  /** liquid warp strength (default 0.55) */
  warp?: number;
  /** chromatic split, in band-space radians (default 0.16) */
  split?: number;
  /** seamless loop length in ms (default 4000) */
  loopMs?: number;
}

const VERT = `attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}`;

const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_phase;  /* 0..2pi, loops seamlessly */
uniform float u_bands;
uniform float u_warp;
uniform float u_split;

const float ANG = 1.8849556; /* 108 degrees */

/* metallic tone ramp: sharp white highlights, deep darks, steel between */
float toneRamp(float t){
  float s = sin(t);
  float w = pow(max(s, 0.), 7.0);
  float k = pow(max(-s, 0.), 3.5);
  return clamp(.50 + .50*w - .47*k, .02, 1.);
}

float field(vec2 p, vec2 uv, float off){
  vec2 dir = vec2(cos(ANG), sin(ANG));
  float t = dot(p, dir) * u_bands;
  /* liquid warp — layered periodic ripples; strongest mid-field.
     every phase multiplier is an integer => seamless loop */
  float mid = 1.0 - clamp(abs(uv.y - .5) * 1.6, 0., 1.);
  float amp = u_warp * (.35 + .65 * mid);
  t += amp * ( sin(uv.y*4.7 + u_phase*2.0)
             + .6*sin(uv.x*7.3 - u_phase)
             + .35*sin((uv.x+uv.y)*11.0 + u_phase*3.0) );
  /* flow: two whole band periods per loop */
  t += u_phase * 2.0;
  return toneRamp(t + off);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = vec2(uv.x * u_res.x / u_res.y, uv.y);
  /* chromatic metal: sample the ramp once per channel, offset apart */
  float r = field(p, uv,  u_split);
  float g = field(p, uv,  0.0);
  float b = field(p, uv, -u_split);
  vec3 col = vec3(r, g, b);
  col *= vec3(.97, .985, 1.045);              /* cool chrome tint */
  col += vec3(.10, .055, .0) * abs(r - b);    /* gold hint at fringes */
  col += vec3(.02, .045, .10) * (1.0 - g);    /* iridescent blue in darks */
  vec2 c = uv - .5;
  col *= 1.0 - .5 * pow(dot(c, c) * 2.4, 1.1); /* vignette */
  gl_FragColor = vec4(col, 1.);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("ChromeCta shader:", gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

export function ChromeCta({ href, label = "Launch App", bands = 10, warp = 0.55, split = 0.16, loopMs = 4000 }: ChromeCtaProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [webglOk, setWebglOk] = useState(true);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    if (!gl) {
      setWebglOk(false);
      return;
    }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) {
      setWebglOk(false);
      return;
    }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("ChromeCta link:", gl.getProgramInfoLog(prog));
      setWebglOk(false);
      return;
    }
    gl.useProgram(prog);

    // fullscreen triangle
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, "u_res");
    const uPhase = gl.getUniformLocation(prog, "u_phase");
    gl.uniform1f(gl.getUniformLocation(prog, "u_bands"), bands);
    gl.uniform1f(gl.getUniformLocation(prog, "u_warp"), warp);
    gl.uniform1f(gl.getUniformLocation(prog, "u_split"), split);

    // size from the measured element × dpr — never 0×0
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(wrap.clientWidth * dpr));
      const h = Math.max(1, Math.round(wrap.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, canvas.width, canvas.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const TWO_PI = Math.PI * 2;
    let raf = 0;
    const draw = (t: number) => {
      gl.uniform1f(uPhase, ((t % loopMs) / loopMs) * TWO_PI);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    // draw one frame immediately — no blank flash
    draw(0);
    if (!reduced) {
      const tick = (t: number) => {
        draw(t);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [bands, warp, split, loopMs]);

  return (
    <div ref={wrapRef} className={styles.stack}>
      {/* layer 1: chromatic metal */}
      {webglOk ? <canvas ref={canvasRef} className={styles.metal} aria-hidden /> : <div className={`${styles.metal} ${styles.metalFallback}`} aria-hidden />}
      {/* vignette */}
      <div className={styles.vignette} aria-hidden />
      {/* layer 2: liquid-glass pill */}
      <div className={styles.btnWrap}>
        <Link href={href} className={styles.glassBtn} data-testid="chrome-cta">
          <span className={styles.glassLabel}>{label}</span>
        </Link>
      </div>

      {/* SVG filters: backdrop refraction (Chromium) + fallback warp/split */}
      <svg className={styles.filters} aria-hidden>
        <defs>
          <filter id="onyx-cta-refract" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.02 0.028" numOctaves="2" seed="11" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="42" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="onyx-chrome-warp" x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves="2" seed="7" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="26" xChannelSelector="R" yChannelSelector="G" result="w" />
            <feColorMatrix in="w" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r0" />
            <feOffset in="r0" dx="2.2" dy="0" result="r" />
            <feColorMatrix in="w" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
            <feColorMatrix in="w" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b0" />
            <feOffset in="b0" dx="-2.2" dy="0" result="b" />
            <feBlend in="r" in2="g" mode="screen" result="rg" />
            <feBlend in="rg" in2="b" mode="screen" />
          </filter>
        </defs>
      </svg>
    </div>
  );
}
