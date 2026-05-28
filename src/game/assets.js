// All asset URLs resolved by Vite at build time

import cargoShipGlb      from '../assets/models/cargo_ship.glb?url'
import missileGlb         from '../assets/models/missile.glb?url'
import droneBodyGlb       from '../assets/models/dron/dron_enemy_body.glb?url'
import droneVintGlb       from '../assets/models/dron/dron_enemy_vint.glb?url'
import heliBodyGlb        from '../assets/models/helicopter/player_helicopter_body.glb?url'
import heliVintGlb        from '../assets/models/helicopter/player_helicopter_vint.glb?url'
import warshipGlb         from '../assets/models/warship/player_warship.glb?url'
import warshipCannonGlb   from '../assets/models/warship/player_warship_cannon.glb?url'
import warshipPvoGlb      from '../assets/models/warship/player_warship_pvo.glb?url'

import cannonfireOgg      from '../assets/audio/cannon_fire.ogg?url'
import droneNoiseOgg      from '../assets/audio/dron_noise.ogg?url'
import helicopterNoiseOgg from '../assets/audio/helicopter_noise.ogg?url'
import menuSelectOgg      from '../assets/audio/menu_select.ogg?url'
import playerHitOgg       from '../assets/audio/player_hit.ogg?url'
import pvoFireOgg         from '../assets/audio/pvo_fire.ogg?url'
import shipHitOgg         from '../assets/audio/ship_hit.ogg?url'
import shipNoiseOgg       from '../assets/audio/ship_noise.ogg?url'
import weaponRotationOgg  from '../assets/audio/weapon_rotation.ogg?url'

export const MODELS = {
  cargoShip:    cargoShipGlb,
  missile:      missileGlb,
  droneBody:    droneBodyGlb,
  droneVint:    droneVintGlb,
  heliBody:     heliBodyGlb,
  heliVint:     heliVintGlb,
  warship:      warshipGlb,
  warshipCannon: warshipCannonGlb,
  warshipPvo:   warshipPvoGlb,
}

export const AUDIO = {
  cannonFire:     cannonfireOgg,
  droneNoise:     droneNoiseOgg,
  helicopterNoise: helicopterNoiseOgg,
  menuSelect:     menuSelectOgg,
  playerHit:      playerHitOgg,
  pvoFire:        pvoFireOgg,
  shipHit:        shipHitOgg,
  shipNoise:      shipNoiseOgg,
  weaponRotation: weaponRotationOgg,
}
