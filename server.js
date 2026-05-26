const express    = require('express')
const http       = require('http')
const { Server } = require('socket.io')
const path       = require('path')

const app    = express()
const server = http.createServer(app)
const io     = new Server(server)

// ── Session state ─────────────────────────────────────────────────────────────
const lamps = new Set()

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')))
app.get('/',         (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))
app.get('/host',     (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')))
app.get('/audience', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'audience.html')))

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let role = null

  // ─── HOST ──────────────────────────────────────────────────────────────────
  socket.on('host:join', () => {
    role = 'host'
    socket.join('hosts')
    socket.emit('session:state', { lampsConnected: lamps.size })
  })

  // Host position update → relay immediately to all lamps
  socket.on('host:update', ({ lat, lng, velocity, heading, lookaheadSec, baselinePct, manualBri }) => {
    io.to('lamps').emit('corridor:update', {
      lat, lng, velocity, heading, lookaheadSec, baselinePct,
      manualBri: manualBri ?? null,
      timestamp: Date.now(),
    })
  })

  socket.on('disconnect', () => {
    if (role === 'host') {
      io.to('lamps').emit('host:disconnected')
    } else if (role === 'lamp') {
      lamps.delete(socket)
      io.to('hosts').emit('session:state', { lampsConnected: lamps.size })
    }
  })

  // ─── LAMP ──────────────────────────────────────────────────────────────────
  socket.on('lamp:join', () => {
    role = 'lamp'
    lamps.add(socket)
    socket.join('lamps')
    io.to('hosts').emit('session:state', { lampsConnected: lamps.size })
    socket.emit('session:state', { lampsConnected: lamps.size })
  })

  socket.on('lamp:ping', () => { /* presence only */ })
})

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ✦ LumiNation Demo Server`)
  console.log(`  ──────────────────────────────────────────`)
  console.log(`  Entry       →  http://localhost:${PORT}/`)
  console.log(`  Host        →  http://localhost:${PORT}/host`)
  console.log(`  Audience    →  http://localhost:${PORT}/audience`)
  console.log(`  ──────────────────────────────────────────\n`)
})
