import * as THREE from 'three'

const OCEAN_VERT = /* glsl */`
  uniform float uTime;
  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying float vWaveHeight;

  float wave(vec2 p, float freq, float speed, float amp, vec2 dir) {
    return amp * sin(dot(p, dir) * freq + uTime * speed);
  }

  void main() {
    vUv = uv;
    vec3 pos = position;
    // Layered Gerstner-ish waves
    pos.y += wave(pos.xz, 0.045, 1.1,  2.7, vec2( 0.9,  0.7));
    pos.y += wave(pos.xz, 0.07,  0.9,  1.65, vec2(-0.6,  1.0));
    pos.y += wave(pos.xz, 0.11,  1.6,  0.9, vec2( 0.5, -0.5));
    pos.y += wave(pos.xz, 0.03,  0.45, 3.3, vec2( 1.0, -0.3));
    vWaveHeight = pos.y;
    vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`

const OCEAN_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uScrollZ;
  uniform vec3  uCameraPos;
  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying float vWaveHeight;

  void main() {
    vec2 uv = vUv;
    // Scroll UV to simulate convoy movement
    uv.y -= uScrollZ * 0.0004;

    vec2 uv1 = uv * 9.5 + vec2( uTime * 0.03,  uTime * 0.02);
    vec2 uv2 = uv * 16.0 + vec2(-uTime * 0.025,  uTime * 0.04);
    vec2 uv3 = uv * 24.0 + vec2( uTime * 0.018, -uTime * 0.022);
    vec2 uv4 = uv * 13.0 + vec2(-uTime * 0.012, uTime * 0.017);

    float w1 = 0.5 + 0.5 * sin(uv1.x * 5.9 + uv1.y * 3.3);
    float w2 = 0.5 + 0.5 * sin(uv2.x * 3.7 + uv2.y * 6.9);
    float w3 = 0.5 + 0.5 * sin(uv4.x * 4.8 - uv4.y * 5.6);
    float ripple = 0.5 + 0.5 * sin(uv3.x * 8.0 + uv3.y * 5.2 + w2 * 1.8);
    float foam = mix(w1 * w2, w2 * w3, 0.5);

    vec3 viewDir = normalize(uCameraPos - vWorldPos);
    float fresnel = pow(1.0 - max(viewDir.y, 0.0), 2.4);
    float crest = smoothstep(1.1, 3.2, vWaveHeight);
    float sparkle = smoothstep(0.88, 1.0, ripple) * (0.08 + 0.34 * foam) * (0.2 + 0.8 * crest);

    vec3 deep    = vec3(0.02, 0.07, 0.16);
    vec3 shallow = vec3(0.05, 0.18, 0.31);
    vec3 moonlit = vec3(0.15, 0.31, 0.44);
    vec3 foamCol = vec3(0.48, 0.62, 0.74);

    vec3 col = mix(deep, shallow, foam * 0.22 + crest * 0.18);
    col = mix(col, moonlit, fresnel * 0.28);
    col += moonlit * sparkle * (0.04 + fresnel * 0.06);
    col = mix(col, foamCol, max(0.0, foam - 0.82) * 0.45 + crest * 0.04);

    gl_FragColor = vec4(col, 1.0);
  }
`

const SKY_VERT = /* glsl */`
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const SKY_FRAG = /* glsl */`
  uniform vec3 uTop;
  uniform vec3 uBottom;
  varying vec3 vPos;
  void main() {
    float t = clamp(normalize(vPos).y * 2.0 + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0);
  }
`

export class World {
  constructor(scene, camera = null) {
    this._scene     = scene
    this._camera    = camera
    this._scrollZ   = 0   // accumulated scroll for ocean UV
    this._oceanMat  = null
    this._setup()
  }

  _setup() {
    this._setupFog()
    this._setupLighting()
    this._setupSky()
    this._setupOcean()
  }

  _setupFog() {
    this._scene.fog = new THREE.FogExp2(0x7ab3d8, 0.0018)
  }

  _setupLighting() {
    const ambient = new THREE.AmbientLight(0x88aacc, 0.7)
    this._scene.add(ambient)

    const sun = new THREE.DirectionalLight(0xfff5e0, 1.8)
    sun.position.set(120, 250, -80)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.bias = -0.00012
    sun.shadow.normalBias = 0.03
    sun.shadow.radius = 1.6
    sun.shadow.camera.near = 1
    sun.shadow.camera.far  = 800
    const sc = sun.shadow.camera
    sc.left = sc.bottom = -300
    sc.right = sc.top = 300
    this._scene.add(sun)

    // Rim light from opposite side for depth
    const rim = new THREE.DirectionalLight(0x2244aa, 0.4)
    rim.position.set(-80, 60, 120)
    this._scene.add(rim)
  }

  _setupSky() {
    const geo = new THREE.SphereGeometry(1400, 24, 12)
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTop:    { value: new THREE.Color(0x0a2050) },
        uBottom: { value: new THREE.Color(0x7ab3d8) },
      },
      vertexShader:   SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    })
    this._scene.add(new THREE.Mesh(geo, mat))
  }

  _setupOcean() {
    const geo = new THREE.PlaneGeometry(3000, 3000, 80, 80)
    geo.rotateX(-Math.PI / 2)

    this._oceanMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:    { value: 0 },
        uScrollZ: { value: 0 },
        uCameraPos: { value: new THREE.Vector3() },
      },
      vertexShader:   OCEAN_VERT,
      fragmentShader: OCEAN_FRAG,
    })
    const ocean = new THREE.Mesh(geo, this._oceanMat)
    ocean.receiveShadow = true
    this._scene.add(ocean)
  }

  /** dt in seconds. speed in world-units/second (simulates convoy movement). */
  update(dt, convoySpeed = 18) {
    this._scrollZ += convoySpeed * dt
    this._oceanMat.uniforms.uTime.value    += dt
    this._oceanMat.uniforms.uScrollZ.value  = this._scrollZ
    if (this._camera) {
      this._oceanMat.uniforms.uCameraPos.value.copy(this._camera.position)
    }
  }
}
