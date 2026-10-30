// Scene graph, lighting, sky/weather visuals, cameras and per-frame updates of the 3D world.
import * as THREE from '../../vendor/three.module.min.js';
import { makeTextures } from './textures.js';
import { TrackView } from './trackView.js';
import { CarView, SafetyCarView } from './carView.js';
import { Effects } from './effects.js';
import { clamp, lerp, wrapAngle } from '../sim/util.js';

export const CAMERA_MODES = ['chase', 'chaseFar', 'tcam', 'cockpit', 'nose', 'tv'];
export const CAMERA_NAMES = { chase: 'Chase', chaseFar: 'Chase Far', tcam: 'T-Cam', cockpit: 'Cockpit', nose: 'Nose', tv: 'TV' };

const SKY_CLEAR = { top: new THREE.Color('#2f6fc6'), horizon: new THREE.Color('#cfe3f5'), fog: new THREE.Color('#c4d9ec') };
const SKY_RAIN = { top: new THREE.Color('#4d5660'), horizon: new THREE.Color('#8e979f'), fog: new THREE.Color('#8a939b') };

export class GameRenderer {
  constructor(canvas, settings = {}) {
    this.canvas = canvas;
    this.quality = settings.quality ?? 'high';
    const q = this.quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q !== 'low', powerPreference: 'high-performance' });
    this.pixelRatioCap = q === 'low' ? 1 : q === 'medium' ? 1.5 : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap) * (settings.resolutionScale ?? 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = q !== 'low';
    this.renderer.shadowMap.type = q === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 9000);
    this.cameraMode = 'chase';
    this.camState = { pos: new THREE.Vector3(), yaw: 0, init: false, shake: 0 };
    this.carViews = new Map();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    this.scene.traverse((o) => { if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose?.(); });
    this.scene.clear();
    this.carViews.clear();
    this.ghost = null;
    this.scView = null;
  }

  loadTrack(track) {
    this.clear();
    this.track = track;
    const theme = track.def.theme;
    this.textures = makeTextures(theme, this.quality);
    // sky dome
    this.skyUniforms = { top: { value: SKY_CLEAR.top.clone() }, horizon: { value: SKY_CLEAR.horizon.clone() }, sunDir: { value: new THREE.Vector3(0.4, 0.6, 0.3).normalize() }, sunAmt: { value: 1 } };
    const sky = new THREE.Mesh(new THREE.SphereGeometry(8000, 32, 16), new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform float sunAmt; varying vec3 vDir;
        void main(){ float h = clamp(vDir.y, 0.0, 1.0); vec3 c = mix(horizon, top, pow(h, 0.55));
        float s = max(dot(normalize(vDir), sunDir), 0.0); c += vec3(1.0,0.92,0.75) * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.25) * sunAmt;
        if (vDir.y < 0.0) c = horizon * 0.9; gl_FragColor = vec4(c, 1.0); }`,
      side: THREE.BackSide, depthWrite: false, fog: false,
    }));
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    this.sky = sky;
    this.scene.add(sky);
    this.scene.fog = new THREE.Fog(SKY_CLEAR.fog.clone(), 400, 4500);
    // lights
    this.hemi = new THREE.HemisphereLight(0xdfefff, 0x4a5a3a, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
    this.sunDir = new THREE.Vector3(0.45, 0.75, 0.35).normalize();
    this.skyUniforms.sunDir.value.copy(this.sunDir);
    if (this.renderer.shadowMap.enabled) {
      this.sun.castShadow = true;
      const sz = this.quality === 'high' ? 2048 : 1024;
      this.sun.shadow.mapSize.set(sz, sz);
      const sc = this.sun.shadow.camera;
      sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 500;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.03;
    }
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    // environment map for reflections
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    const groundEnv = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshBasicMaterial({ color: 0x55604a }));
    groundEnv.rotation.x = -Math.PI / 2; groundEnv.position.y = -2;
    envScene.add(groundEnv);
    this.envMap = pm.fromScene(envScene, 0.02).texture;
    this.scene.environment = this.envMap;
    pm.dispose();
    // track
    this.trackView = new TrackView(track, this.textures, { quality: this.quality });
    this.scene.add(this.trackView.group);
    this.effects = new Effects(this.scene, this.textures, this.quality);
    // trackside TV cameras
    this.tvCams = [];
    for (let s = 0; s < track.length; s += 260) {
      const side = (Math.floor(s / 260) % 2) ? 1 : -1;
      const d = side * (track.barrierAt(s, side) + 6);
      const p = track.toWorld(s, d);
      this.tvCams.push(new THREE.Vector3(p.x, 5 + (s % 3) * 2, p.z));
    }
  }

  setSession(session) {
    this.session = session;
    for (const cv of this.carViews.values()) this.scene.remove(cv.group);
    this.carViews.clear();
    for (const c of session.comps) {
      const far = this.quality === 'low' && !c.isPlayer;
      const cv = new CarView(c.team.colors, { envMap: this.envMap, lowDetail: far });
      this.carViews.set(c.id, cv);
      this.scene.add(cv.group);
    }
    if (this.scView) this.scene.remove(this.scView.group);
    this.scView = new SafetyCarView();
    this.scView.group.visible = false;
    this.scene.add(this.scView.group);
    this.camState.init = false;
  }

  setGhost(colors) {
    if (this.ghost) this.scene.remove(this.ghost.group);
    if (!colors) { this.ghost = null; return; }
    const g = new CarView(colors, { blobShadow: false });
    g.group.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.32;
        o.material.depthWrite = false;
        o.castShadow = false;
      }
    });
    g.group.visible = false;
    this.ghost = g;
    this.scene.add(g.group);
  }

  cycleCamera(dir = 1) {
    const i = CAMERA_MODES.indexOf(this.cameraMode);
    this.cameraMode = CAMERA_MODES[(i + dir + CAMERA_MODES.length) % CAMERA_MODES.length];
    this.camState.init = false;
    return this.cameraMode;
  }

  /** per-frame update; focus = competitor to follow */
  update(dt, focus, opts = {}) {
    const session = this.session;
    if (!session || !this.track) return;
    const wx = session.weather;
    const wet = wx.wetness, rain = wx.rain;
    // cars
    for (const c of session.comps) {
      const cv = this.carViews.get(c.id);
      const visible = c.status !== 'garage';
      cv.group.visible = visible;
      if (!visible) continue;
      const kerbBounce = c.car.onKerb ? (Math.random() - 0.5) * 0.03 : 0;
      cv.update(c.car, dt, { wet: wet > 0.3, sc: false, bounce: kerbBounce });
      // hide own body in cockpit view so the halo frames the view without clipping the helmet
      if (c === focus) cv.group.children[4].visible = this.cameraMode !== 'cockpit';
      if (opts.effects !== false && c.car.speed > 3) this.effects.emitCar(c.car, dt, wet, c.car.wheelSurf);
    }
    // safety car
    if (session.safetyCar) { this.scView.group.visible = true; this.scView.update(session.safetyCar.car, dt); }
    else this.scView.group.visible = false;
    // ghost
    if (this.ghost) {
      const gp = opts.ghostPose;
      this.ghost.group.visible = !!gp;
      if (gp) this.ghost.update({ x: gp.x, z: gp.z, yaw: gp.yaw, vx: 50, steer: 0, wheelRot: gp.t * 120, tyres: { compound: 'S' } }, dt);
    }
    // events: sparks on contact
    for (const e of opts.contacts ?? []) this.effects.burstSparks(e.x, e.z, e.impact);
    // weather visuals
    const r = clamp(rain * 1.2, 0, 1);
    const cloud = 1 - (wx.sun ?? 1);
    const mix = Math.max(r, cloud * 0.6);
    this.skyUniforms.top.value.copy(SKY_CLEAR.top).lerp(SKY_RAIN.top, mix);
    this.skyUniforms.horizon.value.copy(SKY_CLEAR.horizon).lerp(SKY_RAIN.horizon, mix);
    this.skyUniforms.sunAmt.value = (wx.sun ?? 1) * (1 - r);
    this.scene.fog.color.copy(SKY_CLEAR.fog).lerp(SKY_RAIN.fog, mix);
    this.scene.fog.near = lerp(400, 60, r);
    this.scene.fog.far = lerp(4500, 900, r);
    this.sun.intensity = lerp(2.6, 0.35, Math.max(r, cloud * 0.8));
    this.hemi.intensity = lerp(0.9, 1.25, mix);
    this.renderer.toneMappingExposure = lerp(1.0, 0.9, mix);
    this.trackView.setWet(wet);
    this.trackView.setFlags(session.flags);
    this.trackView.setLights(session.lightsOn ?? 0);
    // racing line
    if (focus && opts.lineMode) this.trackView.updateRacingLine(opts.lineMode, focus.car, opts.lineProfile);
    else this.trackView.updateRacingLine('off');

    this.updateCamera(dt, focus, opts);
    this.effects.update(dt, this.camera, r);
    // shadows follow the camera target
    const tgt = focus ? new THREE.Vector3(focus.car.x, 0, focus.car.z) : this.trackView.center;
    this.sun.position.copy(tgt).addScaledVector(this.sunDir, 200);
    this.sun.target.position.copy(tgt);
    this.sky.position.copy(this.camera.position);
  }

  updateCamera(dt, focus, opts) {
    const cam = this.camera;
    const st = this.camState;
    if (!focus || focus.status === 'garage') {
      // orbit the pit building / track overview
      const t = this.track;
      const p = t.toWorld(t.pit.entryS + t.pit.boxStart + 40, t.pit.laneOffset - 2);
      const a = performance.now() / 9000;
      cam.position.set(p.x + Math.cos(a) * 45, 14, p.z + Math.sin(a) * 45);
      cam.lookAt(p.x, 2, p.z);
      cam.fov = 55; cam.updateProjectionMatrix();
      return;
    }
    const car = focus.car;
    const v = Math.abs(car.vx);
    const look = opts.lookBack ? Math.PI : (opts.lookYaw ?? 0);
    const yaw = car.yaw + look;
    const fwd = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const mode = this.cameraMode;
    let fov = 62;
    st.shake = car.onKerb ? 0.03 : st.shake * 0.9;
    const shake = (Math.random() - 0.5) * st.shake * (v / 60);
    if (mode === 'chase' || mode === 'chaseFar') {
      // spring the camera yaw towards the car's velocity direction
      const velYaw = v > 3 ? Math.atan2(car.vx * Math.sin(car.yaw) + car.vy * Math.cos(car.yaw), car.vx * Math.cos(car.yaw) - car.vy * Math.sin(car.yaw)) : car.yaw;
      const desired = (car.vx < -1 ? car.yaw : lerp(car.yaw, car.yaw + wrapAngle(velYaw - car.yaw), 0.5)) + look;
      if (!st.init) { st.yaw = desired; st.init = true; }
      st.yaw += wrapAngle(desired - st.yaw) * Math.min(1, dt * 6);
      const back = mode === 'chase' ? 7.2 : 11;
      const up = mode === 'chase' ? 2.1 : 3.3;
      const f2 = new THREE.Vector3(Math.cos(st.yaw), 0, Math.sin(st.yaw));
      cam.position.set(car.x - f2.x * back, up + shake, car.z - f2.z * back);
      cam.lookAt(car.x + f2.x * 6, 0.9, car.z + f2.z * 6);
      fov = 60 + Math.min(14, v / 7);
    } else {
      const local = { tcam: [-0.35, 1.32, 0], cockpit: [0.12, 0.8, 0], nose: [2.4, 0.5, 0] }[mode];
      if (local) {
        const c = Math.cos(car.yaw), s = Math.sin(car.yaw);
        const px = car.x + c * local[0] - s * local[2], pz = car.z + s * local[0] + c * local[2];
        cam.position.set(px, local[1] + shake + (car.pitch ?? 0) * local[0], pz);
        cam.lookAt(px + fwd.x * 20, local[1] - (mode === 'tcam' ? 0.9 : 0.35), pz + fwd.z * 20);
        cam.rotateZ(-(car.roll ?? 0) * 0.6);
        fov = mode === 'cockpit' ? 74 : 70;
      } else if (mode === 'tv') {
        let best = null, bd = Infinity;
        for (const p of this.tvCams) {
          const d = (p.x - car.x) ** 2 + (p.z - car.z) ** 2;
          if (d < bd) { bd = d; best = p; }
        }
        cam.position.copy(best);
        cam.lookAt(car.x, 0.6, car.z);
        const dist = Math.sqrt(bd);
        fov = clamp(1400 / Math.max(10, dist), 12, 55);
      }
    }
    if (Math.abs(cam.fov - fov) > 0.1) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 4); cam.updateProjectionMatrix(); }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  cameraYaw() {
    const d = this.camera.getWorldDirection(this._dir ?? (this._dir = new THREE.Vector3()));
    return Math.atan2(d.z, d.x);
  }

  /** world -> screen pixels (or null if behind camera) */
  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1) return null;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h };
  }
}
