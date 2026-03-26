// server.js — MathSabaq shared server
// Handles: static files, Socket.io rooms, app listing API, file upload API

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_PASSWORD = 'mathsabaq2024'; // ← Change this! Same as in upload.html

// ─── Static files ─────────────────────────────────────────────
app.use(express.static(PUBLIC_DIR));
app.use(express.json());

// ─── API: List all apps ───────────────────────────────────────
// Scans public/ for *-teacher.html and *-student.html and groups them
app.get('/api/apps', (req, res) => {
  try {
    const files = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
    const appMap = {};

    files.forEach(file => {
      const teacherMatch = file.match(/^(.+)-teacher\.html$/);
      const studentMatch = file.match(/^(.+)-student\.html$/);

      if (teacherMatch) {
        const slug = teacherMatch[1];
        if (!appMap[slug]) appMap[slug] = { slug, teacher: false, student: false };
        appMap[slug].teacher = true;
      }
      if (studentMatch) {
        const slug = studentMatch[1];
        if (!appMap[slug]) appMap[slug] = { slug, teacher: false, student: false };
        appMap[slug].student = true;
      }
    });

    const apps = Object.values(appMap).sort((a, b) => a.slug.localeCompare(b.slug));
    res.json({ apps, total: apps.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Upload HTML files ───────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PUBLIC_DIR),
  filename: (req, file, cb) => {
    // Sanitize filename — only allow safe characters
    const safe = file.originalname.replace(/[^a-zA-Z0-9\-_.]/g, '').replace(/\.html$/i, '') + '.html';
    cb(null, safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.html')) cb(null, true);
    else cb(new Error('Only .html files allowed'));
  }
});

app.post('/api/upload', (req, res, next) => {
  // Check password from form field
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, error: err.message });

    const password = req.body.password;
    if (password !== UPLOAD_PASSWORD) {
      // Delete uploaded file if password wrong
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(401).json({ success: false, error: 'Wrong password' });
    }

    if (!req.file) return res.status(400).json({ success: false, error: 'No file received' });

    console.log(`[UPLOAD] ${req.file.filename} (${req.file.size} bytes) at ${new Date().toISOString()}`);
    res.json({ success: true, filename: req.file.filename });
  });
});

// ─── Socket.io — Generic room system ─────────────────────────
// Works for ALL apps: teacher creates room, students join by code
// Apps identify themselves by appType (e.g. 'graph', 'decimal')
// So one server handles all quizzes forever — no edits needed for new apps

const rooms = {}; // roomCode → { appType, teacher, students: {id → {name, score, ...}} }

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

io.on('connection', (socket) => {

  // ── Teacher creates room ──────────────────────────────────
  socket.on('create_room', ({ appType, config }) => {
    const code = generateCode();
    rooms[code] = {
      appType,
      config: config || {},
      teacherSocket: socket.id,
      students: {},
      status: 'lobby' // lobby | active | paused | ended
    };
    socket.join(code);
    socket.emit('room_created', { code });
    console.log(`[ROOM] Created ${code} for app:${appType}`);
  });

  // ── Student joins room ────────────────────────────────────
  socket.on('join_room', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('join_error', { message: 'Бөлме табылмады / Комната не найдена' });
    if (room.status === 'ended') return socket.emit('join_error', { message: 'Сабақ аяқталды / Урок завершён' });

    room.students[socket.id] = { name, score: 0, correct: 0, wrong: 0, socketId: socket.id };
    socket.join(code);
    socket.roomCode = code;

    // Notify teacher
    io.to(room.teacherSocket).emit('student_joined', { students: room.students });

    // Tell student current state
    socket.emit('joined', {
      code,
      status: room.status,
      config: room.config,
      appType: room.appType
    });

    console.log(`[JOIN] ${name} → room ${code}`);
  });

  // ── Teacher starts quiz ───────────────────────────────────
  socket.on('start_quiz', ({ code }) => {
    const room = rooms[code];
    if (!room || room.teacherSocket !== socket.id) return;
    room.status = 'active';
    io.to(code).emit('quiz_started', { config: room.config });
  });

  // ── Teacher pauses ────────────────────────────────────────
  socket.on('pause_quiz', ({ code }) => {
    const room = rooms[code];
    if (!room || room.teacherSocket !== socket.id) return;
    room.status = 'paused';
    io.to(code).emit('quiz_paused');
  });

  socket.on('resume_quiz', ({ code }) => {
    const room = rooms[code];
    if (!room || room.teacherSocket !== socket.id) return;
    room.status = 'active';
    io.to(code).emit('quiz_resumed');
  });

  // ── Student submits answer ────────────────────────────────
  socket.on('submit_answer', ({ code, correct }) => {
    const room = rooms[code];
    if (!room || !room.students[socket.id]) return;

    const student = room.students[socket.id];
    if (correct) { student.score += 10; student.correct++; }
    else { student.wrong++; }

    // Broadcast updated leaderboard to teacher
    io.to(room.teacherSocket).emit('scores_updated', {
      students: room.students,
      lastAnswer: { socketId: socket.id, name: student.name, correct }
    });
  });

  // ── Teacher sends next question ───────────────────────────
  socket.on('next_question', ({ code, question }) => {
    const room = rooms[code];
    if (!room || room.teacherSocket !== socket.id) return;
    io.to(code).emit('new_question', { question });
  });

  // ── Teacher ends quiz ─────────────────────────────────────
  socket.on('end_quiz', ({ code }) => {
    const room = rooms[code];
    if (!room || room.teacherSocket !== socket.id) return;
    room.status = 'ended';
    // Send final results to students — don't kick them!
    const sorted = Object.values(room.students).sort((a, b) => b.score - a.score);
    io.to(code).emit('quiz_ended', { results: sorted });
  });

  // ── Disconnect handling ───────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;

    const room = rooms[code];

    // If teacher disconnects, notify students
    if (room.teacherSocket === socket.id) {
      io.to(code).emit('teacher_disconnected');
      // Keep room in memory for 5min in case teacher reconnects
      setTimeout(() => { delete rooms[code]; }, 5 * 60 * 1000);
      return;
    }

    // If student disconnects, update teacher
    if (room.students[socket.id]) {
      const name = room.students[socket.id].name;
      delete room.students[socket.id];
      io.to(room.teacherSocket).emit('student_left', {
        name,
        students: room.students
      });
    }
  });

  // ── Focus tracking (tab switch detection) ─────────────────
  socket.on('tab_switch', ({ code }) => {
    const room = rooms[code];
    if (!room || !room.students[socket.id]) return;
    room.students[socket.id].tabSwitches = (room.students[socket.id].tabSwitches || 0) + 1;
    io.to(room.teacherSocket).emit('student_tab_switch', {
      socketId: socket.id,
      name: room.students[socket.id].name,
      count: room.students[socket.id].tabSwitches
    });
  });
});

// ─── Start server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ MathSabaq server running on port ${PORT}`);
  console.log(`📁 Serving files from: ${PUBLIC_DIR}`);
  console.log(`🌐 Visit: http://localhost:${PORT}`);
});
