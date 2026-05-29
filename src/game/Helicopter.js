import * as THREE from 'three'
import { loadGLB, findNode, hideCollision, enableShadows, setShadowMode } from './ModelLoader.js'
import { MODELS } from './assets.js'
import { LIGHTING_PRESETS } from './World.js'

const _PI2  = Math.PI * 2
const _HALF = Math.PI / 2
const CAMERA_FORWARD_OFFSET = Math.PI

/* Flight tuning */
const MOVE_SPEED   = 30    // units/s horizontal
const CLIMB_SPEED  = 12    // units/s vertical
const MOUSE_SENS   = 0.0018 // radians per pixel
const TILT_AMOUNT  = 0.22  // body tilt on move (rad)
const ROTOR_SPEED  = 12    // rad/s
const MIN_ALTITUDE = 4
const MAX_ALTITUDE = 180
const ENGINE_RATE_BASE = 1.0
const ENGINE_RATE_MIN  = 0.86
const ENGINE_RATE_MAX  = 1.28
const COCKPIT_LIGHT_LAYER = 1
const COCKPIT_GLOW_COLOR = 0x66ffcc

/* Weapon */
const FIRE_RATE    = 0.14  // seconds between shots
const SUPPLIES_MAX = 100

/* Resource system */
const FUEL_MAX       = 120                // seconds of flight
const FUEL_DRAIN_SEC = FUEL_MAX / 120     // 2 minutes total
const FUEL_FILL_SEC  = FUEL_MAX / 4       // full refuel in ~4s
const SUPPLIES_FILL  = 42                 // units/sec at spawn zone

export class Helicopter {
  /**
   * @param {THREE.Scene}        scene
   * @param {THREE.PerspectiveCamera} camera
   * @param {ProjectileManager}  projMgr
   * @param {AudioManager}       audio
   */
  constructor(scene, camera, projMgr, audio) {
    this.scene   = scene
    this.camera  = camera
    this.projMgr = projMgr
    this.audio   = audio

    /* orientation */
    this._yaw   = 0    // world-space heading (radians, around Y)
    this._pitch = 0    // extra camera look-up/down (radians)
    this._cameraYaw = 0

    /* state */
    this.hp        = 100
    this.supplies  = SUPPLIES_MAX
    this.fuel      = FUEL_MAX
    this._fireCd   = 0
    this._fireAlt  = false   // alternate left/right
    this._alive    = true
    this._respawnTimer = 0

    /* 3-D hierarchy */
    this.root        = new THREE.Object3D()  // yaw pivot
    this.prevPosition = new THREE.Vector3()
    this._bodyScene  = null
    this._vint       = null
    this._cameraNode = null
    this._cameraBaseRotation = new THREE.Euler()
    this._weaponL    = null
    this._weaponR    = null
    this._freeLookActive = false
    this._freeLookRestorePitch = 0
    this._freeLookRestoreYaw = 0
    this._cockpitNode = null
    this._glassNode = null
    this._cockpitLight = null
    this._cockpitMaterials = []
    this._timeOfDay = 'night'

    /* smoothed tilt */
    this._tiltX = 0  // pitch tilt of body
    this._tiltZ = 0  // roll tilt of body
    this._engineRate = ENGINE_RATE_BASE

    scene.add(this.root)
  }

  async init() {
    const [bodyGltf, vintGltf] = await Promise.all([
      loadGLB(MODELS.heliBody),
      loadGLB(MODELS.heliVint),
    ])

    /* body */
    this._bodyScene = bodyGltf.scene
    this._collisionMeshes = hideCollision(this._bodyScene)
    enableShadows(this._bodyScene)
    setShadowMode(this._bodyScene, { castShadow: false, receiveShadow: true })
    this.root.add(this._bodyScene)

    /* rotor – attach to VINT node */
    const vintNode = findNode(this._bodyScene, 'VINT')
    if (vintNode) {
      const vint = vintGltf.scene
      hideCollision(vint)
      enableShadows(vint)
      setShadowMode(vint, { castShadow: false, receiveShadow: true })
      vintNode.add(vint)
      this._vint = vint
    }

    /* camera – find CAMERA node; will be attached in reset() */
    const camNode = findNode(this._bodyScene, 'CAMERA')
    if (camNode) {
      this._cameraNode = camNode
    } else {
      // Fallback: use root as camera parent
      this._cameraNode = this.root
    }
    this._cameraBaseRotation.copy(this._cameraNode.rotation)
    this.camera.layers.enable(COCKPIT_LIGHT_LAYER)

    /* weapon mounts */
    this._weaponL = findNode(this._bodyScene, 'WEAPON_LEFT')
    this._weaponR = findNode(this._bodyScene, 'WEAPON_RIGHT')

    this._cockpitNode = findNode(this._bodyScene, 'MD_501:Cockpit')
    this._glassNode = findNode(this._bodyScene, 'MD_501:Glass')
    this._configureCabinMaterials()
    this._setupCockpitLight()
    this.setTimeOfDay(this._timeOfDay)
  }

  setPosition(pos) {
    this.root.position.copy(pos)
  }

  getPosition() {
    const p = new THREE.Vector3()
    this.root.getWorldPosition(p)
    return p
  }

  // Backward-compat for existing HUD/state wiring.
  get ammo() { return Math.floor(this.supplies) }

  isAlive() { return this._alive }

  /* ─────────────── input & update ─────────────── */

  /**
   * @param {number}  dt  seconds
   * @param {Set}     keys  set of pressed KeyboardEvent.codes
   * @param {object}  mouseDelta  {dx, dy}  accumulated mouse movement
   * @param {boolean} firing  left mouse button held
   * @param {boolean} inRefillZone near helicopter spawn refill zone
   * @param {boolean} freeLook Ctrl-held camera freelook mode
   */
  update(dt, keys, mouseDelta, firing, inRefillZone = false, freeLook = false) {
    if (!this._alive) {
      this._respawnTimer -= dt
      if (this._respawnTimer <= 0) this._respawn()
      return
    }

    this.prevPosition.copy(this.root.position)

    // Fuel drains during flight; both resources refill near spawn.
    if (inRefillZone) {
      this.fuel = Math.min(FUEL_MAX, this.fuel + FUEL_FILL_SEC * dt)
      this.supplies = Math.min(SUPPLIES_MAX, this.supplies + SUPPLIES_FILL * dt)
    } else {
      this.fuel = Math.max(0, this.fuel - FUEL_DRAIN_SEC * dt)
    }

    if (freeLook && !this._freeLookActive) {
      this._freeLookActive = true
      this._freeLookRestorePitch = this._pitch
      this._freeLookRestoreYaw = this._cameraYaw
    } else if (!freeLook && this._freeLookActive) {
      this._freeLookActive = false
      this._pitch = this._freeLookRestorePitch
      this._cameraYaw = this._freeLookRestoreYaw
    }

    /* ── yaw from mouse X ── */
    if (this._freeLookActive) {
      this._cameraYaw -= mouseDelta.dx * MOUSE_SENS
      this._cameraYaw = Math.max(-_HALF, Math.min(_HALF, this._cameraYaw))
    } else {
      this._yaw -= mouseDelta.dx * MOUSE_SENS
      this.root.rotation.y = this._yaw
      this._cameraYaw = 0
    }

    /* ── camera pitch from mouse Y ── */
    this._pitch += mouseDelta.dy * MOUSE_SENS
    this._pitch = Math.max(-_HALF * 0.9, Math.min(_HALF * 0.6, this._pitch))
    if (this._cameraNode) {
      this._cameraNode.rotation.x = this._cameraBaseRotation.x + this._pitch
      this._cameraNode.rotation.y = this._cameraBaseRotation.y + CAMERA_FORWARD_OFFSET + this._cameraYaw
      this._cameraNode.rotation.z = this._cameraBaseRotation.z
    }

    /* ── movement ── */
    const fwd  = new THREE.Vector3( Math.sin(this._yaw), 0,  Math.cos(this._yaw))
    const right = new THREE.Vector3( Math.cos(this._yaw), 0, -Math.sin(this._yaw))

    let dx = 0, dz = 0, dy = 0
    let moveForward = 0
    let moveStrafe = 0
    if (this.fuel > 0) {
      if (keys.has('KeyW')) moveForward += 1
      if (keys.has('KeyS')) moveForward -= 1
      if (keys.has('KeyD')) moveStrafe += 1
      if (keys.has('KeyA')) moveStrafe -= 1
      if (keys.has('Space'))      dy =  1
      if (keys.has('ShiftLeft') || keys.has('ShiftRight')) dy = -1
    }

    dx += fwd.x * moveForward
    dz += fwd.z * moveForward
    dx -= right.x * moveStrafe
    dz -= right.z * moveStrafe

    this.root.position.x += dx * MOVE_SPEED * dt
    this.root.position.z += dz * MOVE_SPEED * dt
    this.root.position.y  = Math.max(
      MIN_ALTITUDE,
      Math.min(MAX_ALTITUDE, this.root.position.y + dy * CLIMB_SPEED * dt)
    )

    const horizontalSpeed = dt > 0
      ? Math.hypot(this.root.position.x - this.prevPosition.x, this.root.position.z - this.prevPosition.z) / dt
      : 0
    const verticalSpeed = dt > 0
      ? (this.root.position.y - this.prevPosition.y) / dt
      : 0
    const moveFactor = Math.min(horizontalSpeed / MOVE_SPEED, 1)
    const climbFactor = Math.max(0, verticalSpeed / CLIMB_SPEED)
    const descendFactor = Math.max(0, -verticalSpeed / CLIMB_SPEED)
    const targetEngineRate = THREE.MathUtils.clamp(
      ENGINE_RATE_BASE + moveFactor * 0.1 + climbFactor * 0.16 - descendFactor * 0.12,
      ENGINE_RATE_MIN,
      ENGINE_RATE_MAX
    )
    this._engineRate += (targetEngineRate - this._engineRate) * Math.min(dt * 4, 1)
    this.audio.setLoopPlaybackRate('helicopterNoise', this._engineRate)

    /* ── body tilt (visual) ── */
    const targetTiltX = moveForward * TILT_AMOUNT   // pitch forward/back in local heli space
    const targetTiltZ = moveStrafe * TILT_AMOUNT   // roll left/right in local heli space
    const lerpRate = 5 * dt
    this._tiltX += (targetTiltX - this._tiltX) * lerpRate
    this._tiltZ += (targetTiltZ - this._tiltZ) * lerpRate
    if (this._bodyScene) {
      this._bodyScene.rotation.x = this._tiltX
      this._bodyScene.rotation.z = this._tiltZ
    }

    /* ── rotor spin ── */
    if (this._vint) this._vint.rotation.y += ROTOR_SPEED * dt

    /* ── fire ── */
    this._fireCd -= dt
    if (firing && this._fireCd <= 0 && this.supplies > 0 && this.fuel > 0) {
      this._fire()
    }
  }

  _fire() {
    this._fireCd = FIRE_RATE
    this.supplies = Math.max(0, this.supplies - 1)

    /* Get world-space position & direction of camera */
    const dir = new THREE.Vector3()
    this.camera.getWorldDirection(dir)

    /* Alternate left / right weapon */
    const wNode = this._fireAlt ? this._weaponR : this._weaponL
    this._fireAlt = !this._fireAlt

    const pos = new THREE.Vector3()
    if (wNode) {
      wNode.getWorldPosition(pos)
    } else {
      this.camera.getWorldPosition(pos)
    }

    this.projMgr.spawn(pos, dir, {
      type:    'player',
      speed:   160,
      damage:  40,
      maxDist: 600,
    })

    this.audio.play('cannonFire', 0.5)
  }

  hit(damage) {
    if (!this._alive) return
    this.hp = Math.max(0, this.hp - damage)
    this.audio.play('playerHit', 0.8)
    if (this.hp <= 0) this._crash()
  }

  _crash() {
    this._alive      = false
    this._respawnTimer = 5
    // Detach camera so it stays visible during respawn countdown
    if (this._cameraNode) {
      const worldPos = new THREE.Vector3()
      const worldQuat = new THREE.Quaternion()
      this.camera.getWorldPosition(worldPos)
      this.camera.getWorldQuaternion(worldQuat)
      this._cameraNode.remove(this.camera)
      this.scene.add(this.camera)
      this.camera.position.copy(worldPos)
      this.camera.quaternion.copy(worldQuat)
    }
    this.root.visible = false
  }

  _respawn() {
    this._alive = true
    this.hp     = 100
    this.supplies = SUPPLIES_MAX
    this.fuel = FUEL_MAX
    this.root.visible = true
    this._engineRate = ENGINE_RATE_BASE
    this.audio.setLoopPlaybackRate('helicopterNoise', this._engineRate)

    // Re-attach camera
    if (this._cameraNode) {
      this.scene.remove(this.camera)
      this._cameraNode.add(this.camera)
      this.camera.position.set(0, 0, 0)
      this.camera.rotation.set(0, 0, 0)
      this._cameraYaw = 0
    }
  }

  reset(spawnPos) {
    this.hp     = 100
    this.supplies = SUPPLIES_MAX
    this.fuel = FUEL_MAX
    this._alive = true
    this._yaw   = 0
    this._pitch = 0
    this._cameraYaw = 0
    this._engineRate = ENGINE_RATE_BASE
    this._freeLookActive = false
    this._freeLookRestorePitch = 0
    this._freeLookRestoreYaw = 0
    this.root.visible = true
    this.root.rotation.set(0, 0, 0)
    if (spawnPos) this.root.position.copy(spawnPos)
    this.prevPosition.copy(this.root.position)
    this.audio.setLoopPlaybackRate('helicopterNoise', this._engineRate)

    // Always (re-)attach camera to its node with zero local offset
    if (this._cameraNode) {
      if (this.camera.parent) this.camera.parent.remove(this.camera)
      this._cameraNode.add(this.camera)
      this.camera.position.set(0, 0, 0)
      this.camera.rotation.set(0, 0, 0)
    }
  }

  setTimeOfDay(mode) {
    const preset = LIGHTING_PRESETS[mode] || LIGHTING_PRESETS.night
    this._timeOfDay = LIGHTING_PRESETS[mode] ? mode : 'night'

    if (this._cockpitLight) {
      this._cockpitLight.intensity = preset.cockpitLightIntensity
      this._cockpitLight.distance = 3
    }

    for (const material of this._cockpitMaterials) {
      material.emissive.setHex(COCKPIT_GLOW_COLOR)
      material.emissiveIntensity = preset.instrumentEmissiveIntensity
      material.needsUpdate = true
    }

  }

  _configureCabinMaterials() {
    if (!this._bodyScene) return

    const cockpitMaterials = new Set()
    this._bodyScene.traverse(obj => {
      if (!obj.isMesh || !obj.material) return

      const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const material of materials) {
        if (!material) continue

        const name = (material.name || '').toLowerCase()
        if (name.includes('glass')) {
          material.metalness = 0
          material.roughness = 0.14
          material.transparent = true
          material.opacity = Math.min(material.opacity ?? 1, 0.72)
        } else if (name.includes('cockpit')) {
          material.metalness = 0.16
          material.roughness = 0.92
          cockpitMaterials.add(material)
        } else if (name.includes('helicopter')) {
          material.metalness = 0.22
          material.roughness = 0.82
        }

        material.needsUpdate = true
      }
    })

    this._cockpitMaterials = [...cockpitMaterials]
  }

  _setupCockpitLight() {
    const lightParent = this._cockpitNode || this._cameraNode
    if (!lightParent || this._cockpitLight) return

    this._cockpitLight = new THREE.PointLight(COCKPIT_GLOW_COLOR, 1.5, 3, 2)
    this._cockpitLight.position.set(0, 0.35, -0.25)
    this._cockpitLight.layers.set(COCKPIT_LIGHT_LAYER)
    lightParent.add(this._cockpitLight)

    const markLayer = root => {
      if (!root) return
      root.traverse(obj => {
        if (obj.isMesh) obj.layers.enable(COCKPIT_LIGHT_LAYER)
      })
    }

    markLayer(this._cockpitNode)
    markLayer(this._glassNode)
  }
}
