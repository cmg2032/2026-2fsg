// 무대 투표 서버 — 외부 패키지 없이 Node.js 기본 모듈만 사용합니다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!process.env.ADMIN_PASSWORD) {
  console.warn('[경고] ADMIN_PASSWORD 환경변수가 없어 기본 비밀번호(admin1234)를 사용합니다.');
}

// ---------- 상태 ----------
function defaultState() {
  const songs = [];
  for (let i = 1; i <= 10; i++) {
    songs.push({
      id: crypto.randomBytes(4).toString('hex'),
      order: i,
      team: i % 2 === 1 ? 'A' : 'B',
      title: `곡 ${i}`,
      artist: '',
    });
  }
  return {
    eventTitle: '우리 동아리 정기공연',
    eventInfo: '공연이 끝날 때마다 마음에 든 무대에 하트를 눌러주세요!',
    teams: { A: 'A팀', B: 'B팀' },
    songs,
    currentSongId: null,
    phase: 'idle', // idle | performing | voting | closed
    showResults: false,
    votes: {}, // songId -> { deviceId: timestamp }
    epoch: crypto.randomBytes(6).toString('hex'), // 초기화할 때마다 바뀌는 회차 값
    updatedAt: Date.now(),
  };
}

let state;
try {
  state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  state = defaultState();
}
if (!state.epoch) state.epoch = crypto.randomBytes(6).toString('hex');

let saveTimer = null;
function save() {
  state.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state), (err) => {
      if (err) return console.error('저장 실패', err);
      fs.rename(tmp, DATA_FILE, () => {});
    });
  }, 300);
}

function countFor(songId) {
  return Object.keys(state.votes[songId] || {}).length;
}

function results() {
  const songs = [...state.songs]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ ...s, votes: countFor(s.id) }));
  const teamTotals = { A: 0, B: 0 };
  songs.forEach((s) => (teamTotals[s.team] = (teamTotals[s.team] || 0) + s.votes));
  return { songs, teamTotals };
}

// 관객에게 보여줄 공개 상태
function publicState(deviceId) {
  const songs = [...state.songs].sort((a, b) => a.order - b.order);
  const current = songs.find((s) => s.id === state.currentSongId) || null;
  const myVotes = songs.filter((s) => state.votes[s.id] && state.votes[s.id][deviceId]).map((s) => s.id);
  const out = {
    eventTitle: state.eventTitle,
    eventInfo: state.eventInfo,
    teams: state.teams,
    songs: songs.map(({ id, order, team, title, artist }) => ({ id, order, team, title, artist })),
    current,
    phase: state.phase,
    myVotes,
    showResults: state.showResults,
    epoch: state.epoch,
  };
  if (state.showResults) out.results = results();
  return out;
}

// ---------- 관리자 인증 ----------
const adminTokens = new Set();
function isAdmin(req) {
  const t = req.headers['x-admin-token'];
  return t && adminTokens.has(t);
}

// ---------- 유틸 ----------
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function getDeviceId(req, res) {
  let id = parseCookies(req).vid;
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    id = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `vid=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
  }
  return id;
}

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  const routes = { '/': 'index.html', '/admin': 'admin.html', '/screen': 'screen.html' };
  const file = routes[pathname] || pathname.slice(1);
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('페이지를 찾을 수 없습니다.');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- 라우팅 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    // 관객 API
    if (p === '/api/state' && req.method === 'GET') {
      const deviceId = getDeviceId(req, res);
      return sendJSON(res, 200, publicState(deviceId));
    }

    if (p === '/api/vote' && req.method === 'POST') {
      const deviceId = getDeviceId(req, res);
      const body = await readBody(req);
      if (state.phase !== 'voting' || body.songId !== state.currentSongId) {
        return sendJSON(res, 409, { error: '지금은 이 무대의 투표 시간이 아니에요.' });
      }
      const box = (state.votes[body.songId] = state.votes[body.songId] || {});
      if (box[deviceId]) return sendJSON(res, 409, { error: '이미 이 무대에 투표했어요.' });
      box[deviceId] = Date.now();
      save();
      return sendJSON(res, 200, { ok: true });
    }

    // 관리자 API
    if (p === '/api/admin/login' && req.method === 'POST') {
      const body = await readBody(req);
      const a = Buffer.from(String(body.password || ''));
      const b = Buffer.from(ADMIN_PASSWORD);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        const token = crypto.randomBytes(24).toString('hex');
        adminTokens.add(token);
        return sendJSON(res, 200, { token });
      }
      return sendJSON(res, 401, { error: '비밀번호가 맞지 않아요.' });
    }

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return sendJSON(res, 401, { error: '로그인이 필요해요.' });
      const body = req.method === 'POST' ? await readBody(req) : {};

      if (p === '/api/admin/state') {
        return sendJSON(res, 200, { ...publicState(''), ...results(), showResults: state.showResults, totalDevices: new Set(Object.values(state.votes).flatMap(Object.keys)).size });
      }

      if (p === '/api/admin/settings') {
        if (typeof body.eventTitle === 'string') state.eventTitle = body.eventTitle.slice(0, 100);
        if (typeof body.eventInfo === 'string') state.eventInfo = body.eventInfo.slice(0, 1000);
        if (body.teams) {
          state.teams.A = String(body.teams.A || 'A팀').slice(0, 40);
          state.teams.B = String(body.teams.B || 'B팀').slice(0, 40);
        }
        save();
        return sendJSON(res, 200, { ok: true });
      }

      if (p === '/api/admin/songs') {
        if (!Array.isArray(body.songs) || body.songs.length < 1 || body.songs.length > 30) {
          return sendJSON(res, 400, { error: '곡 목록이 올바르지 않아요.' });
        }
        state.songs = body.songs.map((s, i) => ({
          id: /^[a-f0-9]{8}$/.test(s.id) ? s.id : crypto.randomBytes(4).toString('hex'),
          order: i + 1,
          team: s.team === 'B' ? 'B' : 'A',
          title: String(s.title || `곡 ${i + 1}`).slice(0, 80),
          artist: String(s.artist || '').slice(0, 80),
        }));
        const ids = new Set(state.songs.map((s) => s.id));
        Object.keys(state.votes).forEach((k) => !ids.has(k) && delete state.votes[k]);
        if (!ids.has(state.currentSongId)) {
          state.currentSongId = null;
          state.phase = 'idle';
        }
        save();
        return sendJSON(res, 200, { ok: true });
      }

      if (p === '/api/admin/control') {
        const { action, songId } = body;
        const exists = state.songs.some((s) => s.id === songId);
        if (action === 'perform' && exists) {
          state.currentSongId = songId;
          state.phase = 'performing';
        } else if (action === 'open' && exists) {
          state.currentSongId = songId;
          state.phase = 'voting';
        } else if (action === 'close') {
          if (state.currentSongId) state.phase = 'closed';
        } else if (action === 'idle') {
          state.currentSongId = null;
          state.phase = 'idle';
        } else if (action === 'showResults') {
          state.showResults = !!body.value;
        } else {
          return sendJSON(res, 400, { error: '알 수 없는 동작' });
        }
        save();
        return sendJSON(res, 200, { ok: true });
      }

      if (p === '/api/admin/reset') {
        state.votes = {};
        state.epoch = crypto.randomBytes(6).toString('hex');
        state.currentSongId = null;
        state.phase = 'idle';
        state.showResults = false;
        save();
        return sendJSON(res, 200, { ok: true });
      }

      if (p === '/api/admin/export') {
        const r = results();
        const rows = [['순서', '팀', '곡', '공연자', '득표']].concat(
          r.songs.map((s) => [s.order, state.teams[s.team], s.title, s.artist, s.votes])
        );
        rows.push([], ['팀 합계', state.teams.A, r.teamTotals.A], ['팀 합계', state.teams.B, r.teamTotals.B]);
        const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="vote-results.csv"' });
        return res.end(csv);
      }

      return sendJSON(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET') return serveStatic(req, res, p);
    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    sendJSON(res, 500, { error: '서버 오류' });
  }
});

server.listen(PORT, () => console.log(`투표 서버 실행 중: http://localhost:${PORT}`));
