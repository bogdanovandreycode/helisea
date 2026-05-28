/**
 * HTML-overlay HUD + menus.
 * No Three.js dependency – pure DOM.
 */
export class HUD {
  constructor(container) {
    this._root = container
    this._el   = {}
    this._build()
  }

  /* ─────────────── DOM construction ─────────────── */
  _build() {
    this._root.insertAdjacentHTML('beforeend', `

      <!-- Loading overlay -->
      <div id="loading" class="overlay">
        <h2>ЗАГРУЗКА…</h2>
        <div class="spinner"></div>
      </div>

      <!-- Main menu overlay -->
      <div id="menu" class="overlay hidden">
        <h1>HELISEA</h1>
        <p class="subtitle">CONVOY DEFENCE</p>
        <button class="menu-btn" id="btn-start">НАЧАТЬ ИГРУ</button>
        <div class="controls-hint">
          WASD — движение &nbsp;|&nbsp; МЫШЬ — обзор / прицел<br>
          ПРОБЕЛ / SHIFT — высота &nbsp;|&nbsp; ЛКМ — огонь<br>
          ESC — пауза / разблокировать курсор
        </div>
      </div>

      <!-- Wave clear banner -->
      <div id="waveclear" class="hidden">
        <h2>ВОЛНА ПРОЙДЕНА!</h2>
        <p id="waveclear-text">Следующая волна через 3 с…</p>
      </div>

      <!-- Game over overlay -->
      <div id="gameover" class="overlay hidden">
        <h1>КОНВОЙ ПОТОПЛЕН</h1>
        <p class="go-wave"  id="go-wave-txt"></p>
        <p class="go-score" id="go-score-txt"></p>
        <button class="menu-btn" id="btn-restart">НАЧАТЬ ЗАНОВО</button>
      </div>

      <!-- Eagle-vision target markers -->
      <div id="eagle-vision" class="hidden"></div>

      <!-- In-game HUD -->
      <div id="hud" class="hidden">
        <!-- Crosshair -->
        <div id="crosshair"><div id="crosshair-dot"></div></div>

        <!-- Top bar -->
        <div id="top-bar">
          <span>ВОЛНА <b id="hud-wave">1</b></span>
          <span>СЧЁТ <b id="hud-score">0</b></span>
          <span>ДРОНЫ <b id="hud-drones">0</b></span>
        </div>

        <!-- Health panel (bottom-left) -->
        <div id="health-panel">
          <div class="health-bar-wrap">
            <span class="label">БОЕВОЙ КОРАБЛЬ</span>
            <div class="health-bar-bg"><div class="health-bar-fill" id="hp-warship" style="width:100%"></div></div>
          </div>
          <div class="health-bar-wrap">
            <span class="label">ТАНКЕР 1</span>
            <div class="health-bar-bg"><div class="health-bar-fill" id="hp-cargo0" style="width:100%"></div></div>
          </div>
          <div class="health-bar-wrap">
            <span class="label">ТАНКЕР 2</span>
            <div class="health-bar-bg"><div class="health-bar-fill" id="hp-cargo1" style="width:100%"></div></div>
          </div>
          <div class="health-bar-wrap">
            <span class="label">ТАНКЕР 3</span>
            <div class="health-bar-bg"><div class="health-bar-fill" id="hp-cargo2" style="width:100%"></div></div>
          </div>
          <div class="health-bar-wrap">
            <span class="label">ВЕРТОЛЁТ</span>
            <div class="health-bar-bg"><div class="health-bar-fill" id="hp-heli" style="width:100%"></div></div>
          </div>
        </div>

        <!-- Ammo panel (bottom-right) -->
        <div id="ammo-panel">
          <div class="ammo-count" id="hud-ammo">120</div>
          <div class="ammo-label">РАКЕТЫ</div>
        </div>

        <!-- Hit flash -->
        <div id="hit-flash"></div>

        <!-- Respawn message -->
        <div id="respawn-msg" class="hidden">ВЕРТОЛЁТ ПОВРЕЖДЁН — ВОЗВРАЩЕНИЕ ЧЕРЕЗ <span id="respawn-cnt">5</span>с</div>

        <!-- Pointer lock prompt -->
        <div id="lock-prompt">НАЖМИТЕ ЛКМ ДЛЯ ЗАХВАТА КУРСОРА</div>
      </div>
    `)

    // Cache elements
    const ids = [
      'loading','menu','waveclear','gameover','hud',
      'btn-start','btn-restart',
      'hud-wave','hud-score','hud-drones','hud-ammo',
      'hp-warship','hp-cargo0','hp-cargo1','hp-cargo2','hp-heli',
      'hit-flash','respawn-msg','respawn-cnt',
      'lock-prompt','waveclear-text','go-wave-txt','go-score-txt',
      'eagle-vision',
    ]
    for (const id of ids) this._el[id] = document.getElementById(id)
  }

  /* ─────────────── visibility helpers ─────────────── */
  _show(id) { this._el[id]?.classList.remove('hidden') }
  _hide(id) { this._el[id]?.classList.add('hidden') }

  showLoading()  { this._show('loading') }
  hideLoading()  { this._hide('loading') }
  showMenu()     { this._show('menu') }
  hideMenu()     { this._hide('menu') }
  showGame()     { this._show('hud'); this._show('eagle-vision'); this._hide('menu'); this._hide('gameover') }
  hideGame()     { this._hide('hud'); this._hide('eagle-vision') }

  showWaveClear(wave, score) {
    this._el['waveclear-text'].textContent = `Волна ${wave} завершена! Счёт: ${score}`
    this._show('waveclear')
    setTimeout(() => this._hide('waveclear'), 3200)
  }

  showGameOver(score, wave) {
    this._el['go-wave-txt'].textContent  = `Волна: ${wave}`
    this._el['go-score-txt'].textContent = `Счёт: ${score.toLocaleString()}`
    this._show('gameover')
    this._hide('hud')
  }

  /** Register click handlers from Game. */
  onStart(cb)   { this._el['btn-start']?.addEventListener('click', cb) }
  onRestart(cb) { this._el['btn-restart']?.addEventListener('click', cb) }

  /* ─────────────── per-frame update ─────────────── */
  /**
   * @param {object} state
   *   wave, score, drones, ammo,
   *   warshipHP, warshipMaxHP,
   *   cargoHP[], cargoMaxHP,
   *   heliHP, heliMaxHP,
   *   pointerLocked, heliAlive, respawnTimer
   */
  update(state) {
    const set = (id, v) => { if (this._el[id]) this._el[id].textContent = v }

    set('hud-wave',   state.wave)
    set('hud-score',  state.score.toLocaleString())
    set('hud-drones', state.drones)
    set('hud-ammo',   state.ammo)

    this._setBar('hp-warship', state.warshipHP, state.warshipMaxHP)
    for (let i = 0; i < 3; i++) {
      this._setBar(`hp-cargo${i}`, state.cargoHP[i] ?? 100, state.cargoMaxHP)
    }
    this._setBar('hp-heli', state.heliHP, state.heliMaxHP)

    // Pointer lock prompt
    if (state.pointerLocked) this._hide('lock-prompt')
    else                     this._show('lock-prompt')

    // Respawn
    if (!state.heliAlive) {
      this._show('respawn-msg')
      set('respawn-cnt', Math.ceil(state.respawnTimer))
    } else {
      this._hide('respawn-msg')
    }
  }

  _setBar(id, hp, maxHp) {
    const el = this._el[id]
    if (!el) return
    const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100))
    el.style.width = pct + '%'
    el.classList.remove('low','mid')
    if (pct < 30)      el.classList.add('low')
    else if (pct < 60) el.classList.add('mid')
  }

  flashHit() {
    const el = this._el['hit-flash']
    if (!el) return
    el.classList.add('active')
    setTimeout(() => el.classList.remove('active'), 120)
  }

  /**
   * Eagle-vision: render world-space targets as screen-space markers.
   * @param {THREE.Camera} camera
   * @param {Array<{pos: THREE.Vector3, label: string, type: 'drone'|'ship'}>} targets
   */
  updateEagleVision(camera, targets) {
    const container = this._el['eagle-vision']
    if (!container) return
    container.innerHTML = ''
    const W = window.innerWidth
    const H = window.innerHeight
    for (const t of targets) {
      const ndc = t.pos.clone().project(camera)
      if (ndc.z > 1) continue   // behind camera
      const x = ( ndc.x * 0.5 + 0.5) * W
      const y = (-ndc.y * 0.5 + 0.5) * H
      if (x < -60 || x > W + 60 || y < -60 || y > H + 60) continue
      const el = document.createElement('div')
      el.className = `eagle-marker eagle-${t.type}`
      el.style.left = x + 'px'
      el.style.top  = y + 'px'
      el.textContent = t.label
      container.appendChild(el)
    }
  }
}
