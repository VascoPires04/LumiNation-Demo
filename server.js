const express    = require('express')
const http       = require('http')
const { Server } = require('socket.io')
const path       = require('path')

const app    = express()
const server = http.createServer(app)
const io     = new Server(server)

// ── Log system ────────────────────────────────────────────────────────────────
const logBuffer  = []          // last 200 lines
const sseClients = new Set()   // open /logs connections

function log(line) {
  const ts   = new Date().toISOString().slice(11, 23)  // HH:MM:SS.mmm
  const entry = `${ts}  ${line}`
  logBuffer.push(entry)
  if (logBuffer.length > 200) logBuffer.shift()
  process.stdout.write(entry + '\n')
  for (const res of sseClients) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`)
  }
}

// ── Session state ─────────────────────────────────────────────────────────────
const lamps = new Set()

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')))
app.get('/',         (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))
app.get('/host',     (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')))
app.get('/audience', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'audience.html')))

// ── /logs — live log viewer ───────────────────────────────────────────────────
app.get('/logs', (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LumiNation — Logs</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#07070c; color:#e2e2e8; font:13px/1.6 monospace; padding:16px; }
    h1 { color:#FAC775; font-size:0.85rem; letter-spacing:0.1em; text-transform:uppercase; margin-bottom:12px; }
    #log { display:flex; flex-direction:column; gap:2px; }
    .line { padding:2px 0; border-bottom:1px solid rgba(255,255,255,0.04); white-space:pre-wrap; word-break:break-all; }
    .line.host  { color:#FAC775; }
    .line.lamp  { color:#86efac; }
    .line.error { color:#f87171; }
    #status { position:fixed; top:12px; right:16px; font-size:0.72rem; color:rgba(255,255,255,0.3); }
    #status.on { color:#86efac; }
  </style>
</head>
<body>
  <h1>✦ LumiNation — Live Logs</h1>
  <div id="status">connecting…</div>
  <div id="log"></div>
  <script>
    const logEl    = document.getElementById('log')
    const statusEl = document.getElementById('status')

    function addLine(text) {
      const div = document.createElement('div')
      div.className = 'line' +
        (text.includes('[HOST') ? ' host' : '') +
        (text.includes('[LAMP') ? ' lamp' : '') +
        (text.includes('error') || text.includes('ERROR') ? ' error' : '')
      div.textContent = text
      logEl.appendChild(div)
      window.scrollTo(0, document.body.scrollHeight)
      // Keep only last 300 lines in DOM
      while (logEl.children.length > 300) logEl.removeChild(logEl.firstChild)
    }

    const es = new EventSource('/logs/stream')
    es.onopen    = () => { statusEl.textContent = '● live'; statusEl.className = 'on' }
    es.onerror   = () => { statusEl.textContent = '○ disconnected'; statusEl.className = '' }
    es.onmessage = (e) => addLine(JSON.parse(e.data))
  </script>
</body>
</html>`)
})

app.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.flushHeaders()

  // Send backlog so you can see what happened before you opened the page
  for (const line of logBuffer) {
    res.write(`data: ${JSON.stringify(line)}\n\n`)
  }

  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
})

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let role = null

  // ─── HOST ──────────────────────────────────────────────────────────────────
  socket.on('host:join', () => {
    role = 'host'
    socket.join('hosts')
    socket.emit('session:state', { lampsConnected: lamps.size })
    log(`[HOST]  joined  — lamps connected: ${lamps.size}`)
  })

  let lastLogTime = 0
  socket.on('host:update', ({ lat, lng, velocity, heading, lookaheadSec, baselinePct, manualBri }) => {
    io.to('lamps').emit('corridor:update', {
      lat, lng, velocity, heading, lookaheadSec, baselinePct,
      manualBri: manualBri ?? null,
      timestamp: Date.now(),
    })
    const now = Date.now()
    if (now - lastLogTime > 2000) {
      lastLogTime = now
      const gps = lat !== null ? `${lat.toFixed(5)},${lng.toFixed(5)}` : 'NO GPS'
      log(`[HOST→] gps:${gps}  speed:${(velocity||0).toFixed(1)}m/s  hdg:${(heading||0).toFixed(0)}°  lookahead:${lookaheadSec}s  lamps:${lamps.size}`)
    }
  })

  socket.on('disconnect', () => {
    if (role === 'host') {
      log('[HOST]  disconnected')
      io.to('lamps').emit('host:disconnected')
    } else if (role === 'lamp') {
      lamps.delete(socket)
      log(`[LAMP]  disconnected  — lamps remaining: ${lamps.size}`)
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
    log(`[LAMP]  joined  — total lamps: ${lamps.size}`)
  })

  socket.on('lamp:ping', () => { /* presence only */ })
})

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
server.listen(PORT, '0.0.0.0', () => {
  log(`server started on port ${PORT}`)
  process.stdout.write(
    `\n  ✦ LumiNation Demo Server\n` +
    `  ──────────────────────────────────────────\n` +
    `  Entry       →  http://localhost:${PORT}/\n` +
    `  Host        →  http://localhost:${PORT}/host\n` +
    `  Audience    →  http://localhost:${PORT}/audience\n` +
    `  Logs        →  http://localhost:${PORT}/logs\n` +
    `  ──────────────────────────────────────────\n\n`
  )
})
