import * as THREE from 'three'
import { loadGLB, findNode, findNodes, hideCollision, enableShadows } from './ModelLoader.js'
import { MODELS } from './assets.js'

const _tmp  = new THREE.Vector3()
const _tmp2 = new THREE.Vector3()
const _q    = new THREE.Quaternion()

/* ─────────────── convoy layout ─────────────── */
// Warship at origin.  Cargo ships fanned behind.
const CARGO_OFFSETS = [
  new THREE.Vector3(-100,  0,  120),   // left-rear
  new THREE.Vector3( 100,  0,  120),   // right-rear
  new THREE.Vector3(   0,  0,  260),   // far rear
]

/* ──────────────────── AutoDefense ──────────────────── */
class AutoDefense {
  /**
   * @param {THREE.Scene}        scene
   * @param {THREE.Object3D}     mountNode  – worldspace attach point (CANNON / PVO_LEFT etc)
   * @param {ProjectileManager}  projMgr
   * @param {AudioManager}       audio
   * @param {object} opts
   *   type     : 'cannon' | 'pvo'
   *   range    : max target distance
   *   fireRate : shots / second
   *   damage   : hp per shot
   *   projSpeed: units / second
   *   soundKey : audio key
   */
  constructor(scene, gltfScene, mountNode, projMgr, audio, opts) {
    this.scene    = scene
    this.projMgr  = projMgr
    this.audio    = audio
    this.opts     = opts
    this._cd      = opts.type === 'pvo' ? 10 : 0   // PVO has initial delay
    this._rotating = false

    this._weaponRoot  = mountNode
    this._weaponScene = gltfScene
    mountNode.add(gltfScene)

    this._firingNode = findNode(gltfScene, 'WEAPON')
    this._launchElevation = THREE.MathUtils.degToRad(40)
  }

  update(dt, drones, listenerPos) {
    if (!drones.length) return

    const wPos = new THREE.Vector3()
    this._weaponRoot.getWorldPosition(wPos)

    let nearest = null, nearestDist = Infinity
    for (const d of drones) {
      if (!d.isAlive()) continue
      const dist = d.getPosition().distanceTo(wPos)
      if (dist < this.opts.range && dist < nearestDist) {
        nearestDist = dist
        nearest = d
      }
    }

    if (!nearest) { this._rotating = false; return }

    // Predict target position a bit ahead to reduce misses.
    const targetPos = nearest.getPosition()
    const aimPos = targetPos.clone()
    const targetVel = nearest._velocity
    if (targetVel && targetVel.lengthSq && targetVel.lengthSq() > 0.001) {
      const leadTime = nearestDist / Math.max(this.opts.projSpeed, 1)
      const leadFactor = this.opts.type === 'cannon' ? 0.95 : 0.45
      aimPos.addScaledVector(targetVel, leadTime * leadFactor)
    }

    // Rotate toward target
    _tmp.copy(aimPos).sub(wPos).normalize()
    const targetAngle = Math.atan2(_tmp.x, _tmp.z)
    const curAngle    = this._weaponRoot.rotation.y
    const diff        = targetAngle - curAngle
    const rotSpeed    = this.opts.type === 'cannon' ? 1.5 : 3.5

    const delta = Math.max(-rotSpeed * dt, Math.min(rotSpeed * dt, diff))
    if (Math.abs(delta) > 0.001) {
      this._weaponRoot.rotation.y += delta
      if (!this._rotating) {
        this._rotating = true
        // Rotation SFX intentionally disabled: it produced a loud hum during dive phases.
      }
    } else {
      this._rotating = false
    }

    // Fire
    this._cd -= dt
    if (this._cd <= 0) {
      const fireRate = this.opts.type === 'pvo' ? 30 : 1 / this.opts.fireRate
      this._cd = fireRate

      const firePos = new THREE.Vector3()
      if (this._firingNode) {
        this._firingNode.getWorldPosition(firePos)
      } else {
        this._weaponRoot.getWorldPosition(firePos)
      }

      if (this.opts.type === 'pvo') {
        // Diagonal launch toward target heading, then homing takes over.
        _tmp2.copy(aimPos).sub(firePos)
        _tmp2.y = 0
        if (_tmp2.lengthSq() < 1e-6) {
          this._weaponRoot.getWorldDirection(_tmp2)
          _tmp2.y = 0
        }
        if (_tmp2.lengthSq() < 1e-6) _tmp2.set(0, 0, 1)
        _tmp2.normalize()

        const launchDir = new THREE.Vector3(
          _tmp2.x * Math.cos(this._launchElevation),
          Math.sin(this._launchElevation),
          _tmp2.z * Math.cos(this._launchElevation)
        ).normalize()

        // Homing missile
        this.projMgr.spawnHoming(firePos, nearest, {
          speed:   this.opts.projSpeed,
          damage:  this.opts.damage,
          maxDist: this.opts.range + 100,
          launchDirection: launchDir,
          steerDelay: 0.2,
          turnRate: 5.2,
          smokeDuration: 2.2,
          smokeBurst: 2,
        })
      } else {
        // Cannon tracer
        const dir = new THREE.Vector3()
          .subVectors(aimPos, firePos)
          .normalize()
        this.projMgr.spawn(firePos, dir, {
          type:    'cannon',
          speed:   this.opts.projSpeed,
          damage:  this.opts.damage,
          maxDist: this.opts.range + 50,
        })
      }

      if (listenerPos) {
        this.audio.play3D(this.opts.soundKey, firePos, listenerPos, 400, 1.0)
      } else {
        this.audio.play(this.opts.soundKey, 0.6)
      }
    }
  }
}

/* ──────────────────── Convoy ──────────────────── */
export class Convoy {
  constructor(scene, projMgr, audio) {
    this.scene   = scene
    this.projMgr = projMgr
    this.audio   = audio

    /* warship */
    this.warshipRoot   = null
    this.warshipHP     = 100
    this.warshipMaxHP  = 100
    this.warshipCollision = []   // BVH collision meshes

    /* cargo ships */
    this.cargoRoots    = []
    this.cargoHP       = []
    this.cargoMaxHP    = 100
    this.cargoCollision = []    // [meshes[]] per cargo ship

    /* auto-defenses */
    this._defenses = []

    /* spawn point for helicopter */
    this._helicopterSpawnPos = new THREE.Vector3(0, 15, 0)

    /* internal */
    this._shipNoisePlaying = false
  }

  async init() {
    await Promise.all([
      this._loadWarship(),
      this._loadCargoShips(),
    ])
  }

  async _loadWarship() {
    const [warshipGltf, cannonGltf, pvoGltf] = await Promise.all([
      loadGLB(MODELS.warship),
      loadGLB(MODELS.warshipCannon),
      loadGLB(MODELS.warshipPvo),
    ])

    const body = warshipGltf.scene
    const collMeshes = hideCollision(body)
    enableShadows(body)

    this.warshipRoot = new THREE.Object3D()
    this.warshipRoot.position.set(0, 0, 0)
    this.warshipRoot.add(body)
    this.scene.add(this.warshipRoot)
    this.warshipCollision = collMeshes

    // Helicopter spawn point
    const spawnNode = findNode(body, 'SPANW_HELICOPTER') || findNode(body, 'SPAWN_HELICOPTER')
    if (spawnNode) {
      const wp = new THREE.Vector3()
      spawnNode.getWorldPosition(wp)
      this._helicopterSpawnPos.copy(wp)
      this._helicopterSpawnPos.y += 5  // small offset above deck
    }

    // Cannon
    const cannonNode = findNode(body, 'CANNON')
    if (cannonNode && cannonGltf) {
      const cannonScene = cannonGltf.scene
      hideCollision(cannonScene)
      enableShadows(cannonScene)
      this._defenses.push(new AutoDefense(
        this.scene, cannonScene, cannonNode, this.projMgr, this.audio,
        { type: 'cannon', range: 220, fireRate: 0.4, damage: 50, projSpeed: 90, soundKey: 'cannonFire' }
      ))
    }

    // PVO × 2
    const pvoNodes = [
      findNode(body, 'PVO_LEFT'),
      findNode(body, 'PVO_RIGHT'),
    ]
    for (const pvoNode of pvoNodes) {
      if (!pvoNode || !pvoGltf) continue
      const pvoScene = pvoGltf.scene.clone(true)
      hideCollision(pvoScene)
      enableShadows(pvoScene)
      this._defenses.push(new AutoDefense(
        this.scene, pvoScene, pvoNode, this.projMgr, this.audio,
        { type: 'pvo', range: 360, fireRate: 2.5, damage: 20, projSpeed: 145, soundKey: 'pvoFire' }
      ))
    }
  }

  async _loadCargoShips() {
    const gltf = await loadGLB(MODELS.cargoShip)

    for (let i = 0; i < CARGO_OFFSETS.length; i++) {
      const scene = gltf.scene.clone(true)
      const collMeshes = hideCollision(scene)
      enableShadows(scene)

      const root = new THREE.Object3D()
      root.position.copy(CARGO_OFFSETS[i])
      root.add(scene)
      this.scene.add(root)

      this.cargoRoots.push(root)
      this.cargoHP.push(this.cargoMaxHP)
      this.cargoCollision.push(collMeshes)
    }
  }

  /* ─── accessors ─── */

  getHelicopterSpawnPosition() {
    return this._helicopterSpawnPos.clone()
  }

  getWarshipPosition() {
    const p = new THREE.Vector3()
    if (this.warshipRoot) this.warshipRoot.getWorldPosition(p)
    return p
  }

  getCargoShipPosition(i) {
    const p = new THREE.Vector3()
    if (this.cargoRoots[i]) this.cargoRoots[i].getWorldPosition(p)
    return p
  }

  /** Returns [{position, radius}] for all ships – used by WaveManager. */
  getTargetList() {
    const list = [{
      position: this.getWarshipPosition(),
      radius:   30,
    }]
    for (let i = 0; i < this.cargoRoots.length; i++) {
      list.push({ position: this.getCargoShipPosition(i), radius: 24 })
    }
    return list
  }

  /* ─── damage ─── */

  hitWarship(dmg) {
    this.warshipHP = Math.max(0, this.warshipHP - dmg)
    this.audio.play('shipHit', 0.8)
    const p = this.getWarshipPosition()
    p.y += 10
    this._spawnImpactExplosion(p, 1.8)
  }

  hitCargoShip(i, dmg) {
    this.cargoHP[i] = Math.max(0, this.cargoHP[i] - dmg)
    this.audio.play('shipHit', 0.6)
    const p = this.getCargoShipPosition(i)
    p.y += 8
    this._spawnImpactExplosion(p, 1.5)
    if (this.cargoHP[i] <= 0) this._sinkCargo(i)
  }

  _spawnImpactExplosion(position, intensity = 1) {
    const particleCount = Math.floor(20 * intensity)
    const geo = new THREE.SphereGeometry(0.45 * intensity, 8, 6)
    const particles = []

    for (let i = 0; i < particleCount; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: i % 3 === 0 ? 0xffee99 : 0xff7a2a,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const m = new THREE.Mesh(geo, mat)
      m.position.copy(position)
      m._vel = new THREE.Vector3(
        (Math.random() - 0.5) * (34 * intensity),
        Math.random() * (24 * intensity),
        (Math.random() - 0.5) * (34 * intensity)
      )
      this.scene.add(m)
      particles.push(m)
    }

    // Bright core flash for visibility at long distances.
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(1.2 * intensity, 12, 10),
      new THREE.MeshBasicMaterial({
        color: 0xffd27a,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    )
    flash.position.copy(position)
    this.scene.add(flash)

    let t = 0
    const life = 0.95 + intensity * 0.25
    const tick = () => {
      t += 0.016
      const k = Math.min(t / life, 1)

      flash.scale.setScalar(1 + k * 4.5)
      flash.material.opacity = (1 - k) * 0.8

      for (const p of particles) {
        p.position.addScaledVector(p._vel, 0.016)
        p._vel.y -= 8.5 * 0.016
        p.material.opacity = Math.pow(1 - k, 1.2)
      }

      if (k < 1) {
        requestAnimationFrame(tick)
      } else {
        this.scene.remove(flash)
        for (const p of particles) this.scene.remove(p)
      }
    }
    requestAnimationFrame(tick)
  }

  _sinkCargo(i) {
    const root = this.cargoRoots[i]
    if (!root) return
    // Simple sink animation
    let t = 0
    const tick = () => {
      t += 0.016
      root.position.y -= 0.5
      root.rotation.z += 0.01
      if (t < 2) requestAnimationFrame(tick)
      else this.scene.remove(root)
    }
    requestAnimationFrame(tick)
  }

  isDefeated() {
    return this.warshipHP <= 0
  }

  /* ─── per-frame ─── */

  update(dt, drones, listenerPos) {
    // Auto-defenses
    for (const def of this._defenses) def.update(dt, drones, listenerPos)

    // Ship ambient noise disabled by request.
    if (this._shipNoisePlaying) {
      this.audio.stopLoop('shipNoise')
      this._shipNoisePlaying = false
    }

    // Gentle ship rocking
    const t = performance.now() * 0.001
    if (this.warshipRoot) {
      this.warshipRoot.rotation.z = Math.sin(t * 0.4) * 0.008
      this.warshipRoot.rotation.x = Math.sin(t * 0.3 + 1) * 0.004
    }
    for (let i = 0; i < this.cargoRoots.length; i++) {
      const r = this.cargoRoots[i]
      if (r) {
        r.rotation.z = Math.sin(t * 0.4 + i * 1.3) * 0.01
        r.rotation.x = Math.sin(t * 0.3 + i * 0.8) * 0.005
      }
    }
  }

  reset() {
    this.warshipHP = this.warshipMaxHP
    this.cargoHP   = this.cargoHP.map(() => this.cargoMaxHP)
    this.audio.stopLoop('shipNoise')
    this._shipNoisePlaying = false
    for (const r of this.cargoRoots) {
      if (r) { r.position.y = 0; r.rotation.z = 0 }
    }
  }
}
