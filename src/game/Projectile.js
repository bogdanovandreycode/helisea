import * as THREE from 'three'
import { loadGLB } from './ModelLoader.js'
import { MODELS }  from './assets.js'

/* ─────────────── shared geometry / material ─────────────── */
const _BALL_GEO  = new THREE.SphereGeometry(0.35, 8, 6)
const _DRONE_PROJ_MAT = new THREE.MeshBasicMaterial({ color: 0xff2200 })
const _PVO_PROJ_MAT   = new THREE.MeshBasicMaterial({ color: 0xffffff })
const _CANNON_PROJ_MAT = new THREE.MeshBasicMaterial({ color: 0xffaa00 })

let _missileGltf = null

async function _loadMissile() {
  if (!_missileGltf) {
    _missileGltf = await loadGLB(MODELS.missile)
  }
  // Clone the scene for each instance
  return _missileGltf.scene.clone(true)
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

    this._mesh = null // set in _buildMesh
  }

  async buildMesh() {
    if (this.type === 'player') {
      this._mesh = await _loadMissile()
      this._mesh.scale.setScalar(0.6)
      // Orient missile along velocity
      const q = new THREE.Quaternion()
      q.setFromUnitVectors(new THREE.Vector3(0, 0, -1), this.direction)
      this._mesh.quaternion.copy(q)
    } else {
      // Simple ball for other types
      let mat
      if      (this.type === 'cannon') mat = _CANNON_PROJ_MAT
      else if (this.type === 'pvo')    mat = _PVO_PROJ_MAT
      else                             mat = _DRONE_PROJ_MAT

      const scale = this.type === 'cannon' ? 1.2 : 0.35
      this._mesh = new THREE.Mesh(
        new THREE.SphereGeometry(scale, 8, 6),
        mat
      )
    }
    this._mesh.position.copy(this.position)
    this.scene.add(this._mesh)
  }

  /** Synchronous mesh creation (for drones / pvo / cannon – no model needed). */
  buildMeshSync() {
    let mat, r
    if      (this.type === 'cannon') { mat = _CANNON_PROJ_MAT; r = 0.5 }
    else if (this.type === 'pvo')    { mat = _PVO_PROJ_MAT;    r = 0.25 }
    else                             { mat = _DRONE_PROJ_MAT;  r = 0.35 }

    this._mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat)
    this._mesh.position.copy(this.position)
    this.scene.add(this._mesh)
  }

  update(dt) {
    if (!this._alive) return
    const dist = this.speed * dt
    this._travelDist += dist
    this.position.addScaledVector(this.direction, dist)
    if (this._mesh) this._mesh.position.copy(this.position)
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

/* ─────────────────────── ProjectileManager ─────────────────────── */
export class ProjectileManager {
  constructor(scene) {
    this.scene = scene
    this._list = []
  }

  /**
   * Spawn a projectile.
   * Player missiles use async buildMesh(); others use sync.
   */
  spawn(position, direction, opts = {}) {
    const p = new Projectile(this.scene, position, direction, opts)
    if (opts.type === 'player') {
      p.buildMesh()          // async, mesh appears after a frame
    } else {
      p.buildMeshSync()
    }
    this._list.push(p)
    return p
  }

  update(dt) {
    for (const p of this._list) p.update(dt)
    // Remove dead projectiles
    const dead = this._list.filter(p => !p.isAlive())
    for (const p of dead) p.destroy()
    this._list = this._list.filter(p => p.isAlive())
  }

  /** Returns all live projectiles of a given type. */
  ofType(type) { return this._list.filter(p => p.type === type && p.isAlive()) }

  /** Returns all live projectiles that could hit enemies (player + defense). */
  allyProjectiles() {
    return this._list.filter(p => (p.type === 'player' || p.type === 'cannon' || p.type === 'pvo') && p.isAlive())
  }

  /** Returns all live drone projectiles. */
  droneProjectiles() {
    return this._list.filter(p => p.type === 'drone' && p.isAlive())
  }

  destroyAll() {
    for (const p of this._list) p.destroy()
    this._list = []
  }
}
