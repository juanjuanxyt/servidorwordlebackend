const mongoose = require('mongoose')

const JugadorSchema = new mongoose.Schema({
  socketId: String,
  name: String,
  avatar: String,
  terminado: { type: Boolean, default: false },
  tiempo: { type: Number, default: 0 },   // ronda actual
  acerto: { type: Boolean, default: false },
  total: { type: Number, default: 0 },    // acumulado
})

const SalaSchema = new mongoose.Schema({
  salaCode: { type: String, unique: true },
  numeroSecreto: String,
  rondaActual: { type: Number, default: 1 },
  maxRondas: { type: Number, default: 10 },
  tiempoLimite: { type: Number, default: 45 }, // 👈 configurable por sala
  jugadores: [JugadorSchema],
  juegoActivo: { type: Boolean, default: false },
}, { timestamps: true })

module.exports = mongoose.model('Sala', SalaSchema)
