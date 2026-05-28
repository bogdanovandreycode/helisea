import './style.css'
import { Game } from './game/Game.js'

const game = new Game(document.getElementById('app'))
game.init()

// keep a handle for hot-reload debugging
if (import.meta.hot) {
  import.meta.hot.dispose(() => game.dispose())
}
