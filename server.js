const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ====== 설정 ======
const QUESTIONS_PER_MATCH = 10;  // 한 대결당 문제 수
const NEXT_DELAY = 1800;         // 정답 후 다음 문제까지 대기(ms)
const QUESTION_TIMEOUT = 30000;  // 아무도 못 맞힐 때 넘어가는 시간(ms)
const MIN_PLAYERS = 2;
const MAX_LIMIT = 40;

// ====== 문제 생성 ======
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

function genQuestion() {
  const t = rnd(0, 5);
  switch (t) {
    case 0: {
      const a = rnd(2, 19), b = rnd(2, 12);
      return { text: `${a} × ${b} = ?`, answer: a * b };
    }
    case 1: {
      const a = rnd(11, 99), b = rnd(2, 9);
      return { text: `${a} × ${b} = ?`, answer: a * b };
    }
    case 2: {
      const n = rnd(2, 25);
      return { text: `${n}² = ?`, answer: n * n };
    }
    case 3: {
      const r = rnd(1, 15);
      return { text: `반지름이 ${r}cm인 원의 둘레는? (π의 계수만 입력)`, answer: 2 * r };
    }
    case 4: {
      const r = rnd(1, 15);
      return { text: `반지름이 ${r}cm인 원의 넓이는? (π의 계수만 입력)`, answer: r * r };
    }
    default: {
      const angles = [30, 45, 60, 72, 90, 120, 135, 150, 180, 216, 240, 270, 300];
      for (let i = 0; i < 200; i++) {
        const r = rnd(2, 18);
        const x = angles[rnd(0, angles.length - 1)];
        if (Math.random() < 0.5) {
          if ((r * x) % 180 === 0) {
            return {
              text: `반지름 ${r}cm, 중심각 ${x}°인 부채꼴의 호의 길이는? (π의 계수만 입력)`,
              answer: (r * x) / 180,
            };
          }
        } else {
          if ((r * r * x) % 360 === 0) {
            return {
              text: `반지름 ${r}cm, 중심각 ${x}°인 부채꼴의 넓이는? (π의 계수만 입력)`,
              answer: (r * r * x) / 360,
            };
          }
        }
      }
      return { text: `반지름 6cm, 중심각 60°인 부채꼴의 넓이는? (π의 계수만 입력)`, answer: 6 };
    }
  }
}

function isCorrect(input, answer) {
  if (typeof input !== 'string') return false;
  const s = input.replace(/[π\s]/g, '');
  if (s === '') return false;
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n - answer) < 1e-9;
}

// ====== 상태 ======
const rooms = new Map(); // roomId -> room
let roomSeq = 1;
let matchSeq = 1;

function roomList() {
  return [...rooms.values()].map(r => ({
    id: r.id,
    title: r.title,
    count: r.players.size,
    max: r.max,
    state: r.state,
  }));
}

function roomState(room) {
  return {
    id: room.id,
    title: room.title,
    hostId: room.hostId,
    max: room.max,
    state: room.state,
    players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, score: p.score })),
  };
}

const broadcastRooms = () => io.emit('rooms', roomList());
const broadcastRoom = room => io.to(`room:${room.id}`).emit('roomState', roomState(room));

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ====== 대결 진행 ======
function startGame(room) {
  room.state = 'playing';
  room.matches = [];
  for (const p of room.players.values()) p.score = 0;

  const ids = shuffle([...room.players.keys()]);
  const groups = [];
  for (let i = 0; i < ids.length; i += 2) groups.push(ids.slice(i, i + 2));
  // 홀수면 마지막 한 명은 마지막 조에 합류(3인 대결)
  if (groups.length > 1 && groups[groups.length - 1].length === 1) {
    const last = groups.pop();
    groups[groups.length - 1].push(last[0]);
  }

  broadcastRoom(room);
  broadcastRooms();

  for (const g of groups) {
    const m = {
      id: matchSeq++,
      roomId: room.id,
      ids: [...g],
      scores: Object.fromEntries(g.map(id => [id, 0])),
      idx: 0,
      q: null,
      locked: true,
      done: false,
      timer: null,
    };
    room.matches.push(m);
    const channel = `match:${m.id}`;
    for (const id of g) {
      const s = io.sockets.sockets.get(id);
      if (!s) continue;
      s.data.match = m;
      s.join(channel);
      const opponents = g.filter(x => x !== id).map(x => room.players.get(x).name);
      s.emit('matchStart', { opponents, total: QUESTIONS_PER_MATCH });
    }
    m.timer = setTimeout(() => nextQuestion(room, m), 2500);
  }
}

function nextQuestion(room, m) {
  if (m.done) return;
  if (m.idx >= QUESTIONS_PER_MATCH) return endMatch(room, m);
  m.idx++;
  m.q = genQuestion();
  m.locked = false;
  io.to(`match:${m.id}`).emit('question', { text: m.q.text, index: m.idx, total: QUESTIONS_PER_MATCH });
  clearTimeout(m.timer);
  m.timer = setTimeout(() => {
    if (m.done || m.locked) return;
    m.locked = true;
    io.to(`match:${m.id}`).emit('questionResult', { winner: null, answer: m.q.answer });
    m.timer = setTimeout(() => nextQuestion(room, m), NEXT_DELAY);
  }, QUESTION_TIMEOUT);
}

function endMatch(room, m) {
  if (m.done) return;
  m.done = true;
  clearTimeout(m.timer);
  const scores = Object.entries(m.scores)
    .map(([id, score]) => ({ name: room.players.get(id)?.name || '(나감)', score }))
    .sort((a, b) => b.score - a.score);
  const channel = `match:${m.id}`;
  io.to(channel).emit('matchEnd', { scores });
  for (const id of m.ids) {
    const s = io.sockets.sockets.get(id);
    if (s) {
      s.leave(channel);
      if (s.data.match === m) s.data.match = null;
    }
  }
  checkGameEnd(room);
}

function checkGameEnd(room) {
  if (room.state !== 'playing') return;
  if (!room.matches.every(m => m.done)) return;
  room.state = 'waiting';
  const ranking = [...room.players.values()]
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
  io.to(`room:${room.id}`).emit('gameEnd', { ranking });
  broadcastRoom(room);
  broadcastRooms();
}

// ====== 나가기 처리 ======
function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  socket.data.roomId = null;
  socket.leave(`room:${roomId}`);
  if (!room) return;

  room.players.delete(socket.id);

  const m = socket.data.match;
  if (m && !m.done) {
    socket.leave(`match:${m.id}`);
    m.ids = m.ids.filter(id => id !== socket.id);
    socket.data.match = null;
    if (m.ids.length < 2) endMatch(room, m);
  }

  if (room.players.size === 0) {
    rooms.delete(room.id);
  } else {
    if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
    checkGameEnd(room);
    broadcastRoom(room);
  }
  broadcastRooms();
}

// ====== 소켓 ======
io.on('connection', socket => {
  socket.data.name = null;
  socket.data.roomId = null;
  socket.data.match = null;
  socket.emit('rooms', roomList());

  socket.on('setNick', (name, cb) => {
    name = String(name || '').trim().slice(0, 12);
    if (!name) return cb && cb({ ok: false, error: '닉네임을 입력해주세요.' });
    socket.data.name = name;
    cb && cb({ ok: true, name });
    socket.emit('rooms', roomList());
  });

  socket.on('createRoom', (max, cb) => {
    if (!socket.data.name || socket.data.roomId) return cb && cb({ ok: false, error: '방을 만들 수 없어요.' });
    max = parseInt(max, 10);
    if (!Number.isInteger(max) || max < MIN_PLAYERS || max > MAX_LIMIT) {
      return cb && cb({ ok: false, error: `인원은 ${MIN_PLAYERS}~${MAX_LIMIT}명으로 설정해주세요.` });
    }
    const room = {
      id: String(roomSeq++),
      title: `${socket.data.name}님의 방`,
      hostId: socket.id,
      max,
      state: 'waiting',
      players: new Map([[socket.id, { name: socket.data.name, score: 0 }]]),
      matches: [],
    };
    rooms.set(room.id, room);
    socket.data.roomId = room.id;
    socket.join(`room:${room.id}`);
    cb && cb({ ok: true });
    broadcastRoom(room);
    broadcastRooms();
  });

  socket.on('joinRoom', (roomId, cb) => {
    if (!socket.data.name || socket.data.roomId) return cb && cb({ ok: false, error: '참여할 수 없어요.' });
    const room = rooms.get(String(roomId));
    if (!room) return cb && cb({ ok: false, error: '존재하지 않는 방이에요.' });
    if (room.state !== 'waiting') return cb && cb({ ok: false, error: '이미 게임이 진행 중이에요.' });
    if (room.players.size >= room.max) return cb && cb({ ok: false, error: '방이 가득 찼어요.' });
    room.players.set(socket.id, { name: socket.data.name, score: 0 });
    socket.data.roomId = room.id;
    socket.join(`room:${room.id}`);
    cb && cb({ ok: true });
    broadcastRoom(room);
    broadcastRooms();
  });

  socket.on('leaveRoom', () => leaveRoom(socket));

  socket.on('startGame', cb => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return cb && cb({ ok: false, error: '방이 없어요.' });
    if (room.hostId !== socket.id) return cb && cb({ ok: false, error: '방장만 시작할 수 있어요.' });
    if (room.state !== 'waiting') return cb && cb({ ok: false, error: '이미 진행 중이에요.' });
    if (room.players.size < MIN_PLAYERS) return cb && cb({ ok: false, error: `최소 ${MIN_PLAYERS}명이 필요해요.` });
    cb && cb({ ok: true });
    startGame(room);
  });

  socket.on('answer', text => {
    const m = socket.data.match;
    const room = rooms.get(socket.data.roomId);
    if (!m || !room || m.done || m.locked || !m.q) return;
    if (!isCorrect(text, m.q.answer)) return socket.emit('wrongAnswer');

    // 서버에 먼저 도착한 정답이 점수를 가져감
    m.locked = true;
    clearTimeout(m.timer);
    const player = room.players.get(socket.id);
    player.score++;
    m.scores[socket.id] = (m.scores[socket.id] || 0) + 1;
    io.to(`match:${m.id}`).emit('questionResult', { winner: player.name, winnerId: socket.id, answer: m.q.answer });
    broadcastRoom(room);
    m.timer = setTimeout(() => nextQuestion(room, m), NEXT_DELAY);
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
