// index.js
require('dotenv').config()
const express = require('express')
const http = require('http')
const cors = require('cors')
const mongoose = require('mongoose')
const { Server } = require('socket.io')
const Sala = require('./models/Sala')

const app = express()
app.use(cors())
app.use(express.json())

// ==== Timings (defaults por si la sala no define) ====
const COUNTDOWN = 3
const TIEMPO_LIMITE = 45
const RESULT_OVERLAY_MS = 15000

const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })
const PORT = process.env.PORT || 3000

// ===== Mongo =====
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('MongoDB conectado'))
  .catch(err => console.error('Error MongoDB:', err))

// ===== Helpers =====
function generarCodigoSala() {
  return Math.random().toString(36).slice(2, 7).toUpperCase()
}
function generarNumeroSecreto() {
  return Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('')
}

// ===== Timers por sala =====
const preroundTimerByRoom = new Map()
const roundTimerByRoom = new Map()
const overlayTimerByRoom = new Map()
const clearTimer = (map, key) => { const t = map.get(key); if (t) { clearTimeout(t); map.delete(key) } }

// ========= Flujo de juego =========

/**
 * Inicia (o reanuda) una ronda. Si avanzarRonda=true, incrementa rondaActual
 * siempre que no haya superado maxRondas; si ya no quedan rondas, emite juego_terminado.
 * Emite: 'preround' → (3s) → 'nueva_ronda' → (tiempoLimite) → terminarRonda()
 */
async function iniciarRonda({ salaCode, avanzarRonda = false }) {
  const sala = await Sala.findOne({ salaCode })
  if (!sala) return

  if (avanzarRonda) {
    if (sala.rondaActual >= (sala.maxRondas || 10)) {
      io.to(salaCode).emit('juego_terminado')
      return
    }
    sala.rondaActual += 1
  }

  // limpiar timers colgados
  clearTimer(overlayTimerByRoom, salaCode)
  clearTimer(roundTimerByRoom, salaCode)
  clearTimer(preroundTimerByRoom, salaCode)

  // preround inactivo
  sala.juegoActivo = false
  sala.jugadores.forEach(j => { j.terminado = false; j.tiempo = 0; j.acerto = false })
  await sala.save()

  const LIM = sala.tiempoLimite || TIEMPO_LIMITE
  io.to(salaCode).emit('preround', { ronda: sala.rondaActual, countdown: COUNTDOWN })
  console.log(`[${salaCode}] ⏳ PREROUND ${COUNTDOWN}s (ronda=${sala.rondaActual}/${sala.maxRondas || 10})`)

  const tPre = setTimeout(async () => {
    const s = await Sala.findOne({ salaCode })
    if (!s) return

    const LIM2 = s.tiempoLimite || TIEMPO_LIMITE
    s.numeroSecreto = generarNumeroSecreto()
    s.juegoActivo = true
    await s.save()

    io.to(salaCode).emit('nueva_ronda', { ronda: s.rondaActual, tiempoLimite: LIM2 })
    console.log(`[${salaCode}] ▶️ RONDA INICIA ${LIM2}s (ronda=${s.rondaActual})`)

    // cierre por tiempo
    const tRound = setTimeout(async () => {
      const s2 = await Sala.findOne({ salaCode })
      if (!s2) return
      if (!s2.juegoActivo) return

      const LIM3 = s2.tiempoLimite || TIEMPO_LIMITE
      s2.jugadores.forEach(j => {
        if (!j.terminado) {
          j.terminado = true
          j.tiempo = LIM3
          j.acerto = false
          j.total = (j.total || 0) + LIM3
        }
      })
      await s2.save()
      io.to(salaCode).emit('update_waiting_room', s2.jugadores)
      await terminarRonda(s2)
    }, LIM2 * 1000)
    roundTimerByRoom.set(salaCode, tRound)
  }, COUNTDOWN * 1000)
  preroundTimerByRoom.set(salaCode, tPre)
}

/**
 * Termina una ronda: pausa el juego, emite podio 15s y luego:
 *  - si quedan rondas → iniciarRonda({ avanzarRonda:true })
 *  - si fue la última → juego_terminado
 * Emite: 'show_results', luego 'preround'/'nueva_ronda' o 'juego_terminado'
 */
async function terminarRonda(sala) {
  const salaCode = sala.salaCode

  // por si cerró por “todos terminaron”
  clearTimer(roundTimerByRoom, salaCode)

  sala.juegoActivo = false
  await sala.save()

  // ¿es la última ronda?
  const isLast = sala.rondaActual >= (sala.maxRondas || 10)

 if (isLast) {
    // 👉 Enviar ranking final y terminar
    const rankingFinal = sala.jugadores
      .map(j => ({
        name: j.name,
        avatar: j.avatar,
        total: j.total || 0
      }))
      .sort((a, b) => a.total - b.total)

    io.to(salaCode).emit('juego_terminado', { rankingFinal })
    console.log(`[${salaCode}] ✅ JUEGO TERMINADO (última ronda)`)
    return
  }

  // 👉 Si NO es la última, mostramos podio de la ronda por 15s y seguimos
  const podio = sala.jugadores
    .map(j => ({
      name: j.name,
      avatar: j.avatar,
      tiempo: j.tiempo,        // tiempo de ESTA ronda
      total: j.total || 0,     // acumulado
      acerto: j.acerto
    }))
    .sort((a, b) => a.tiempo - b.tiempo)

  io.to(salaCode).emit('show_results', podio)
  console.log(`[${salaCode}] 🏁 FIN RONDA ${sala.rondaActual} → PODIO ${RESULT_OVERLAY_MS / 1000}s`)

  clearTimer(overlayTimerByRoom, salaCode)
  const tOverlay = setTimeout(async () => {
    const s = await Sala.findOne({ salaCode })
    if (!s) return
    if (s.jugadores.length === 0) return

    await iniciarRonda({ salaCode, avanzarRonda: true })
  }, RESULT_OVERLAY_MS)
  overlayTimerByRoom.set(salaCode, tOverlay)
}


// ========= Socket.io =========
io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id)

  // Crear sala
  socket.on('crear_sala', async ({ name, avatar }, callback) => {
    try {
      let salaCode, existe = true
      while (existe) {
        salaCode = generarCodigoSala()
        const dup = await Sala.findOne({ salaCode })
        if (!dup) existe = false
      }

      const nuevaSala = new Sala({
        salaCode,
        numeroSecreto: generarNumeroSecreto(),
        jugadores: [{ socketId: socket.id, name, avatar, terminado: false, tiempo: 0, acerto: false, total: 0 }],
        juegoActivo: false,
        rondaActual: 1,
        maxRondas: 10,         // default sano
        tiempoLimite: 45,      // default sano
      })
      await nuevaSala.save()

      socket.join(salaCode)
      callback?.({ salaCode })
      io.to(salaCode).emit('update_sala', nuevaSala.jugadores)
    } catch (err) {
      console.error('crear_sala error:', err)
      callback?.({ error: 'No se pudo crear la sala' })
    }
  })

  // Unirse a sala
  socket.on('unirse_sala', async ({ salaCode, name, avatar }, callback) => {
    try {
      const sala = await Sala.findOne({ salaCode })
      if (!sala) return callback?.({ error: 'Sala no existe' })
      if (sala.jugadores.length >= 10) return callback?.({ error: 'Sala llena' })

      sala.jugadores.push({ socketId: socket.id, name, avatar, terminado: false, tiempo: 0, acerto: false, total: 0 })
      await sala.save()

      socket.join(salaCode)
      callback?.({ success: true })
      io.to(salaCode).emit('update_sala', sala.jugadores)
    } catch (err) {
      console.error('unirse_sala error:', err)
      callback?.({ error: 'No se pudo unir a la sala' })
    }
  })

  // Comenzar juego con parámetros del host: { tiempoLimite, maxRondas }
  socket.on('comenzar_juego', async ({ salaCode, tiempoLimite, maxRondas }) => {
    try {
      const sala = await Sala.findOne({ salaCode })
      if (!sala) return

      const SEC_MIN = 15, SEC_MAX = 180
      const ROUNDS_MIN = 1, ROUNDS_MAX = 50

      const lim = Math.max(SEC_MIN, Math.min(SEC_MAX, Math.round(Number(tiempoLimite) || sala.tiempoLimite || TIEMPO_LIMITE)))
      const rounds = Math.max(ROUNDS_MIN, Math.min(ROUNDS_MAX, Math.round(Number(maxRondas) || sala.maxRondas || 10)))

      // limpiar timers
      clearTimer(overlayTimerByRoom, salaCode)
      clearTimer(roundTimerByRoom, salaCode)
      clearTimer(preroundTimerByRoom, salaCode)

      // reset estado de juego
      sala.rondaActual = 1
      sala.maxRondas = rounds
      sala.tiempoLimite = lim
      sala.juegoActivo = false
      sala.jugadores.forEach(j => {
        j.terminado = false
        j.tiempo = 0
        j.acerto = false
        j.total = 0     // acumulado a cero al inicio del juego
      })
      await sala.save()

      io.to(salaCode).emit('juego_iniciado', { ronda: sala.rondaActual, tiempoLimite: lim })

      // Primera ronda (no avanza aquí)
      await iniciarRonda({ salaCode, avanzarRonda: false })
    } catch (err) {
      console.error('comenzar_juego error:', err)
    }
  })

  // Jugador terminó su intento (acertó o decidió parar)
  socket.on('termino_ronda', async ({ salaCode, tiempo }) => {
    try {
      const sala = await Sala.findOne({ salaCode })
      if (!sala || !sala.juegoActivo) return

      const LIM = sala.tiempoLimite || TIEMPO_LIMITE
      const jugador = sala.jugadores.find(j => j.socketId === socket.id)
      if (!jugador) return

      jugador.terminado = true
      jugador.tiempo = Math.min(Math.max(0, tiempo ?? LIM), LIM)
      jugador.total = (jugador.total || 0) + jugador.tiempo
      await sala.save()

      io.to(salaCode).emit('update_waiting_room', sala.jugadores)

      if (sala.jugadores.every(j => j.terminado)) {
        await terminarRonda(sala)
      }
    } catch (err) {
      console.error('termino_ronda error:', err)
    }
  })

  // Intento tipo Wordle: devuelve patrón, no el secreto
  socket.on('intentar_numero', async ({ salaCode, intento }, callback) => {
    try {
      const sala = await Sala.findOne({ salaCode })
      if (!sala) return callback?.({ error: 'Sala no encontrada' })
      if (!sala.juegoActivo) return callback?.({ error: 'La ronda no está activa' })

      const numeroSecreto = sala.numeroSecreto
      const DIGITOS = numeroSecreto.length

      if (typeof intento !== 'string' || intento.length !== DIGITOS || !/^\d+$/.test(intento)) {
        return callback?.({ error: 'Intento inválido' })
      }

      const resultado = Array(DIGITOS).fill('incorrecto')
      const usado = Array(DIGITOS).fill(false)

      // Verdes exactos
      for (let i = 0; i < DIGITOS; i++) {
        if (intento[i] === numeroSecreto[i]) {
          resultado[i] = 'correcto'
          usado[i] = true
        }
      }
      // Naranjas
      for (let i = 0; i < DIGITOS; i++) {
        if (resultado[i] === 'correcto') continue
        for (let j = 0; j < DIGITOS; j++) {
          if (!usado[j] && intento[i] === numeroSecreto[j]) {
            resultado[i] = 'parcial'
            usado[j] = true
            break
          }
        }
      }

      const jugador = sala.jugadores.find(j => j.socketId === socket.id)
      if (jugador) {
        jugador.acerto = resultado.every(r => r === 'correcto')
        await sala.save()
      }

      callback?.({ resultado })
    } catch (err) {
      console.error('intentar_numero error:', err)
      callback?.({ error: 'Error evaluando intento' })
    }
  })

  // Desconexión
  socket.on('disconnect', async () => {
    try {
      console.log('Cliente desconectado:', socket.id)
      const salas = await Sala.find({ 'jugadores.socketId': socket.id })

      for (const sala of salas) {
        sala.jugadores = sala.jugadores.filter(j => j.socketId !== socket.id)
        if (sala.jugadores.length === 0) {
          clearTimer(overlayTimerByRoom, sala.salaCode)
          clearTimer(roundTimerByRoom, sala.salaCode)
          clearTimer(preroundTimerByRoom, sala.salaCode)
          await Sala.deleteOne({ salaCode: sala.salaCode })
          console.log(`Sala ${sala.salaCode} eliminada`)
        } else {
          await sala.save()
          io.to(sala.salaCode).emit('update_sala', sala.jugadores)
        }
      }
    } catch (err) {
      console.error('disconnect handler error:', err)
    }
  })
})

server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`)
})