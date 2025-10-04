const mongoose = require('mongoose')

const jugadorSchema = new mongoose.Schema({
  socketId: String,
  name: String,
  avatar: String,
  terminado: { type: Boolean, default: false },
  tiempo: { type: Number, default: 0 }, // tiempo en segundos
})

const salaSchema = new mongoose.Schema({
  salaCode: { type: String, unique: true },
  numeroSecreto: String,
  rondaActual: { type: Number, default: 1 },
  maxRondas: { type: Number, default: 10 },
  jugadores: [jugadorSchema],
  juegoActivo: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
})

module.exports = mongoose.model('Sala', salaSchema)
