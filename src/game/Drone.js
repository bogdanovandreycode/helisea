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
    this.hp           = 100
    this._alive       = true
    this._fireCooldown = 1 + Math.random() * 2   // stagger first shot
    this._noiseTimer   = 0

    /* physics */
    this.position = spawnPos.clone()
    this._velocity = new THREE.Vector3()
    this._target   = null   // {position: Vector3, radius: number}

    /* 3-D objects */
    this.root = new THREE.Object3D()
    this.root.position.copy(spawnPos)
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

    // Attach rotor to VINT empty
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

  /** Call every frame. dt in seconds. */
  update(dt) {
    if (!this._alive) return

    this._updateMovement(dt)
    this._updateFire(dt)
    this._spinRotor(dt)

    // Sync root position
    this.root.position.copy(this.position)
  }

  _updateMovement(dt) {
    if (!this._target) return

    const targetPos = this._target.position

    // Direction to target (horizontal + slight vertical)
    _tmp.copy(targetPos).sub(this.position)
    const distH = Math.sqrt(_tmp.x * _tmp.x + _tmp.z * _tmp.z)
    const distFull = _tmp.length()

    // Attack speed ramps up as drone closes in
    const speed = distFull < 80 ? 22 : 14

    if (distH < this._target.radius + 5) {
      // Close – circle the target
      const angle = Math.atan2(this.position.z - targetPos.z, this.position.x - targetPos.x)
      const circleSpeed = 0.6
      this.position.x = targetPos.x + Math.cos(angle + circleSpeed * dt) * (this._target.radius + 8)
      this.position.z = targetPos.z + Math.sin(angle + circleSpeed * dt) * (this._target.radius + 8)
      this.position.y += (targetPos.y + 15 - this.position.y) * 2 * dt
    } else {
      // Fly toward target
      const dir = _tmp.normalize()
      this._velocity.lerp(dir.multiplyScalar(speed), 3 * dt)
      this.position.addScaledVector(this._velocity, dt)
    }

    // Face velocity direction
    if (this._velocity.lengthSq() > 0.01) {
      const fwd = this._velocity.clone().normalize()
      const angle = Math.atan2(fwd.x, fwd.z)
      this.root.rotation.y = angle
      // Bank when turning
      this.root.rotation.z = -this._velocity.x * 0.04
    }
  }

  _updateFire(dt) {
    this._fireCooldown -= dt
    if (this._fireCooldown > 0 || !this._target) return
    this._fireCooldown = 1.8 + Math.random()

    // Fire toward target
    const dir = new THREE.Vector3()
      .subVectors(this._target.position, this.position)
      .normalize()

    this.projMgr.spawn(this.position.clone(), dir, {
      type:    'drone',
      speed:   55,
      damage:  15,
      maxDist: 300,
    })
  }

  _spinRotor(dt) {
    if (this._vint) this._vint.rotation.y += this._vintSpd * dt
  }

  /** Returns approximate bounding-sphere radius for collision. */
  getRadius() { return 5 }

  getPosition() { return this.position }

  isAlive() { return this._alive }

  hit(damage) {
    if (!this._alive) return
    this.hp -= damage
    // Flash white on hit
    this.root.traverse(obj => {
      if (obj.isMesh && obj.material) {
        const origColor = obj.material.color?.clone()
        obj.material.emissive?.set(0xffffff)
        setTimeout(() => { if (obj.material) obj.material.emissive?.set(0x000000) }, 80)
      }
    })
    if (this.hp <= 0) this._die()
  }

  _die() {
    this._alive = false
    // Simple death: spawn burst particles then remove
    this._spawnExplosion()
    this.scene.remove(this.root)
  }

  _spawnExplosion() {
    const geo = new THREE.SphereGeometry(0.3, 6, 4)
    const mat = new THREE.MeshBasicMaterial({ color: 0xff6600 })
    const count = 12
    const particles = []

    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, mat.clone())
      m.position.copy(this.position)
      m._vel = new THREE.Vector3(
        (Math.random() - 0.5) * 20,
        Math.random() * 14,
        (Math.random() - 0.5) * 20
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
        p.material.opacity = 1 - t / 0.6
        p.material.transparent = true
      }
      if (t < 0.6) requestAnimationFrame(tick)
      else particles.forEach(p => this.scene.remove(p))
    }
    requestAnimationFrame(tick)
  }
}
