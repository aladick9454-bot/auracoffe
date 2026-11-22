
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const path = require('path');

const app = express();

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
    console.error('Booking delivery error:', error.message);

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

// API мониторинга — пока тестовые данные
app.get('/api/monitoring', (req, res) => {
  const monitoringData = {
    checked_at: new Date().toISOString(),
    overall_status: 'warning',
    problems_count: 1,

    components: {
      system_health: {
        status: 'healthy'
      },
      availability: {
        status: 'healthy'
      },
      performance_frontend: {
        status: 'warning'
      },
      performance_backend: {
        status: 'healthy'
      },
      daily_reports: {
        status: 'healthy'
      }
    }
  };

  res.json(monitoringData);
});

// Запуск сервера
const port = Number(process.env.PORT) || 3000;


let latestMonitoring = null;

app.post('/api/monitoring/ingest', (req, res) => {
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

  latestMonitoring = {
    checked_at: data.checked_at,
    overall_status: data.overall_status,
    problems_count: data.problems_count,
    components: Object.fromEntries(
      componentKeys.map(key => [
        key,
        {
          status: data.components[key].status
        }
      ])
    )
  };

  res.json({ ok: true });
});


app.listen(port, () => {
  console.log(`AURA COFFEE: http://localhost:${port}`);
});
