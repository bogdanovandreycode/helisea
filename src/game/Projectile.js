import * as THREE from 'three'

/* ─────────────── shared materials ─────────────── */
const _DRONE_PROJ_MAT  = new THREE.MeshBasicMaterial({ color: 0xff2200 })
const _TRACER_MAT      = new THREE.MeshBasicMaterial({ color: 0xffff44 })
const _HOMING_MAT      = new THREE.MeshBasicMaterial({ color: 0x00eeff })
const TRACER_LEN       = 18   // units
const _UP             = new THREE.Vector3(0, 1, 0)

/* Homing visual FX tuning */
const SMOKE_POOL_SIZE      = 220
const SMOKE_EMIT_INTERVAL  = 0.032
const SMOKE_MIN_LIFE       = 1.1
const SMOKE_MAX_LIFE       = 1.9

const _tmpDir      = new THREE.Vector3()
const _tmpPos      = new THREE.Vector3()
const _tmpVel      = new THREE.Vector3()
const _tmpQuat     = new THREE.Quaternion()

class SmokePool {
  constructor(scene, maxCount = SMOKE_POOL_SIZE) {
    this.scene = scene
    this._items = []
    this._cursor = 0

    const geo = new THREE.SphereGeometry(0.16, 5, 4)
    for (let i = 0; i < maxCount; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.visible = false
      scene.add(mesh)
      this._items.push({
        mesh,
        vel: new THREE.Vector3(),
        age: 0,
        life: 1,
        baseScale: 0.2,
        active: false,
      })
    }
  }

  emit(position, backDir) {
    let idx = -1
    for (let i = 0; i < this._items.length; i++) {
      const probe = (this._cursor + i) % this._items.length
      if (!this._items[probe].active) {
        idx = probe
        break
      }
    }
    if (idx === -1) idx = this._cursor
    this._cursor = (idx + 1) % this._items.length

    const p = this._items[idx]
    p.active = true
    p.age = 0
    p.life = SMOKE_MIN_LIFE + Math.random() * (SMOKE_MAX_LIFE - SMOKE_MIN_LIFE)
    p.baseScale = 0.18 + Math.random() * 0.16

    p.mesh.visible = true
    p.mesh.position.copy(position)
    p.mesh.position.x += (Math.random() - 0.5) * 0.12
    p.mesh.position.y += (Math.random() - 0.5) * 0.12
    p.mesh.position.z += (Math.random() - 0.5) * 0.12
    p.mesh.scale.setScalar(p.baseScale)

    _tmpVel.copy(backDir).multiplyScalar(1.8 + Math.random() * 1.3)
    _tmpVel.x += (Math.random() - 0.5) * 0.9
    _tmpVel.y += 0.7 + Math.random() * 0.6
    _tmpVel.z += (Math.random() - 0.5) * 0.9
    p.vel.copy(_tmpVel)

    p.mesh.material.opacity = 0.52
  }

  update(dt) {
    const drag = Math.max(0, 1 - dt * 2.2)
    for (const p of this._items) {
      if (!p.active) continue

      p.age += dt
      const t = p.age / p.life
      if (t >= 1) {
        p.active = false
        p.mesh.visible = false
        continue
      }

      p.mesh.position.addScaledVector(p.vel, dt)
      p.vel.multiplyScalar(drag)

      const alpha = Math.pow(1 - t, 1.35) * 0.42
      p.mesh.material.opacity = alpha

      const scale = p.baseScale * (1 + t * 3.2)
      p.mesh.scale.setScalar(scale)
    }
  }

  clear() {
    for (const p of this._items) {
      p.active = false
      p.mesh.visible = false
    }
  }
}

/* ─────────────────────── Projectile ─────────────────────── */
export class Projectile {
  /**
   * @param {THREE.Scene}   scene
   * @param {THREE.Vector3} position
   * @param {THREE.Vector3} direction  (unit vector)
   * @param {object} opts
   *   type    : 'player' | 'cannon' | 'pvo' | 'drone'
   *   speed   : units/s
   *   damage  : hp
   *   maxDist : units before auto-despawn
   */
  constructor(scene, position, direction, opts = {}) {
    this.scene    = scene
    this.type     = opts.type    || 'player'
    this.speed    = opts.speed   || 120
    this.damage   = opts.damage  || 30
    this.maxDist  = opts.maxDist || 600
    this._alive   = true
    this._travelDist = 0

    this.position  = position.clone()
    this.direction = direction.clone().normalize()

    this._mesh = null
  }

  buildMeshSync() {
    if (this.type === 'player' || this.type === 'cannon') {
      // Yellow tracer – thin elongated cylinder along direction
      const len = this.type === 'player' ? TRACER_LEN : TRACER_LEN * 0.7
      const geo = new THREE.CylinderGeometry(0.07, 0.07, len, 4)
      this._mesh = new THREE.Mesh(geo, _TRACER_MAT)
      // Rotate cylinder (default Y-axis) to align with direction
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.direction)
      this._mesh.quaternion.copy(q)
      // Centre the trail: mesh centre is half-trail behind current position
      this._mesh.position.copy(this.position).addScaledVector(this.direction, -len / 2)
      this.scene.add(this._mesh)
      return
    }

    if (this.type === 'drone') {
      this._mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.35, 8, 6),
        _DRONE_PROJ_MAT
      )
      this._mesh.position.copy(this.position)
      this.scene.add(this._mesh)
      return
    }

    // Fallback ball
    this._mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.25, 6, 4),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    )
    this._mesh.position.copy(this.position)
    this.scene.add(this._mesh)
  }

  update(dt) {
    if (!this._alive) return
    const dist = this.speed * dt
    this._travelDist += dist
    this.position.addScaledVector(this.direction, dist)

    if (this._mesh) {
      if (this.type === 'player' || this.type === 'cannon') {
        // Move the tracer cylinder centre forward
        this._mesh.position.addScaledVector(this.direction, dist)
      } else {
        this._mesh.position.copy(this.position)
      }
    }

    if (this._travelDist >= this.maxDist) this.destroy()
  }

  destroy() {
    if (!this._alive) return
    this._alive = false
    if (this._mesh) {
      this.scene.remove(this._mesh)
      this._mesh = null
    }
  }

  isAlive() { return this._alive }
}

/* ─────────────────────── HomingMissile (PVO) ─────────────────────── */
export class HomingMissile {
  /**
   * Self-guiding missile that tracks a drone target.
   * @param {THREE.Scene}   scene
   * @param {THREE.Vector3} position   – fire position
   * @param {Drone}         target     – initial drone target
  * @param {object} opts  { speed, damage, maxDist, launchDirection, steerDelay, turnRate, smokeDuration, smokeBurst }
   */
  constructor(scene, position, target, smokePool, opts = {}) {
    this.scene    = scene
    this.position = position.clone()
    this.direction = opts.launchDirection
      ? opts.launchDirection.clone().normalize()
      : new THREE.Vector3(0, 1, 0)
    this.target   = target
    this._smokePool = smokePool
    this.speed    = opts.speed   || 80
    this.damage   = opts.damage  || 60
    this.maxDist  = opts.maxDist || 600
    this._steerDelay = opts.steerDelay ?? 0.45
    this._turnRate   = opts.turnRate ?? 3.5
    this._smokeDuration = opts.smokeDuration ?? 2.0
    this._smokeBurst    = opts.smokeBurst ?? 1
    this.type     = 'homing'
    this._alive   = true
    this._travelDist = 0
    this._time = 0
    this._smokeCd = 0

    // Build a small cone mesh pointing in direction of travel
    const geo = new THREE.ConeGeometry(0.25, 2.2, 6)
    this._mesh = new THREE.Mesh(geo, _HOMING_MAT)
    this._mesh.position.copy(this.position)
    scene.add(this._mesh)

    // Engine glow (core + soft halo)
    this._engineCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xffe0aa })
    )
    this._engineCore.position.set(0, -1.03, 0)
    this._mesh.add(this._engineCore)

    this._engineHalo = new THREE.Mesh(
      new THREE.SphereGeometry(0.19, 8, 8),
      new THREE.MeshBasicMaterial({
        color: 0xff8a2a,
        transparent: true,
        opacity: 0.62,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    )
    this._engineHalo.position.set(0, -1.07, 0)
    this._mesh.add(this._engineHalo)
  }

  update(dt) {
    if (!this._alive) return
    this._time += dt
    const dist = this.speed * dt
    this._travelDist += dist

    // Steer toward live target
    if (this._time >= this._steerDelay && this.target && this.target.isAlive()) {
      const toTarget = new THREE.Vector3()
        .subVectors(this.target.getPosition(), this.position)
        .normalize()
      // Lerp direction toward target after launch phase.
      this.direction.lerp(toTarget, Math.min(dt * this._turnRate, 1)).normalize()
    }

    this.position.addScaledVector(this.direction, dist)

    if (this._mesh) {
      this._mesh.position.copy(this.position)
      // Orient cone tip toward direction
      _tmpQuat.setFromUnitVectors(_UP, this.direction)
      this._mesh.quaternion.copy(_tmpQuat)

      // Engine flicker for more visible propulsion
      const pulse = 0.92 + 0.16 * Math.sin(this._time * 34)
      this._engineCore.scale.setScalar(pulse)
      this._engineHalo.scale.setScalar(0.9 + 0.22 * Math.sin(this._time * 24 + 0.7))
      this._engineHalo.material.opacity = 0.5 + 0.14 * Math.sin(this._time * 21)
    }

    // Emit pooled white smoke from the engine side (rear of missile)
    if (this._smokePool && this._time <= this._smokeDuration) {
      this._smokeCd -= dt
      while (this._smokeCd <= 0) {
        this._smokeCd += SMOKE_EMIT_INTERVAL
        for (let i = 0; i < this._smokeBurst; i++) {
          _tmpPos.copy(this.position).addScaledVector(this.direction, -1.0)
          _tmpDir.copy(this.direction).multiplyScalar(-1)
          this._smokePool.emit(_tmpPos, _tmpDir)
        }
      }
    }

    if (this._travelDist >= this.maxDist) this.destroy()
  }

  destroy() {
    if (!this._alive) return
    this._alive = false
    if (this._mesh) {
      this.scene.remove(this._mesh)
      this._mesh = null
    }
  }

  isAlive() { return this._alive }
  getPosition() { return this.position }
}

/* ─────────────────────── ProjectileManager ─────────────────────── */
export class ProjectileManager {
  constructor(scene) {
    this.scene   = scene
    this._list   = []   // Projectile[]
    this._homing = []   // HomingMissile[]
    this._smokePool = new SmokePool(scene)
  }

  /**
   * Spawn a regular projectile (player tracer, cannon tracer, drone ball).
   */
  spawn(position, direction, opts = {}) {
    const p = new Projectile(this.scene, position, direction, opts)
    p.buildMeshSync()
    this._list.push(p)
    return p
  }

  /**
   * Spawn a homing PVO missile.
   */
  spawnHoming(position, target, opts = {}) {
    const m = new HomingMissile(this.scene, position, target, this._smokePool, opts)
    this._homing.push(m)
    return m
  }

  update(dt) {
    for (const p of this._list) p.update(dt)
    this._list = this._list.filter(p => p.isAlive())

    for (const m of this._homing) m.update(dt)
    this._homing = this._homing.filter(m => m.isAlive())

    this._smokePool.update(dt)
  }

  /** All live projectiles that can hit drones (player + cannon tracers). */
  allyProjectiles() {
    return this._list.filter(p =>
      (p.type === 'player' || p.type === 'cannon') && p.isAlive()
    )
  }

  /** All live drone projectiles. */
  droneProjectiles() {
    return this._list.filter(p => p.type === 'drone' && p.isAlive())
  }

  /** All live homing missiles. */
  homingProjectiles() {
    return this._homing.filter(m => m.isAlive())
  }

  destroyAll() {
    for (const p of this._list) p.destroy()
    this._list = []
    for (const m of this._homing) m.destroy()
    this._homing = []
    this._smokePool.clear()
  }
}

