// Particle effects: rain streaks, wheel spray, tyre smoke, sparks.
import * as THREE from '../../vendor/three.module.min.js';

class ParticlePool {
  constructor(max, material, opts = {}) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.size = new Float32Array(max);
    this.cursor = 0;
    this.gravity = opts.gravity ?? 0;
    this.drag = opts.drag ?? 1;
    this.grow = opts.grow ?? 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    this.points = new THREE.Points(g, material);
    this.points.frustumCulled = false;
    this.life.fill(0);
  }
  emit(x, y, z, vx, vy, vz, life, size) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life; this.size[i] = size;
  }
  update(dt) {
    const k = Math.pow(this.drag, dt);
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= this.gravity * dt;
      this.vel[i * 3] *= k; this.vel[i * 3 + 1] *= k; this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.05, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow * dt;
      const f = this.life[i] / this.maxLife[i];
      this.alpha[i] = Math.max(0, f);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
  }
}

function pointMaterial(texture, color, opacity, additive = false) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: texture }, color: { value: new THREE.Color(color) }, opacity: { value: opacity }, scale: { value: 600 } },
    vertexShader: `attribute float alpha; attribute float size; varying float vA; uniform float scale;
      void main(){ vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D map; uniform vec3 color; uniform float opacity; varying float vA;
      void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(color, t.a * vA * opacity); if (gl_FragColor.a < 0.01) discard; }`,
    transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

export class Effects {
  constructor(scene, textures, quality = 'high') {
    this.scene = scene;
    const q = quality === 'low' ? 0.4 : quality === 'medium' ? 0.7 : 1;
    this.spray = new ParticlePool(Math.round(1400 * q), pointMaterial(textures.sprite, 0xdfe6ee, 0.14), { drag: 0.35, grow: 1.6, gravity: 1 });
    this.smoke = new ParticlePool(Math.round(600 * q), pointMaterial(textures.sprite, 0xcfcfcf, 0.45), { drag: 0.5, grow: 2.2, gravity: -0.4 });
    this.sparks = new ParticlePool(Math.round(300 * q), pointMaterial(textures.sprite, 0xffb040, 1, true), { drag: 0.6, gravity: 9 });
    this.dust = new ParticlePool(Math.round(400 * q), pointMaterial(textures.sprite, 0xb59a74, 0.5), { drag: 0.5, grow: 2.5, gravity: 0.5 });
    for (const p of [this.spray, this.smoke, this.sparks, this.dust]) scene.add(p.points);
    // rain streaks around the camera
    this.rainCount = Math.round(4000 * q);
    const rp = new Float32Array(this.rainCount * 6);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaab8c8, transparent: true, opacity: 0.35 }));
    this.rain.frustumCulled = false;
    this.rainSeed = [];
    for (let i = 0; i < this.rainCount; i++) this.rainSeed.push([Math.random() * 60 - 30, Math.random() * 30, Math.random() * 60 - 30]);
    scene.add(this.rain);
    this.rainY = 0;
  }

  emitCar(car, dt, wet, surfaces) {
    const v = Math.abs(car.vx);
    const c = Math.cos(car.yaw), s = Math.sin(car.yaw);
    // spray from rear wheels in the wet
    if (wet > 0.15 && v > 15) {
      const n = Math.min(6, Math.floor(wet * v * dt * 3 + Math.random()));
      for (let k = 0; k < n; k++) {
        const side = Math.random() < 0.5 ? -0.8 : 0.8;
        const x = car.x - c * 2.2 - s * side, z = car.z - s * 2.2 + c * side;
        this.spray.emit(x, 0.4, z, car.vx * c * 0.35 + (Math.random() - 0.5) * 4, 1 + Math.random() * 2, car.vx * s * 0.35 + (Math.random() - 0.5) * 4, 0.9 + Math.random() * 0.6, 1.4 + wet * 1.5);
      }
    }
    // lock-up / wheelspin smoke
    for (let w = 0; w < 4; w++) {
      if ((car.wheelLock?.[w] || car.wheelSpinning?.[w]) && v > 5 && wet < 0.4 && Math.random() < 0.7) {
        const front = w < 2, side = w % 2 ? 0.8 : -0.8;
        const ax = front ? 1.9 : -1.7;
        const x = car.x + c * ax - s * side, z = car.z + s * ax + c * side;
        this.smoke.emit(x, 0.3, z, (Math.random() - 0.5) * 2, 0.5, (Math.random() - 0.5) * 2, 1.4, 0.8);
      }
    }
    // dust/grass/gravel thrown up off track
    if (surfaces && v > 8) {
      for (let w = 2; w < 4; w++) {
        const sf = surfaces[w];
        if ((sf === 2 || sf === 3) && Math.random() < 0.6) {
          const side = w % 2 ? 0.8 : -0.8;
          this.dust.emit(car.x - c * 1.7 - s * side, 0.3, car.z - s * 1.7 + c * side, (Math.random() - 0.5) * 3 - c * v * 0.1, 1 + Math.random() * 2, (Math.random() - 0.5) * 3 - s * v * 0.1, 1.2, 1);
        }
      }
    }
    // sparks when bottoming out
    if (car.bottoming && Math.random() < 0.7) {
      for (let k = 0; k < 3; k++) this.sparks.emit(car.x - c * 1.5, 0.08, car.z - s * 1.5, -c * v * 0.3 + (Math.random() - 0.5) * 6, Math.random() * 3, -s * v * 0.3 + (Math.random() - 0.5) * 6, 0.25 + Math.random() * 0.2, 0.18);
    }
  }

  burstSparks(x, z, strength) {
    const n = Math.min(40, Math.round(strength * 2));
    for (let k = 0; k < n; k++) this.sparks.emit(x, 0.4, z, (Math.random() - 0.5) * 14, Math.random() * 6, (Math.random() - 0.5) * 14, 0.3 + Math.random() * 0.4, 0.2);
    for (let k = 0; k < n / 3; k++) this.smoke.emit(x, 0.5, z, (Math.random() - 0.5) * 3, 1, (Math.random() - 0.5) * 3, 1.6, 1.2);
  }

  update(dt, camera, rain) {
    this.spray.update(dt); this.smoke.update(dt); this.sparks.update(dt); this.dust.update(dt);
    // rain
    this.rain.visible = rain > 0.03;
    if (this.rain.visible) {
      const arr = this.rain.geometry.attributes.position.array;
      this.rainY = (this.rainY + dt * 22) % 30;
      const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      const active = Math.floor(this.rainCount * Math.min(1, rain * 1.2));
      for (let i = 0; i < this.rainCount; i++) {
        const sd = this.rainSeed[i];
        if (i >= active) { arr.fill(0, i * 6, i * 6 + 6); arr[i * 6 + 1] = -100; arr[i * 6 + 4] = -100; continue; }
        const y = ((sd[1] - this.rainY) % 30 + 30) % 30 - 8;
        const x = cx + sd[0], z = cz + sd[2];
        arr[i * 6] = x; arr[i * 6 + 1] = cy + y; arr[i * 6 + 2] = z;
        arr[i * 6 + 3] = x + 0.05; arr[i * 6 + 4] = cy + y - 0.9; arr[i * 6 + 5] = z + 0.05;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
      this.rain.material.opacity = 0.2 + 0.25 * rain;
    }
  }
}
