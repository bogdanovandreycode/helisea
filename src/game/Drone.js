import * as THREE from 'three'
import { loadGLB, findNode, hideCollision, enableShadows } from './ModelLoader.js'
import { MODELS } from './assets.js'

const _tmp = new THREE.Vector3()

/* Shared GLTF references – loaded once, cloned per instance */
let _bodyGltf = null
let _vintGltf = null

export async function preloadDroneAssets() {
  ;[_bodyGltf, _vintGltf] = await Promise.all([
    loadGLB(MODELS.droneBody),
    loadGLB(MODELS.droneVint),
  ])
}

/* Behaviour phases */
const PHASE_CRUISE = 'cruise'   // high-altitude approach
const PHASE_DIVE   = 'dive'     // parabolic kamikaze dive toward ship

const CRUISE_ALT     = 65       // units above sea
const DIVE_START_DIST = 180     // horizontal dist to target at which dive begins
const DIVE_DURATION  = 5.0      // seconds from start of dive to impact

/* ─────────────────────── Drone ─────────────────────── */
export class Drone {
  /**
   * @param {THREE.Scene}   scene
   * @param {THREE.Vector3} spawnPos
   * @param {ProjectileManager} projMgr
   * @param {AudioManager}  audio
   */
  constructor(scene, spawnPos, projMgr, audio) {
    this.scene   = scene
    this.projMgr = projMgr
    this.audio   = audio

    /* state */
    this.hp            = 100
    this._alive        = true
    this._fireCooldown = 1 + Math.random() * 2   // stagger first shot
    this._phase        = PHASE_CRUISE

    /* dive state */
    this._diveStart    = null
    this._diveTarget   = null   // world XZ impact point
    this._diveT        = 0

    /* physics */
    this.position = spawnPos.clone()
    this.position.y = CRUISE_ALT + (Math.random() - 0.5) * 10  // start at cruise alt
    this._velocity = new THREE.Vector3()
    this._target   = null   // {position: Vector3, radius: number}

    /* 3-D objects */
    this.root = new THREE.Object3D()
    this.root.position.copy(this.position)
    this._vint    = null
    this._vintSpd = 6 + Math.random() * 4
    scene.add(this.root)
  }

  /** Build scene graph from cloned GLTFs (call right after constructor). */
  buildMesh() {
    if (!_bodyGltf || !_vintGltf) return

    const body = _bodyGltf.scene.clone(true)
    hideCollision(body)
    enableShadows(body)
    this.root.add(body)

    const vintNode = findNode(body, 'VINT')
    if (vintNode) {
      const vint = _vintGltf.scene.clone(true)
      hideCollision(vint)
      enableShadows(vint)
      vintNode.add(vint)
      this._vint = vint
    }
  }

  /** Set the convoy target for this drone. */
  setTarget(targetPos, targetRadius = 25) {
    this._target = { position: targetPos, radius: targetRadius }
  }

  /** Call every frame. dt in seconds. heliPos is the player helicopter world position. */
  update(dt, heliPos) {
    if (!this._alive) return

    this._updateMovement(dt)
    // Drones are kamikaze-only in this mode: no ranged attacks.
    this._spinRotor(dt)

    this.root.position.copy(this.position)
  }

  _updateMovement(dt) {
    if (!this._target) return

    if (this._phase === PHASE_CRUISE) {
      this._cruiseUpdate(dt)
    } else {
      this._diveUpdate(dt)
    }

    // Face velocity direction
    if (this._velocity.lengthSq() > 0.01) {
      const fwd = this._velocity.clone().normalize()
      this.root.rotation.y = Math.atan2(fwd.x, fwd.z)
      this.root.rotation.x = Math.asin(Math.max(-1, Math.min(1, -fwd.y * 0.6)))
      this.root.rotation.z = -this._velocity.x * 0.03
    }
  }

  _cruiseUpdate(dt) {
    const targetPos = this._target.position
    _tmp.copy(targetPos).sub(this.position)
    _tmp.y = 0
    const distH = _tmp.length()

    // Begin dive when close enough
    if (distH < DIVE_START_DIST) {
      this._phase      = PHASE_DIVE
      this._diveStart  = this.position.clone()
      this._diveT      = 0
      // Random scatter around target center
      const scatter = (this._target.radius * 0.5)
      this._diveTarget = new THREE.Vector3(
        targetPos.x + (Math.random() - 0.5) * scatter,
        targetPos.y,
        targetPos.z + (Math.random() - 0.5) * scatter
      )
      return
    }

    // Fly slowly toward general area at cruise altitude
    _tmp.normalize()
    const cruiseDir = new THREE.Vector3(_tmp.x, 0, _tmp.z)
    // Altitude correction
    const altError = (CRUISE_ALT - this.position.y)
    const cruiseSpeed = 12
    this._velocity.lerp(
      new THREE.Vector3(cruiseDir.x * cruiseSpeed, altError * 1.5, cruiseDir.z * cruiseSpeed),
      4 * dt
    )
    this.position.addScaledVector(this._velocity, dt)
  }

  _diveUpdate(dt) {
    this._diveT += dt / DIVE_DURATION
    const t = Math.min(this._diveT, 1)

    // Horizontal: linear interpolation toward impact point
    this.position.x = this._diveStart.x + (this._diveTarget.x - this._diveStart.x) * t
    this.position.z = this._diveStart.z + (this._diveTarget.z - this._diveStart.z) * t

    // Vertical: quadratic ease-in (slow at top, fast at bottom)
    const h0 = this._diveStart.y
    const h1 = this._diveTarget.y + 4
    this.position.y = h0 + (h1 - h0) * (t * t)

    // Derive velocity for rotation
    this._velocity.set(
      (this._diveTarget.x - this._diveStart.x) / DIVE_DURATION,
      (h1 - h0) * 2 * t / DIVE_DURATION,
      (this._diveTarget.z - this._diveStart.z) / DIVE_DURATION
    )

    if (t >= 1) {
      // Self-destruct at impact point (collision code handles ship damage)
      this._die()
    }
  }

  _updateFire(dt, heliPos) {
    // Intentionally disabled.
  }

  _spinRotor(dt) {
    if (this._vint) this._vint.rotation.y += this._vintSpd * dt
  }

  getRadius() { return 5 }
  getPosition() { return this.position }
  isAlive() { return this._alive }

  hit(damage) {
    if (!this._alive) return
    this.hp -= damage
    this.root.traverse(obj => {
      if (obj.isMesh && obj.material?.emissive) {
        obj.material.emissive.set(0xffffff)
        setTimeout(() => { if (obj.material) obj.material.emissive?.set(0x000000) }, 80)
      }
    })
    if (this.hp <= 0) this._die()
  }

  _die() {
    if (!this._alive) return
    this._alive = false
    this._spawnExplosion()
    this.scene.remove(this.root)
  }

  _spawnExplosion() {
    const geo = new THREE.SphereGeometry(0.3, 6, 4)
    const mat = new THREE.MeshBasicMaterial({ color: 0xff6600 })
    const particles = []

    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(geo, mat.clone())
      m.position.copy(this.position)
      m._vel = new THREE.Vector3(
        (Math.random() - 0.5) * 22,
        Math.random() * 16,
        (Math.random() - 0.5) * 22
      )
      this.scene.add(m)
      particles.push(m)
    }

    let t = 0
    const tick = () => {
      t += 0.016
      for (const p of particles) {
        p.position.addScaledVector(p._vel, 0.016)
        p._vel.y -= 9.8 * 0.016
        p.material.opacity = 1 - t / 0.7
        p.material.transparent = true
      }
      if (t < 0.7) requestAnimationFrame(tick)
      else particles.forEach(p => this.scene.remove(p))
    }
    requestAnimationFrame(tick)
  }
}

