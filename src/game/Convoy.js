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

const CARGO_SINK_DURATION = 8.5
const CARGO_SINK_DEPTH = 26

function optimizeShipMaterials(root) {
  root.traverse(obj => {
    if (!obj.isMesh || !obj.material) return

    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const material of materials) {
      if (!material) continue

      // Ship hull meshes are closed surfaces, so double-sided rendering
      // only increases the chance of visual artifacts on shallow angles.
      material.side = THREE.FrontSide

      if (material.map) {
        material.map.anisotropy = 16
        material.map.generateMipmaps = false
        material.map.minFilter = THREE.LinearFilter
        material.map.magFilter = THREE.LinearFilter
        material.map.needsUpdate = true
      }

      material.needsUpdate = true
    }
  })
}

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

  update(dt, drones, listenerPos, reservedTargets = null) {
    if (!drones.length) return

    const wPos = new THREE.Vector3()
    this._weaponRoot.getWorldPosition(wPos)

    let nearest = null
    let nearestDist = Infinity
    let fallbackTarget = null
    let fallbackDist = Infinity

    for (const d of drones) {
      if (!d.isAlive()) continue
      const dist = d.getPosition().distanceTo(wPos)
      if (dist >= this.opts.range) continue

      if (dist < fallbackDist) {
        fallbackDist = dist
        fallbackTarget = d
      }

      if (reservedTargets?.has(d)) continue

      if (dist < nearestDist) {
        nearestDist = dist
        nearest = d
      }
    }

    if (!nearest && fallbackTarget) {
      nearest = fallbackTarget
      nearestDist = fallbackDist
    }

    if (!nearest) { this._rotating = false; return }

    if (reservedTargets) reservedTargets.add(nearest)

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
    this._cargoSinkStates = []

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
    optimizeShipMaterials(body)
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
      optimizeShipMaterials(scene)
      enableShadows(scene)

      const root = new THREE.Object3D()
      root.position.copy(CARGO_OFFSETS[i])
      root.add(scene)
      this.scene.add(root)

      this.cargoRoots.push(root)
      this.cargoHP.push(this.cargoMaxHP)
      this.cargoCollision.push(collMeshes)
      this._cargoSinkStates.push(this._createCargoSinkState())
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

  /** Returns prioritized alive targets: cargo first, then warship. */
  getTargetList() {
    const list = []

    for (let i = 0; i < this.cargoRoots.length; i++) {
      if (this.cargoRoots[i] && this.cargoHP[i] > 0) {
        list.push({
          position: this.getCargoShipPosition(i),
          radius: 24,
          type: 'cargo',
          alive: true,
          index: i,
        })
      }
    }

    if (this.warshipRoot && this.warshipHP > 0) {
      list.push({
        position: this.getWarshipPosition(),
        radius: 30,
        type: 'warship',
        alive: true,
      })
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
    const state = this._cargoSinkStates[i] || this._createCargoSinkState()
    if (state.active || state.completed) return

    state.active = true
    state.elapsed = 0
    state.startY = root.position.y
    state.startX = root.rotation.x
    state.startZ = root.rotation.z
    state.sinkDepth = CARGO_SINK_DEPTH + Math.random() * 8
    state.rollTarget = THREE.MathUtils.degToRad(18 + Math.random() * 10) * state.rollDir
    state.pitchTarget = THREE.MathUtils.degToRad(-4 - Math.random() * 5)
    state.duration = CARGO_SINK_DURATION + Math.random() * 1.5
    state.hideDelay = 1.2

    this._cargoSinkStates[i] = state
  }

  _createCargoSinkState() {
    return {
      active: false,
      completed: false,
      elapsed: 0,
      duration: CARGO_SINK_DURATION,
      hideDelay: 0,
      startY: 0,
      startX: 0,
      startZ: 0,
      sinkDepth: CARGO_SINK_DEPTH,
      rollTarget: 0,
      pitchTarget: 0,
      rollDir: Math.random() < 0.5 ? -1 : 1,
    }
  }

  isDefeated() {
    return this.warshipHP <= 0
  }

  /* ─── per-frame ─── */

  update(dt, drones, listenerPos) {
    // Auto-defenses
    const reservedPvoTargets = new Set()
    for (const def of this._defenses) {
      const reservedTargets = def.opts.type === 'pvo' ? reservedPvoTargets : null
      def.update(dt, drones, listenerPos, reservedTargets)
    }

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
      const sink = this._cargoSinkStates[i]
      if (r) {
        if (sink?.active) {
          sink.elapsed += dt
          const phase = Math.min(sink.elapsed / sink.duration, 1)
          const eased = 1 - Math.pow(1 - phase, 2.4)
          const wobbleFade = 1 - phase

          r.position.y = sink.startY - sink.sinkDepth * eased
          r.rotation.z =
            sink.startZ +
            sink.rollTarget * eased +
            Math.sin(t * 1.7 + i * 0.9) * 0.02 * wobbleFade
          r.rotation.x =
            sink.startX +
            sink.pitchTarget * eased +
            Math.sin(t * 1.2 + i * 0.6) * 0.01 * wobbleFade

          if (phase >= 1) {
            sink.active = false
            sink.completed = true
            sink.elapsed = 0
            r.visible = false
          }
        } else if (sink?.completed) {
          sink.elapsed += dt
          if (sink.elapsed >= sink.hideDelay) {
            r.position.y = sink.startY - sink.sinkDepth
          }
        } else {
          r.rotation.z = Math.sin(t * 0.4 + i * 1.3) * 0.01
          r.rotation.x = Math.sin(t * 0.3 + i * 0.8) * 0.005
          r.position.y = CARGO_OFFSETS[i].y
        }
      }
    }
  }

  reset() {
    this.warshipHP = this.warshipMaxHP
    this.cargoHP   = this.cargoHP.map(() => this.cargoMaxHP)
    this.audio.stopLoop('shipNoise')
    this._shipNoisePlaying = false
    for (let i = 0; i < this.cargoRoots.length; i++) {
      const r = this.cargoRoots[i]
      const sink = this._cargoSinkStates[i] || this._createCargoSinkState()
      this._cargoSinkStates[i] = this._createCargoSinkState()
      if (r) {
        r.visible = true
        r.position.copy(CARGO_OFFSETS[i])
        r.rotation.set(0, 0, 0)
      }
    }
  }
}
