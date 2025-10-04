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

const TIEMPO_LIMITE = 45 // segundos

const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: '*' },
})

const PORT = process.env.PORT || 3000

// Conectar a MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('MongoDB conectado'))
  .catch(err => console.error('Error MongoDB:', err))

// Helpers
function generarCodigoSala() {
  return Math.random().toString(36).slice(2, 7).toUpperCase()
}

function generarNumeroSecreto() {
  return Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('')
}

// Socket.io
io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id)

  socket.on('crear_sala', async ({ name, avatar }, callback) => {
    let salaCode
    let existe = true
    while (existe) {
      salaCode = generarCodigoSala()
      const sala = await Sala.findOne({ salaCode })
      if (!sala) existe = false
    }

    const nuevaSala = new Sala({
      salaCode,
      numeroSecreto: generarNumeroSecreto(),
      jugadores: [{ socketId: socket.id, name, avatar }],
      juegoActivo: false,
      rondaActual: 1,   // NUEVO
      maxRondas: 10,    // NUEVO
    })
    await nuevaSala.save()

    socket.join(salaCode)
    callback({ salaCode })

    io.to(salaCode).emit('update_sala', nuevaSala.jugadores)
  })

  socket.on('unirse_sala', async ({ salaCode, name, avatar }, callback) => {
    const sala = await Sala.findOne({ salaCode })
    if (!sala) {
      callback({ error: 'Sala no existe' })
      return
    }
    if (sala.jugadores.length >= 10) {
      callback({ error: 'Sala llena' })
      return
    }
    sala.jugadores.push({ socketId: socket.id, name, avatar, terminado: false, tiempo: 0 })
    await sala.save()

    socket.join(salaCode)
    callback({ success: true })

    io.to(salaCode).emit('update_sala', sala.jugadores)
  })

  socket.on('comenzar_juego', async ({ salaCode }) => {
    const sala = await Sala.findOne({ salaCode })
    if (!sala) return

    sala.juegoActivo = true
    sala.rondaActual = 1
    sala.numeroSecreto = generarNumeroSecreto()
    sala.jugadores.forEach(j => {
      j.terminado = false
      j.tiempo = 0
    })
    await sala.save()

    io.to(salaCode).emit('juego_iniciado', { ronda: sala.rondaActual, tiempoLimite: TIEMPO_LIMITE })

    // Timer para terminar la ronda automáticamente
    setTimeout(async () => {
      const salaActual = await Sala.findOne({ salaCode })
      if (!salaActual) return
      if (!salaActual.juegoActivo) return // ya terminó

      // Marcar como terminado a todos los que no terminaron
      salaActual.jugadores.forEach(j => {
        if (!j.terminado) {
          j.terminado = true
          j.tiempo = TIEMPO_LIMITE
          j.acerto = false
        }
      })

      await salaActual.save()
      io.to(salaCode).emit('update_waiting_room', salaActual.jugadores)

      // Llamar lógica de fin de ronda
      terminarRonda(salaActual)
    }, TIEMPO_LIMITE * 1000)
  })

  socket.on('termino_ronda', async ({ salaCode, tiempo }) => {
    const sala = await Sala.findOne({ salaCode })
    if (!sala) return

    const jugador = sala.jugadores.find(j => j.socketId === socket.id)
    if (!jugador) return

    jugador.terminado = true
    jugador.tiempo = tiempo

    await sala.save()

    io.to(salaCode).emit('update_waiting_room', sala.jugadores)

    const todosTerminaron = sala.jugadores.every(j => j.terminado)
    if (todosTerminaron) {
      const alguienAcerto = sala.jugadores.some(j => j.acerto)
      if (alguienAcerto) {
        if (sala.rondaActual < sala.maxRondas) {
          sala.rondaActual += 1
          sala.numeroSecreto = generarNumeroSecreto()
          sala.jugadores.forEach(j => { j.terminado = false; j.tiempo = 0 })
          sala.juegoActivo = true
          await sala.save()
          io.to(salaCode).emit('nueva_ronda', { ronda: sala.rondaActual })
        } else {
          sala.juegoActivo = false
          await sala.save()
          io.to(salaCode).emit('juego_terminado')
        }
      } else {
        // nadie adivinó, se reinicia misma ronda
        sala.jugadores.forEach(j => { j.terminado = false; j.tiempo = 0 })
        sala.numeroSecreto = generarNumeroSecreto()
        sala.juegoActivo = true
        await sala.save()
        io.to(salaCode).emit('nueva_ronda', { ronda: sala.rondaActual })
      }
    }
  })

  socket.on('disconnect', async () => {
    console.log('Cliente desconectado:', socket.id)
    const salas = await Sala.find({ 'jugadores.socketId': socket.id })

    for (const sala of salas) {
      sala.jugadores = sala.jugadores.filter(j => j.socketId !== socket.id)
      if (sala.jugadores.length === 0) {
        await Sala.deleteOne({ salaCode: sala.salaCode })
        console.log(`Sala ${sala.salaCode} eliminada`)
      } else {
        await sala.save()
        io.to(sala.salaCode).emit('update_sala', sala.jugadores)
      }
    }
  })

  socket.on('intentar_numero', async ({ salaCode, intento }, callback) => {
    const sala = await Sala.findOne({ salaCode })
    if (!sala) return callback({ error: 'Sala no encontrada' })

    const numeroSecreto = sala.numeroSecreto
    const DIGITOS = numeroSecreto.length
    const resultado = Array(DIGITOS).fill('incorrecto')
    const usado = Array(DIGITOS).fill(false)

    // Verde: correcto en la posición
    for (let i = 0; i < DIGITOS; i++) {
      if (intento[i] === numeroSecreto[i]) {
        resultado[i] = 'correcto'
        usado[i] = true
      }
    }

    // Naranja: correcto pero en otra posición
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

    // Marcar si acertó completamente
    const jugador = sala.jugadores.find(j => j.socketId === socket.id)
    if (jugador) {
      jugador.acerto = resultado.every(r => r === 'correcto')
    }

    await sala.save()

    callback({ resultado }) // aquí enviamos el resultado al cliente
  })
})

server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`)
})

async function terminarRonda(sala) {
  const salaCode = sala.salaCode

  const podio = sala.jugadores
    .map(j => ({ name: j.name, avatar: j.avatar, tiempo: j.tiempo, acerto: j.acerto }))
    .sort((a, b) => a.tiempo - b.tiempo)

  io.to(salaCode).emit('show_results', podio)

  const alguienAcerto = sala.jugadores.some(j => j.acerto)
  if (alguienAcerto) {
    if (sala.rondaActual < sala.maxRondas) {
      sala.rondaActual += 1
      sala.numeroSecreto = generarNumeroSecreto()
      sala.jugadores.forEach(j => { j.terminado = false; j.tiempo = 0 })
      sala.juegoActivo = true
      await sala.save()
      io.to(salaCode).emit('nueva_ronda', { ronda: sala.rondaActual, tiempoLimite: TIEMPO_LIMITE })

      // Reiniciar timer para la nueva ronda
      setTimeout(async () => {
        const salaNueva = await Sala.findOne({ salaCode })
        if (!salaNueva || !salaNueva.juegoActivo) return
        salaNueva.jugadores.forEach(j => {
          if (!j.terminado) {
            j.terminado = true
            j.tiempo = TIEMPO_LIMITE
            j.acerto = false
          }
        })
        await salaNueva.save()
        io.to(salaCode).emit('update_waiting_room', salaNueva.jugadores)
        terminarRonda(salaNueva)
      }, TIEMPO_LIMITE * 1000)
    } else {
      sala.juegoActivo = false
      await sala.save()
      io.to(salaCode).emit('juego_terminado')
    }
  } else {
    // nadie acierta, misma ronda se reinicia
    sala.jugadores.forEach(j => { j.terminado = false; j.tiempo = 0 })
    sala.numeroSecreto = generarNumeroSecreto()
    sala.juegoActivo = true
    await sala.save()
    io.to(salaCode).emit('nueva_ronda', { ronda: sala.rondaActual, tiempoLimite: TIEMPO_LIMITE })

    // Reiniciar timer
    setTimeout(async () => {
      const salaNueva = await Sala.findOne({ salaCode })
      if (!salaNueva || !salaNueva.juegoActivo) return
      salaNueva.jugadores.forEach(j => {
        if (!j.terminado) {
          j.terminado = true
          j.tiempo = TIEMPO_LIMITE
          j.acerto = false
        }
      })
      await salaNueva.save()
      io.to(salaCode).emit('update_waiting_room', salaNueva.jugadores)
      terminarRonda(salaNueva)
    }, TIEMPO_LIMITE * 1000)
  }
}