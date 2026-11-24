'use strict';

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000
});

pool.on('error', (error) => {
  console.error('PostgreSQL pool error:', error.code);
});

// Проверка подключения PostgreSQL
async function checkDatabaseConnection() {
  try {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is missing');
    }

    await pool.query('SELECT 1');

    console.log('PostgreSQL connected successfully');
  } catch (error) {
    console.error(
      'PostgreSQL connection failed:',
      error.code || error.message
    );
  }
}

checkDatabaseConnection();

// Сохранение мониторинга в PostgreSQL
async function saveMonitoringSnapshot(data) {
  const query = `
    INSERT INTO monitoring_snapshots (
      checked_at,
      overall_status,
      problems_count,
      components
    )
    VALUES ($1, $2, $3, $4::jsonb)
    ON CONFLICT (checked_at) DO NOTHING
  `;

  const values = [
    data.checked_at,
    data.overall_status,
    data.problems_count,
    JSON.stringify(data.components)
  ];

  await pool.query(query, values);
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Разрешённые адреса frontend
const allowedOrigins = [
  'https://aladick9454-bot.github.io',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://127.0.0.1:5501',
  'http://localhost:5501'
];

// Проверка доступности сервера
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'aura-coffee-api',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime())
  });
});

// Настройка CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader(
      'Access-Control-Allow-Origin',
      origin
    );
  }

  res.setHeader('Vary', 'Origin');

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// Настройка Express
app.use(express.json({ limit: '12kb' }));

app.use(express.urlencoded({
  extended: false,
  limit: '2kb'
}));

// Запрещаем прямой доступ к защищённым файлам
app.use((req, res, next) => {
  const pathname = req.path.toLowerCase();

  const protectedFiles = [
    '/monitoring.html',
    '/monitoring.js',
    '/admin-monitoring.html',
    '/frontend/monitoring.html',
    '/frontend/monitoring.js',
    '/frontend/admin-monitoring.html',
    '/server.js',
    '/package.json',
    '/package-lock.json'
  ];

  if (
    protectedFiles.includes(pathname) ||
    pathname === '/.env' ||
    pathname.startsWith('/.git/') ||
    pathname.startsWith('/node_modules/')
  ) {
    return res.sendStatus(404);
  }

  next();
});

// Статические файлы
app.use(
  express.static(path.join(__dirname), {
    index: 'index.html',
    dotfiles: 'deny',
    extensions: false
  })
);

// Ограничение количества заявок
const requests = new Map();
const MAX_PER_15_MIN = 5;

setInterval(() => {
  const now = Date.now();

  for (const [ip, entry] of requests) {
    if (now - entry.start > 900000) {
      requests.delete(ip);
    }
  }
}, 900000).unref();

function safeText(value, max) {
  return typeof value === 'string'
    ? value.trim().slice(0, max)
    : '';
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const d = new Date(value + 'T00:00:00Z');

  if (
    !Number.isFinite(d.getTime()) ||
    d.toISOString().slice(0, 10) !== value
  ) {
    return false;
  }

  const today = new Date();

  const start = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate()
    )
  );

  return (
    d >= start &&
    d <= new Date(start.getTime() + 90 * 86400000)
  );
}

// Приём заявок на бронирование
app.post('/api/booking', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  const ip = req.ip || 'unknown';
  const now = Date.now();

  let entry = requests.get(ip);

  if (!entry || now - entry.start > 900000) {
    entry = {
      start: now,
      count: 0
    };

    requests.set(ip, entry);
  }

  entry.count++;

  if (entry.count > MAX_PER_15_MIN) {
    return res.status(429).json({
      error: 'Слишком много запросов. Попробуйте через 15 минут.'
    });
  }

  const body = req.body || {};

  if (body.website) {
    return res.json({ ok: true });
  }

  const name = safeText(body.name, 80);
  const phone = safeText(body.phone, 24);
  const date = safeText(body.date, 10);
  const time = safeText(body.time, 5);
  const comment = safeText(body.comment, 300);
  const guests = Number(body.guests);

  if (
    name.length < 2 ||
    !/^\+?[\d\s()\-]{7,24}$/.test(phone) ||
    !validDate(date) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
    time < '08:00' ||
    time > '22:00' ||
    !Number.isInteger(guests) ||
    guests < 1 ||
    guests > 6 ||
    body.consent !== true
  ) {
    return res.status(400).json({
      error: 'Проверьте данные формы и согласие на обработку.'
    });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return res.status(503).json({
      error: 'Приём бронирований пока не подключён. Попробуйте позже.'
    });
  }

  const escape = s =>
    s.replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));

  const message =
    `☕ <b>Новый запрос AURA COFFEE</b>\n` +
    `Имя: ${escape(name)}\n` +
    `Телефон: ${escape(phone)}\n` +
    `Дата: ${escape(date)}\n` +
    `Время: ${escape(time)}\n` +
    `Гостей: ${guests}\n` +
    `Пожелания: ${escape(comment || 'нет')}\n\n` +
    `⚠️ Запрос требует подтверждения сотрудником.`;

  try {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      8000
    );

    let response;

    try {
      response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
          }),
          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw Error('Telegram returned ' + response.status);
    }

    res.json({ ok: true });

  } catch (error) {
    console.error(
      'Booking delivery error:',
      error.message
    );

    res.status(502).json({
      error: 'Не удалось доставить запрос. Попробуйте позже.'
    });
  }
});

// Проверка настройки Telegram
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    telegramConfigured: Boolean(
      process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_CHAT_ID
    )
  });
});

// Публичный API мониторинга закрыт
app.get('/api/monitoring', (_req, res) => {
  res.set('Cache-Control', 'no-store');

  res.status(404).json({
    error: 'Monitoring endpoint is private'
  });
});

const port = Number(process.env.PORT) || 3000;

// Приём данных мониторинга из n8n
app.post('/api/monitoring/ingest', async (req, res) => {
  const expected =
    process.env.MONITORING_INGEST_SECRET;

  const provided =
    req.get('x-monitoring-secret') || '';

  if (!expected || !provided) {
    return res.sendStatus(403);
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !crypto.timingSafeEqual(
      expectedBuffer,
      providedBuffer
    )
  ) {
    return res.sendStatus(403);
  }

  const data = req.body;

  const validStatuses = [
    'healthy',
    'warning',
    'critical',
    'unknown'
  ];

  const componentKeys = [
    'system_health',
    'availability',
    'performance_frontend',
    'performance_backend',
    'daily_reports'
  ];

  const valid =
    data &&
    typeof data === 'object' &&
    typeof data.checked_at === 'string' &&
    Number.isFinite(Date.parse(data.checked_at)) &&
    validStatuses.includes(data.overall_status) &&
    Number.isInteger(data.problems_count) &&
    data.problems_count >= 0 &&
    data.components &&
    componentKeys.every(key =>
      validStatuses.includes(
        data.components[key]?.status
      )
    );

  if (!valid) {
    return res.status(400).json({
      error: 'Invalid monitoring payload'
    });
  }

  try {
    await saveMonitoringSnapshot(data);

    return res.json({
      ok: true
    });

  } catch (error) {
    console.error(
      'Monitoring save error:',
      error.code || error.message
    );

    return res.status(503).json({
      ok: false,
      error: 'Database unavailable'
    });
  }
});

// Получение последней проверки из PostgreSQL
async function getLatestMonitoringSnapshot() {
  const result = await pool.query(`
    SELECT
      checked_at,
      overall_status,
      problems_count,
      components
    FROM monitoring_snapshots
    ORDER BY checked_at DESC
    LIMIT 1
  `);

  return result.rows[0] || null;
}

// Серверные сессии администратора
const adminSessions = new Map();
const loginAttempts = new Map();

const SESSION_DURATION = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

// Безопасное сравнение значений
function constantTimeMatch(a, b) {
  const first = crypto.createHash('sha256')
    .update(String(a)).digest();

  const second = crypto.createHash('sha256')
    .update(String(b)).digest();

  return crypto.timingSafeEqual(first, second);
}

// Чтение cookies
function parseCookies(req) {
  const result = {};

  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');

    if (index < 0) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    result[key] = value;
  }

  return result;
}

// Проверка сессии администратора
function getAdminSession(req) {
  const token = parseCookies(req).aura_admin;

  if (!token) return null;

  const secret = process.env.MONITORING_SESSION_SECRET;

  if (!secret) return null;

  const [id, signature] = token.split('.');

  if (!id || !signature) return null;

  const expected = crypto.createHmac('sha256', secret)
    .update(id).digest('hex');

  if (!constantTimeMatch(signature, expected)) {
    return null;
  }

  const session = adminSessions.get(id);

  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(id);

    return null;
  }

  return { id, session };
}

// Middleware авторизации
function requireAdmin(req, res, next) {
  res.set('Cache-Control', 'no-store');

  if (!getAdminSession(req)) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }

  next();
}

// Создание защищённой cookie
function adminCookie(value, maxAgeSeconds) {
  return [
    `aura_admin=${value}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`
  ].join('; ');
}

// HTML страницы входа
function loginPage(message = '') {
  const notice = message
    ? '<p style="color:#f87171">Неверный пароль или слишком много попыток.</p>'
    : '';

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AURA COFFEE — Вход</title>

<style>
body {
  min-height: 100vh;
  margin: 0;
  display: grid;
  place-items: center;
  background: #111827;
  color: #fff;
  font-family: Arial, sans-serif;
}

main {
  width: min(360px, calc(100% - 40px));
  padding: 32px;
  border-radius: 16px;
  background: #1f2937;
}

h1 {
  color: #fbbf24;
}

input, button {
  box-sizing: border-box;
  width: 100%;
  padding: 13px;
  margin-top: 12px;
  border-radius: 8px;
}

button {
  background: #fbbf24;
  border: 0;
  font-weight: bold;
  cursor: pointer;
}
</style>

</head>
<body>

<main>
  <h1>AURA COFFEE</h1>
  <p>Вход в центр мониторинга</p>

  ${notice}

  <form method="POST" action="/admin/login">
    <label for="password">
      Пароль администратора
    </label>

    <input
      id="password"
      type="password"
      name="password"
      required
      autocomplete="current-password"
    >

    <button type="submit">
      Войти
    </button>
  </form>
</main>

</body>
</html>`;
}

// Страница входа
app.get('/admin/login', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Content-Type', 'text/html; charset=utf-8');

  if (getAdminSession(req)) {
    return res.redirect(303, '/admin/monitoring');
  }

  res.send(loginPage());
});

// Авторизация администратора
app.post('/admin/login', (req, res) => {
  res.set('Cache-Control', 'no-store');

  const origin = req.get('origin');

  const expectedOrigin =
    `${req.protocol}://${req.get('host')}`;

  if (origin !== expectedOrigin) {
    return res.sendStatus(403);
  }

  const password =
    process.env.MONITORING_ADMIN_PASSWORD;

  const sessionSecret =
    process.env.MONITORING_SESSION_SECRET;

  if (!password || !sessionSecret) {
    return res.status(503).send(
      'Admin login not configured'
    );
  }

  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  const attempts =
    entry && now - entry.startedAt < LOGIN_WINDOW
      ? entry
      : { startedAt: now, count: 0 };

  if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
    return res.status(429).send(
      loginPage('rate-limit')
    );
  }

  if (!constantTimeMatch(
    req.body?.password ?? '',
    password
  )) {
    attempts.count++;

    loginAttempts.set(ip, attempts);

    return res.status(401).send(
      loginPage('invalid')
    );
  }

  loginAttempts.delete(ip);

  const id = crypto.randomBytes(32)
    .toString('hex');

  const signature = crypto
    .createHmac('sha256', sessionSecret)
    .update(id)
    .digest('hex');

  adminSessions.set(id, {
    expiresAt: Date.now() + SESSION_DURATION
  });

  res.setHeader(
    'Set-Cookie',
    adminCookie(
      `${id}.${signature}`,
      SESSION_DURATION / 1000
    )
  );

  return res.redirect(303, '/admin/monitoring');
});

// Закрытая административная панель
app.get('/admin/monitoring', (req, res) => {
  if (!getAdminSession(req)) {
    return res.redirect(303, '/admin/login');
  }

  res.set('Cache-Control', 'no-store');

  res.sendFile(
    path.join(__dirname, 'admin-monitoring.html')
  );
});

// Защищённый JavaScript административной панели
app.get('/admin/monitoring.js', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.sendFile(
    path.join(__dirname, 'frontend', 'monitoring.js')
  );
});

// Защищённое чтение данных из PostgreSQL
app.get(
  '/api/monitoring/admin',
  requireAdmin,
  async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    try {
      const data = await getLatestMonitoringSnapshot();

      if (!data) {
        return res.json({
          checked_at: null,
          overall_status: 'unknown',
          problems_count: 0,
          components: {}
        });
      }

      return res.json(data);

    } catch (error) {
      console.error(
        'Monitoring read error:',
        error.code || error.message
      );

      return res.status(503).json({
        error: 'Database unavailable'
      });
    }
  }
);

// Выход из административной панели
app.post('/admin/logout', (req, res) => {
  const origin = req.get('origin');

  const expectedOrigin =
    `${req.protocol}://${req.get('host')}`;

  if (origin !== expectedOrigin) {
    return res.sendStatus(403);
  }

  const current = getAdminSession(req);

  if (current) {
    adminSessions.delete(current.id);
  }

  res.setHeader(
    'Set-Cookie',
    adminCookie('', 0)
  );

  res.redirect(303, '/admin/login');
});

// Очистка просроченных сессий
setInterval(() => {
  const now = Date.now();

  for (const [id, session] of adminSessions) {
    if (session.expiresAt <= now) {
      adminSessions.delete(id);
    }
  }

  for (const [ip, entry] of loginAttempts) {
    if (now - entry.startedAt >= LOGIN_WINDOW) {
      loginAttempts.delete(ip);
    }
  }
}, 60000).unref();

// Запуск сервера
app.listen(port, () => {
  console.log(`AURA COFFEE: http://localhost:${port}`);
});