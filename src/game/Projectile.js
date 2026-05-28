import * as THREE from 'three'

/* ─────────────── shared materials ─────────────── */
const _DRONE_PROJ_MAT  = new THREE.MeshBasicMaterial({ color: 0xff2200 })
const _TRACER_MAT      = new THREE.MeshBasicMaterial({ color: 0xffff44 })
const _HOMING_MAT      = new THREE.MeshBasicMaterial({ color: 0x00eeff })
const TRACER_LEN       = 18   // units

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
   * @param {object} opts  { speed, damage, maxDist }
   */
  constructor(scene, position, target, opts = {}) {
    this.scene    = scene
    this.position = position.clone()
    this.direction = new THREE.Vector3(0, 1, 0)  // start pointing up
    this.target   = target
    this.speed    = opts.speed   || 80
    this.damage   = opts.damage  || 60
    this.maxDist  = opts.maxDist || 600
    this.type     = 'homing'
    this._alive   = true
    this._travelDist = 0

    // Build a small cone mesh pointing in direction of travel
    const geo = new THREE.ConeGeometry(0.25, 2.2, 6)
    this._mesh = new THREE.Mesh(geo, _HOMING_MAT)
    this._mesh.position.copy(this.position)
    scene.add(this._mesh)

    // Exhaust trail: small particle emitter (simple approach)
    this._trail = []
  }

  update(dt) {
    if (!this._alive) return
    const dist = this.speed * dt
    this._travelDist += dist

    // Steer toward live target
    if (this.target && this.target.isAlive()) {
      const toTarget = new THREE.Vector3()
        .subVectors(this.target.getPosition(), this.position)
        .normalize()
      // Lerp direction toward target (turn rate: 3.5 rad/s)
      this.direction.lerp(toTarget, Math.min(dt * 3.5, 1)).normalize()
    }

    this.position.addScaledVector(this.direction, dist)

    if (this._mesh) {
      this._mesh.position.copy(this.position)
      // Orient cone tip toward direction
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.direction)
      this._mesh.quaternion.copy(q)
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
    const m = new HomingMissile(this.scene, position, target, opts)
    this._homing.push(m)
    return m
  }

  update(dt) {
    for (const p of this._list) p.update(dt)
    this._list = this._list.filter(p => p.isAlive())

    for (const m of this._homing) m.update(dt)
    this._homing = this._homing.filter(m => m.isAlive())
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
  }
}

