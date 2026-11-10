// Holografischer JARVIS-Reaktorkern (Three.js + GLSL). Reagiert auf den echten Gesprächszustand
// und auf echte Audiopegel (Mikrofon beim Zuhören, Sprachausgabe beim Sprechen).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const WHITE = new THREE.Color(1, 1, 1);

const PRESETS = {
  idle: { color: [0.17, 0.86, 1.0], energy: 0.3, spin: 0.16, glow: 0.85, particles: 0.22, noise: 0.25, breathe: 1 },
  listening: { color: [0.6, 0.97, 1.0], energy: 0.6, spin: 0.28, glow: 1.25, particles: 0.45, noise: 0.35, breathe: 0 },
  processing: { color: [0.22, 0.52, 1.0], energy: 0.85, spin: 1.15, glow: 1.2, particles: 1.0, noise: 0.95, breathe: 0 },
  speaking: { color: [0.25, 0.9, 1.0], energy: 0.65, spin: 0.35, glow: 1.15, particles: 0.5, noise: 0.45, breathe: 0 },
  executing: { color: [0.36, 0.6, 1.0], energy: 1.0, spin: 1.7, glow: 1.3, particles: 1.6, noise: 1.0, breathe: 0 },
  interrupted: { color: [0.92, 0.98, 1.0], energy: 0.35, spin: 0.08, glow: 1.6, particles: 0.1, noise: 0.2, breathe: 0 },
  error: { color: [1.0, 0.18, 0.26], energy: 0.5, spin: 0.22, glow: 1.0, particles: 0.2, noise: 0.6, breathe: 1 },
};

const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

function glowTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.15, 'rgba(200,250,255,0.85)');
  grad.addColorStop(0.4, 'rgba(60,200,255,0.25)');
  grad.addColorStop(1, 'rgba(0,80,160,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Ring mit prozeduralem Muster (Segmente/Striche/Bögen) im Fragment-Shader. */
function patternRing({ inner, outer, segments, fill, arcs = 0, arcLen = 0.3, opacity = 0.8, softness = 0.15 }) {
  const geo = new THREE.RingGeometry(inner, outer, 256, 1);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color() },
      uOpacity: { value: opacity },
      uSeg: { value: segments },
      uFill: { value: fill },
      uArcs: { value: arcs },
      uArcLen: { value: arcLen },
      uInner: { value: inner },
      uOuter: { value: outer },
      uSoft: { value: softness },
      uEnergy: { value: 0 },
      uSweep: { value: 0 },
    },
    vertexShader: /* glsl */ `varying vec2 vP; void main(){ vP=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uOpacity,uSeg,uFill,uArcs,uArcLen,uInner,uOuter,uSoft,uEnergy,uSweep; varying vec2 vP;
      void main(){
        float r=length(vP); float a=atan(vP.y,vP.x)/6.28318+.5;
        float radial=(r-uInner)/(uOuter-uInner);
        float edge=smoothstep(0.,uSoft,radial)*smoothstep(1.,1.-uSoft,radial);
        float seg=1.;
        if(uSeg>0.){ float f=fract(a*uSeg); seg=step(f,uFill); }
        if(uArcs>0.){ float f=fract(a*uArcs); seg*=step(f,uArcLen); }
        // Lichtlauf entlang des Rings
        float sweep=pow(max(0.,1.-abs(fract(a-uSweep)-.5)*2.),12.)*uEnergy;
        float alpha=edge*seg*uOpacity*(.55+.45*uEnergy)+sweep*edge*seg;
        gl_FragColor=vec4(uColor*(1.+sweep*1.5),alpha);
      }`,
  });
  return new THREE.Mesh(geo, mat);
}

export class Reactor {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = 'idle';
    this.target = { ...PRESETS.idle };
    this.cur = { ...PRESETS.idle, color: [...PRESETS.idle.color] };
    this.audio = { level: 0, bins: new Float32Array(96) };
    this.activity = 0; // laufende Hintergrund-Agenten
    this.phase = { spin: 0, particles: 0, sweep: 0 };
    this.smoothLevel = 0;
    this.lastPeak = 0;
    this.anchor = null;
    this.tmpColor = new THREE.Color();
    this.timer = new THREE.Timer();
    this.timer.connect?.(document);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x000000, 0);
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.position.set(0, 0, 9);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.#build();

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.5, 0.14);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  #build() {
    const r = this.root;
    // Energiekern
    this.coreMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color() }, uNoise: { value: 0.3 }, uAudio: { value: 0 }, uEnergy: { value: 0.3 } },
      vertexShader: /* glsl */ `
        ${NOISE_GLSL}
        uniform float uTime,uNoise,uAudio; varying vec3 vN; varying vec3 vV; varying float vD;
        void main(){
          float n=snoise(normal*1.8+vec3(uTime*.35))*0.5+snoise(normal*4.+vec3(-uTime*.6))*0.25;
          float d=n*(0.05+uNoise*0.09+uAudio*0.22);
          vD=n;
          vec3 p=position+normal*d;
          vec4 mv=modelViewMatrix*vec4(p,1.);
          vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz);
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uEnergy,uAudio,uTime; varying vec3 vN; varying vec3 vV; varying float vD;
        void main(){
          float fres=pow(1.-max(dot(vN,vV),0.),2.4);
          float bands=smoothstep(.35,.9,sin(vD*18.+uTime*2.)*.5+.5)*.35*uEnergy;
          vec3 col=uColor*(fres*1.15+bands*.8)+vec3(1.)*pow(fres,6.)*.35;
          float a=clamp(fres*.75+bands*.8+.03+uAudio*.2,0.,1.);
          gl_FragColor=vec4(col,a);
        }`,
    });
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 20), this.coreMat);
    r.add(this.core);

    // Leuchtender Mittelpunkt
    const tex = glowTexture();
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.glow.scale.setScalar(1.6);
    r.add(this.glow);
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0x2bd4ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.35 }));
    this.halo.scale.setScalar(5.2);
    r.add(this.halo);

    // Flache Muster-Ringe (Reaktor-Look)
    this.rings = [
      { m: patternRing({ inner: 0.8, outer: 0.83, segments: 0, fill: 1, arcs: 3, arcLen: 0.28, opacity: 0.9 }), speed: 0.9 },
      { m: patternRing({ inner: 0.98, outer: 1.14, segments: 14, fill: 0.78, opacity: 0.38, softness: 0.06 }), speed: -0.35 },
      { m: patternRing({ inner: 1.24, outer: 1.255, segments: 160, fill: 0.45, opacity: 0.7, softness: 0.3 }), speed: 0.12 },
      { m: patternRing({ inner: 1.52, outer: 1.545, segments: 0, fill: 1, arcs: 2, arcLen: 0.36, opacity: 0.75 }), speed: -0.5 },
      { m: patternRing({ inner: 1.7, outer: 1.78, segments: 72, fill: 0.12, opacity: 0.6, softness: 0.05 }), speed: 0.06 },
      { m: patternRing({ inner: 2.05, outer: 2.062, segments: 0, fill: 1, arcs: 5, arcLen: 0.12, opacity: 0.5 }), speed: 0.22 },
      { m: patternRing({ inner: 2.3, outer: 2.31, segments: 240, fill: 0.3, opacity: 0.35, softness: 0.3 }), speed: -0.04 },
    ];
    for (const ring of this.rings) r.add(ring.m);

    // Gyroskop-Ringe in 3D (Tiefenwirkung)
    this.gyros = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(
        new THREE.TorusGeometry(1.36 + i * 0.07, 0.0045, 6, 220),
        new THREE.MeshBasicMaterial({ color: 0x2be4ff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      m.rotation.set(Math.PI / 2.4 + i * 0.5, i * 0.9, 0);
      this.gyros.push(m);
      r.add(m);
    }

    // Radiales Audiospektrum
    const N = this.audio.bins.length * 2;
    this.specN = N;
    this.specPos = new Float32Array(N * 2 * 3);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.specPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.spectrum = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0x9ff3ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    r.add(this.spectrum);

    // Partikelwolke (Bewegung komplett im Vertex-Shader)
    const P = 1800;
    const pos = new Float32Array(P * 3);
    const seed = new Float32Array(P * 4);
    for (let i = 0; i < P; i++) {
      const radius = 0.9 + Math.pow(Math.random(), 1.6) * 2.4;
      seed.set([Math.random() * Math.PI * 2, radius, (Math.random() - 0.5) * 0.35, 0.4 + Math.random()], i * 4);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    this.partMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uPhase: { value: 0 }, uColor: { value: new THREE.Color() }, uAmount: { value: 0.3 }, uPx: { value: 1 }, uPull: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec4 seed; uniform float uPhase,uPx,uPull; varying float vA;
        void main(){
          float ang=seed.x+uPhase*seed.w/(seed.y*.6);
          float rad=seed.y-uPull*fract(uPhase*.08*seed.w+seed.x)*seed.y*.55;
          vec3 p=vec3(cos(ang)*rad,sin(ang)*rad*.92,seed.z*rad);
          vec4 mv=modelViewMatrix*vec4(p,1.);
          gl_Position=projectionMatrix*mv;
          gl_PointSize=(1.2+seed.w*1.6)*uPx*(7./-mv.z);
          vA=smoothstep(3.4,1.,seed.y)*(.35+.65*seed.w);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uAmount; varying float vA;
        void main(){ float d=length(gl_PointCoord-.5); float a=smoothstep(.5,0.,d)*vA*uAmount; gl_FragColor=vec4(uColor,a); }`,
    });
    this.particles = new THREE.Points(pg, this.partMat);
    r.add(this.particles);

    // Schockwellen (Sprachausgabe / Wake)
    this.waves = [];
    for (let i = 0; i < 6; i++) {
      const m = patternRing({ inner: 0.96, outer: 1.0, segments: 0, fill: 1, opacity: 0, softness: 0.5 });
      m.visible = false;
      this.waves.push({ m, t: 1, strength: 0 });
      r.add(m);
    }

    // Arbeitsknoten (sichtbar beim Ausführen von Aufgaben)
    this.nodes = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0x9fdcff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
      s.scale.setScalar(0.22);
      s.userData.offset = (i / 6) * Math.PI * 2;
      this.nodes.add(s);
    }
    this.nodes.rotation.x = 1.1;
    r.add(this.nodes);
  }

  /** Bindet die Position des Kerns an ein DOM-Element (Klickfläche im Layout). */
  anchorTo(el) {
    this.anchor = el;
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(Math.max(128, w / 2), Math.max(128, h / 2));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.position.z;
    const halfW = halfH * this.camera.aspect;
    let cx = 0;
    let cy = 0.16;
    let sizePx = Math.min(h * 0.38, w * 0.34);
    if (this.anchor) {
      const a = this.anchor.getBoundingClientRect();
      const c = this.canvas.getBoundingClientRect();
      cx = ((a.left + a.width / 2 - c.left) / c.width) * 2 - 1;
      cy = 1 - ((a.top + a.height / 2 - c.top) / c.height) * 2;
      sizePx = a.width;
    }
    this.root.position.set(cx * halfW, cy * halfH, 0);
    // Kerndurchmesser (Ring 1.14) ~ Klickfläche; äußere Ringe dürfen darüber hinaus leuchten
    const worldPerPx = (halfH * 2) / h;
    this.root.scale.setScalar(Math.max(0.3, (sizePx * worldPerPx) / 2 / 1.14));
    this.partMat.uniforms.uPx.value = this.renderer.getPixelRatio() * (h / 900);
  }

  setState(state) {
    if (!PRESETS[state]) return;
    if (state === this.state) return;
    const prev = this.state;
    this.state = state;
    this.target = PRESETS[state];
    if (state === 'listening' && prev === 'idle') this.wave(1.2);
    if (state === 'interrupted') this.wave(1.5);
    if (state === 'error') this.wave(0.8);
  }

  /** Echte Audiodaten: level 0..1, bins 0..1 */
  setAudio(level, bins) {
    this.audio.level = level;
    if (bins) this.audio.bins.set(bins.subarray ? bins.subarray(0, this.audio.bins.length) : bins);
  }
  setActivity(n) {
    this.activity = n;
  }

  wave(strength = 1) {
    const w = this.waves.find((x) => x.t >= 1) || this.waves[0];
    w.t = 0;
    w.strength = strength;
    w.m.visible = true;
  }

  #frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.05);
    const t = this.timer.getElapsed();
    const k = 1 - Math.exp(-dt * 3.2);
    const c = this.cur;
    const tg = this.target;
    for (const key of ['energy', 'spin', 'glow', 'particles', 'noise', 'breathe']) c[key] += (tg[key] - c[key]) * k;
    for (let i = 0; i < 3; i++) c.color[i] += (tg.color[i] - c.color[i]) * k;
    const color = this.tmpColor.setRGB(c.color[0], c.color[1], c.color[2]);

    // Audiopegel glätten (schneller Anstieg, langsamer Abfall)
    const lvl = this.audio.level;
    this.smoothLevel += (lvl - this.smoothLevel) * (lvl > this.smoothLevel ? 0.5 : 0.12);
    const audio = this.state === 'speaking' || this.state === 'listening' ? this.smoothLevel : this.smoothLevel * 0.3;
    if (this.state === 'speaking' && lvl > 0.32 && lvl > this.smoothLevel * 1.15 && t - this.lastPeak > 0.22) {
      this.lastPeak = t;
      this.wave(0.4 + lvl);
    }

    const breathe = c.breathe * (0.5 + 0.5 * Math.sin(t * 1.4));
    const errorFlicker = this.state === 'error' ? 0.75 + 0.25 * Math.sin(t * 9) : 1;
    const activity = Math.min(1, this.activity * 0.5);

    this.phase.spin += dt * (c.spin + activity * 0.4);
    this.phase.particles += dt * (0.3 + c.particles * 1.4 + activity);
    this.phase.sweep += dt * (0.15 + c.spin * 0.35);

    // Kern
    const u = this.coreMat.uniforms;
    u.uTime.value = t;
    u.uColor.value.copy(color);
    u.uNoise.value = c.noise;
    u.uAudio.value = audio;
    u.uEnergy.value = c.energy;
    const coreScale = 1 + audio * 0.18 + breathe * 0.04;
    this.core.scale.setScalar(coreScale);
    this.core.rotation.y = this.phase.spin * 0.3;
    this.glow.material.color.copy(color).lerp(WHITE, 0.3);
    this.glow.scale.setScalar((0.75 + c.energy * 0.35 + audio * 0.7 + breathe * 0.1) * errorFlicker);
    this.glow.material.opacity = 0.4 + c.energy * 0.2;
    this.halo.material.color.copy(color);
    this.halo.material.opacity = (0.08 + c.glow * 0.07 + audio * 0.12) * errorFlicker;

    // Ringe
    this.rings.forEach((ring, i) => {
      ring.m.rotation.z = this.phase.spin * ring.speed * (i % 2 ? 1.3 : 1);
      const ru = ring.m.material.uniforms;
      ru.uColor.value.copy(color);
      ru.uEnergy.value = Math.min(1.4, c.energy + audio * 0.6) * errorFlicker;
      ru.uSweep.value = this.phase.sweep * (i % 2 ? -1 : 1) + i * 0.17;
    });
    this.gyros.forEach((g, i) => {
      g.rotation.x += dt * (0.15 + c.spin * 0.25) * (i === 1 ? -1 : 1);
      g.rotation.y += dt * (0.1 + c.spin * 0.2) * (i === 2 ? -1 : 1);
      g.material.color.copy(color);
      g.material.opacity = 0.18 + c.energy * 0.35;
    });

    // Spektrum
    const bins = this.audio.bins;
    const nb = bins.length;
    const showSpec = this.state === 'speaking' || this.state === 'listening';
    this.spectrum.material.opacity += ((showSpec ? 0.85 : 0.12) - this.spectrum.material.opacity) * k;
    this.spectrum.material.color.copy(color).lerp(WHITE, 0.3);
    for (let i = 0; i < this.specN; i++) {
      const bi = i < nb ? i : this.specN - 1 - i; // gespiegelt
      const v = showSpec ? bins[bi] : 0.04 + 0.03 * Math.sin(t * 2 + i * 0.3);
      const a = (i / this.specN) * Math.PI * 2 + Math.PI / 2;
      const r0 = 1.3;
      const r1 = r0 + 0.04 + v * 0.55;
      const o = i * 6;
      this.specPos[o] = Math.cos(a) * r0;
      this.specPos[o + 1] = Math.sin(a) * r0;
      this.specPos[o + 3] = Math.cos(a) * r1;
      this.specPos[o + 4] = Math.sin(a) * r1;
    }
    this.spectrum.geometry.attributes.position.needsUpdate = true;

    // Partikel
    const pu = this.partMat.uniforms;
    pu.uPhase.value = this.phase.particles;
    pu.uColor.value.copy(color);
    pu.uAmount.value = 0.35 + c.particles * 0.45 + activity * 0.3;
    pu.uPull.value += ((this.state === 'processing' || this.state === 'executing' || activity > 0 ? 1 : 0) - pu.uPull.value) * k;
    this.particles.rotation.z = this.phase.spin * 0.05;

    // Schockwellen
    for (const w of this.waves) {
      if (w.t >= 1) continue;
      w.t += dt * 0.9;
      const s = 1.1 + w.t * 1.9;
      w.m.scale.setScalar(s);
      w.m.material.uniforms.uColor.value.copy(color);
      w.m.material.uniforms.uOpacity.value = (1 - w.t) * 0.7 * w.strength;
      if (w.t >= 1) w.m.visible = false;
    }

    // Arbeitsknoten
    const exec = this.state === 'executing' ? 1 : activity;
    this.nodes.rotation.z = this.phase.particles * 0.6;
    this.nodes.children.forEach((n, i) => {
      const a = n.userData.offset;
      n.position.set(Math.cos(a) * 1.95, Math.sin(a) * 1.95, 0);
      n.material.opacity += (exec * (0.6 + 0.4 * Math.sin(t * 6 + i)) - n.material.opacity) * k;
      n.material.color.copy(color).lerp(WHITE, 0.4);
    });

    // leichte Kamerabewegung für Tiefe
    this.root.rotation.x = Math.sin(t * 0.21) * 0.06;
    this.root.rotation.y = Math.sin(t * 0.17) * 0.08;

    this.bloom.strength = 0.35 + c.glow * 0.35 + audio * 0.35;
    this.composer.render();
  }
}
