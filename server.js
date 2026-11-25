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


// ========================================
// SAVE SNAPSHOT AND PROCESS INCIDENTS
// ========================================

async function saveMonitoringSnapshot(snapshot) {

  const client = await pool.connect();

  try {

    await client.query('BEGIN');
    await client.query(
  `
    SELECT set_config(
      'app.incident_actor',
      'admin',
      true
    )
  `
);

    // Блокируем строку состояния обработки,
    // чтобы параллельные запросы выполнялись
    // последовательно.

    const stateResult = await client.query(`

      SELECT last_processed_at

      FROM monitoring_incident_processing_state

      WHERE id = 1

      FOR UPDATE

    `);

    if (stateResult.rows.length !== 1) {

      throw new Error(
        'Incident processing state is missing'
      );

    }

    // Сохраняем проверку мониторинга.

    const insertResult = await client.query(

      `

        INSERT INTO monitoring_snapshots (

          checked_at,

          overall_status,

          problems_count,

          components

        )

        VALUES (

          $1::timestamptz,

          $2,

          $3,

          $4::jsonb

        )

        ON CONFLICT (checked_at)

        DO NOTHING

        RETURNING id;

      `,

      [

        snapshot.checked_at,

        snapshot.overall_status,

        snapshot.problems_count,

        JSON.stringify(snapshot.components)

      ]

    );

    // Повторная отправка той же проверки.

    if (insertResult.rowCount === 0) {

      await client.query('COMMIT');

      return {

        inserted: false,

        duplicate: true,

        incidents_processed: false

      };

    }

    // Проверяем хронологический порядок.

    const freshnessResult = await client.query(

      `

        SELECT (

          $1::timestamptz > COALESCE(

            last_processed_at,

            '-infinity'::timestamptz

          )

        ) AS is_newer

        FROM monitoring_incident_processing_state

        WHERE id = 1

      `,

      [snapshot.checked_at]

    );

    const isNewer =
      freshnessResult.rows[0].is_newer;

    // Устаревшую проверку сохраняем в истории,
    // но не изменяем текущие инциденты.

    if (!isNewer) {

      await client.query('COMMIT');

      return {

        inserted: true,

        duplicate: false,

        incidents_processed: false,

        reason: 'out_of_order_snapshot'

      };

    }

    // Обрабатываем инциденты.

    const incidentResult =

      await processMonitoringIncidents(

        client,

        snapshot

      );

    // Запоминаем последнюю обработанную проверку.

    await client.query(

      `

        UPDATE
          monitoring_incident_processing_state

        SET

          last_processed_at =
            $1::timestamptz,

          updated_at = NOW()

        WHERE id = 1

      `,

      [snapshot.checked_at]

    );

    await client.query('COMMIT');

    console.log(

      'Monitoring incidents processed:',

      incidentResult

    );

    return {

      inserted: true,

      duplicate: false,

      incidents_processed: true,

      incidents: incidentResult

    };

  } catch (error) {

    try {

      await client.query('ROLLBACK');

    } catch (rollbackError) {

      console.error(

        'Monitoring rollback failed:',

        rollbackError.message

      );

    }

    throw error;

  } finally {

    client.release();

  }

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


app.get('/ready', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    await pool.query({
      text: 'SELECT 1',
      query_timeout: 5000
    });

    return res.status(200).json({
      status: 'ready',
      database: 'healthy',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error(
      'Readiness check failed:',
      error.code || error.message
    );

    return res.status(503).json({
      status: 'not_ready',
      database: 'unavailable',
      timestamp: new Date().toISOString()
    });
  }
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
  '/monitoring.css',
  '/admin-monitoring.html',
  '/frontend/monitoring.html',
  '/frontend/monitoring.js',
  '/frontend/monitoring.css',
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

  const checkedAtMs = Date.parse(data?.checked_at);

  const MAX_FUTURE_OFFSET_MS = 60 * 1000;

const validTimestamp =
  Number.isFinite(checkedAtMs) &&
  checkedAtMs <= Date.now() + MAX_FUTURE_OFFSET_MS;

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
    validTimestamp &&
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


async function getMonitoringAnalytics(hours) {
  const query = `
    SELECT
      COUNT(*)::integer AS total_checks,

      COUNT(*) FILTER (
        WHERE overall_status = 'healthy'
      )::integer AS healthy_checks,

      COUNT(*) FILTER (
        WHERE overall_status = 'warning'
      )::integer AS warning_checks,

      COUNT(*) FILTER (
        WHERE overall_status = 'critical'
      )::integer AS critical_checks,

      COUNT(*) FILTER (
        WHERE overall_status = 'unknown'
      )::integer AS unknown_checks,

      ROUND(
        100.0 * COUNT(*) FILTER (
          WHERE overall_status = 'healthy'
        ) / NULLIF(COUNT(*), 0),
        2
      ) AS healthy_percent,

      MIN(checked_at) AS first_check,

      MAX(checked_at) AS last_check

    FROM monitoring_snapshots

    WHERE checked_at >=
      NOW() - ($1::integer * INTERVAL '1 hour')

      AND checked_at <= NOW()
  `;

  const result = await pool.query(
    query,
    [hours]
  );

  const row = result.rows[0];

  return {
    period_hours: hours,

    total_checks: row.total_checks,

    healthy_checks: row.healthy_checks,

    warning_checks: row.warning_checks,

    critical_checks: row.critical_checks,

    unknown_checks: row.unknown_checks,

    healthy_percent:
      row.healthy_percent === null
        ? null
        : Number(row.healthy_percent),

    first_check: row.first_check,

    last_check: row.last_check
  };
}

async function getMonitoringComparison(hours) {

  const query = `
    WITH periods AS (

      SELECT
        'current' AS period,
        NOW() - ($1::integer * INTERVAL '1 hour') AS start_at,
        NOW() AS end_at

      UNION ALL

      SELECT
        'previous' AS period,
        NOW() - ($1::integer * INTERVAL '2 hours') AS start_at,
        NOW() - ($1::integer * INTERVAL '1 hour') AS end_at

    )

    SELECT
      p.period,

      COUNT(s.checked_at)::integer AS total_checks,

      COUNT(s.checked_at) FILTER (
        WHERE s.overall_status = 'healthy'
      )::integer AS healthy_checks,

      COUNT(s.checked_at) FILTER (
        WHERE s.overall_status = 'warning'
      )::integer AS warning_checks,

      COUNT(s.checked_at) FILTER (
        WHERE s.overall_status = 'critical'
      )::integer AS critical_checks,

      COUNT(s.checked_at) FILTER (
        WHERE s.overall_status = 'unknown'
      )::integer AS unknown_checks,

      ROUND(
        100.0 * COUNT(s.checked_at) FILTER (
          WHERE s.overall_status = 'healthy'
        ) / NULLIF(COUNT(s.checked_at), 0),
        2
      ) AS healthy_percent

    FROM periods p

    LEFT JOIN monitoring_snapshots s
      ON s.checked_at >= p.start_at
      AND s.checked_at < p.end_at

    GROUP BY p.period
  `;

  const result = await pool.query(
    query,
    [hours]
  );

  function normalize(row) {

    return {
      ...row,

      healthy_percent:
        row.healthy_percent === null
          ? null
          : Number(row.healthy_percent)
    };

  }

  const current = normalize(
    result.rows.find(
      row => row.period === 'current'
    )
  );

  const previous = normalize(
    result.rows.find(
      row => row.period === 'previous'
    )
  );

  const comparable =
    current.total_checks > 0 &&
    previous.total_checks > 0;

  return {

    period_hours: hours,

    comparable,

    current,

    previous,

    changes: {

      healthy_percent:
        comparable
          ? Number(
              (
                current.healthy_percent -
                previous.healthy_percent
              ).toFixed(2)
            )
          : null,

      critical_checks:
        comparable
          ? current.critical_checks -
            previous.critical_checks
          : null,

      warning_checks:
        comparable
          ? current.warning_checks -
            previous.warning_checks
          : null,

      total_checks:
        comparable
          ? current.total_checks -
            previous.total_checks
          : null

    }

  };

}


// ========================================
// INCIDENT MANAGEMENT
// ========================================


// ========================================
// INCIDENT COMPONENT CONFIGURATION
// ========================================

const INCIDENT_COMPONENT_CONFIG = {

  system_health: {
    name: 'CRM',
    warning: 'Предупреждение в работе CRM',
    critical: 'Критическая ошибка CRM'
  },

  availability: {
    name: 'Сайт и API',
    warning: 'Проблемы доступности сайта или API',
    critical: 'Критическая проблема доступности'
  },

  performance_frontend: {
    name: 'Frontend',
    warning: 'Снижение производительности Frontend',
    critical: 'Критическая проблема Frontend'
  },

  performance_backend: {
    name: 'Backend',
    warning: 'Снижение производительности Backend',
    critical: 'Критическая проблема Backend'
  },

  daily_reports: {
    name: 'Ежедневные отчёты',
    warning: 'Проблема с ежедневными отчётами',
    critical: 'Критическая ошибка ежедневных отчётов'
  }

};


function buildIncidentData(component, status) {

  if (
    !Object.hasOwn(
      INCIDENT_COMPONENT_CONFIG,
      component
    )
  ) {

    return null;

  }

  if (
    status !== 'warning' &&
    status !== 'critical'
  ) {

    return null;

  }

  const config =
    INCIDENT_COMPONENT_CONFIG[component];

  return {

    component,

    severity: status,

    title: config[status],

    description:

      `Мониторинг обнаружил проблему. ` +
      `Компонент: ${config.name}. ` +
      `Статус проверки: ${status}.`

  };

}


// ========================================
// OPEN OR UPDATE INCIDENT
// ========================================

async function openOrUpdateIncident(
  client,
  incident,
  checkedAt
) {

  const query = `

    INSERT INTO monitoring_incidents AS existing (

      component,

      title,

      description,

      severity,

      status,

      opened_at,

      last_seen_at,

      occurrences

    )

    VALUES (

      $1,

      $2,

      $3,

      $4,

      'open',

      $5::timestamptz,

      $5::timestamptz,

      1

    )

    ON CONFLICT (component)

    WHERE status IN (
      'open',
      'acknowledged'
    )

    DO UPDATE SET

      last_seen_at =
        EXCLUDED.last_seen_at,

      occurrences =
        existing.occurrences + 1,

      severity = CASE

        WHEN existing.severity = 'critical'
          OR EXCLUDED.severity = 'critical'

        THEN 'critical'

        ELSE 'warning'

      END,

      title = CASE

        WHEN existing.severity = 'critical'

        THEN existing.title

        ELSE EXCLUDED.title

      END,

      description =
        EXCLUDED.description,

      updated_at = NOW()

    WHERE EXCLUDED.last_seen_at
      > existing.last_seen_at

    RETURNING *;

  `;

  const result = await client.query(

    query,

    [

      incident.component,

      incident.title,

      incident.description,

      incident.severity,

      checkedAt

    ]

  );

  return result.rows[0] || null;

}


// ========================================
// AUTOMATIC INCIDENT RESOLUTION
// ========================================

async function resolveMonitoringIncident(
  client,
  component,
  checkedAt
) {

  const query = `

    UPDATE monitoring_incidents

    SET

      status = 'resolved',

      resolved_at = $2::timestamptz,

      updated_at = NOW()

    WHERE component = $1

      AND status IN (

        'open',

        'acknowledged'

      )

      AND last_seen_at < $2::timestamptz

    RETURNING *;

  `;

  const result = await client.query(

    query,

    [

      component,

      checkedAt

    ]

  );

  return result.rows[0] || null;

}


// ========================================
// PROCESS MONITORING INCIDENTS
// ========================================

async function processMonitoringIncidents(
  client,
  snapshot
) {

  const checkedAt =
    snapshot.checked_at;

  const components =
    snapshot.components;

  const result = {

    opened: 0,

    updated: 0,

    resolved: 0,

    ignored: 0

  };

  for (
    const component of
    Object.keys(INCIDENT_COMPONENT_CONFIG)
  ) {

    const status =
      components?.[component]?.status;

    // Отсутствие данных не означает восстановление.

    if (

      !status ||

      status === 'unknown'

    ) {

      result.ignored++;

      continue;

    }

    // Компонент восстановился.

    if (status === 'healthy') {

      const resolvedIncident =

        await resolveMonitoringIncident(

          client,

          component,

          checkedAt

        );

      if (resolvedIncident) {

        result.resolved++;

      }

      continue;

    }

    // Обнаружена проблема.

    if (

      status === 'warning' ||

      status === 'critical'

    ) {

      const incidentData =

        buildIncidentData(

          component,

          status

        );

      if (!incidentData) {

        result.ignored++;

        continue;

      }

      const incident =

        await openOrUpdateIncident(

          client,

          incidentData,

          checkedAt

        );

      if (!incident) {

        result.ignored++;

        continue;

      }

      if (incident.occurrences === 1) {

        result.opened++;

      } else {

        result.updated++;

      }

      continue;

    }

    result.ignored++;

  }

  return result;

}



async function getMonitoringIncidents({
  status = 'all',
  severity = 'all',
  limit = 50,
  offset = 0
} = {}) {

  const query = `
    SELECT
      id,
      component,
      title,
      description,
      severity,
      status,
      opened_at,
      last_seen_at,
      acknowledged_at,
      resolved_at,
      occurrences,
      created_at,
      updated_at,

      ROUND(
        EXTRACT(
          EPOCH FROM (
            COALESCE(resolved_at, NOW())
            - opened_at
          )
        ) / 60,
        2
      ) AS duration_minutes

    FROM monitoring_incidents

    WHERE (
      $1::text = 'all'
      OR status = $1::text
    )

    AND (
      $2::text = 'all'
      OR severity = $2::text
    )

    ORDER BY opened_at DESC, id DESC

    LIMIT $3::integer

    OFFSET $4::integer
  `;

  const result = await pool.query(
    query,
    [status, severity, limit, offset]
  );

  return result.rows.map(row => ({
    ...row,
    duration_minutes: Number(row.duration_minutes)
  }));

}


// ========================================
// ACKNOWLEDGE MONITORING INCIDENT
// ========================================

async function acknowledgeMonitoringIncident(id) {

  const result = await pool.query(

    `
      UPDATE monitoring_incidents

      SET

        status = 'acknowledged',

        acknowledged_at = GREATEST(
          NOW(),
          opened_at
        ),

        updated_at = NOW()

      WHERE id = $1::bigint

        AND status = 'open'

      RETURNING *;
    `,

    [id]

  );

  return result.rows[0] || null;

}


// ========================================
// INCIDENT PERFORMANCE METRICS
// ========================================

async function getIncidentPerformanceMetrics(hours) {

  const result = await pool.query(
    `
      WITH cohort AS (

        SELECT *

        FROM monitoring_incident_sla

        WHERE opened_at >=
          NOW() - make_interval(
            hours => $1::integer
          )

          AND opened_at <= NOW()

      ),

      metrics AS (

        SELECT

          COUNT(*)::integer
            AS total_incidents,

          COUNT(*) FILTER (
            WHERE acknowledged_at >= opened_at
          )::integer
            AS acknowledged_incidents,

          COUNT(*) FILTER (
            WHERE resolved_at >= opened_at
          )::integer
            AS resolved_incidents,

          ROUND(
            AVG(
              EXTRACT(
                EPOCH FROM (
                  acknowledged_at - opened_at
                )
              ) / 60
            ) FILTER (
              WHERE acknowledged_at >= opened_at
            ),
            2
          ) AS mtta_minutes,

          ROUND(
            AVG(
              EXTRACT(
                EPOCH FROM (
                  resolved_at - opened_at
                )
              ) / 60
            ) FILTER (
              WHERE resolved_at >= opened_at
            ),
            2
          ) AS mttr_minutes,

          COUNT(*) FILTER (
            WHERE response_sla_status = 'met'
          )::integer
            AS response_met,

          COUNT(*) FILTER (
            WHERE response_sla_status = 'breached'
          )::integer
            AS response_breached,

          COUNT(*) FILTER (
            WHERE resolution_sla_status = 'met'
          )::integer
            AS resolution_met,

          COUNT(*) FILTER (
            WHERE resolution_sla_status = 'breached'
          )::integer
            AS resolution_breached

        FROM cohort

      ),

      notifications AS (

        SELECT

          COUNT(*) FILTER (
            WHERE e.notification_status = 'sent'
          )::integer
            AS notifications_sent,

          COUNT(*) FILTER (
            WHERE e.notification_status IN (
              'pending',
              'processing',
              'failed'
            )
          )::integer
            AS notifications_pending,

          COUNT(*) FILTER (
            WHERE e.notification_status = 'dead'
          )::integer
            AS notifications_dead

        FROM monitoring_incident_escalations e

        INNER JOIN cohort c
          ON c.id = e.incident_id

      )

      SELECT

        metrics.*,

        notifications.*,

        ROUND(
          100.0 * response_met
          / NULLIF(
              response_met + response_breached,
              0
            ),
          2
        ) AS response_sla_percent,

        ROUND(
          100.0 * resolution_met
          / NULLIF(
              resolution_met + resolution_breached,
              0
            ),
          2
        ) AS resolution_sla_percent

      FROM metrics

      CROSS JOIN notifications
    `,
    [hours]
  );

  const data = result.rows[0];

  const numericFields = [
    'mtta_minutes',
    'mttr_minutes',
    'response_sla_percent',
    'resolution_sla_percent'
  ];

  for (const field of numericFields) {

    if (data[field] !== null) {

      data[field] = Number(data[field]);

    }

  }

  return data;

}


// ========================================
// INCIDENT SLA SERVICE
// ========================================

async function getMonitoringSla() {

  const result = await pool.query(

    `
      WITH active AS (

        SELECT *
        FROM monitoring_incident_sla
        WHERE status IN (
          'open',
          'acknowledged'
        )

      ),

      classified AS (

        SELECT

          active.*,

          CASE

            WHEN response_sla_status = 'breached'
              OR resolution_sla_status = 'breached'
            THEN 'breached'

            WHEN response_sla_status = 'unknown'
              OR resolution_sla_status = 'unknown'
            THEN 'unknown'

            WHEN response_sla_status = 'at_risk'
              OR resolution_sla_status = 'at_risk'
            THEN 'at_risk'

            ELSE 'on_track'

          END AS sla_status

        FROM active

      )

      SELECT

        jsonb_build_object(

          'active_incidents',
          COUNT(*),

          'on_track',
          COUNT(*) FILTER (
            WHERE sla_status = 'on_track'
          ),

          'at_risk',
          COUNT(*) FILTER (
            WHERE sla_status = 'at_risk'
          ),

          'breached',
          COUNT(*) FILTER (
            WHERE sla_status = 'breached'
          ),

          'unknown',
          COUNT(*) FILTER (
            WHERE sla_status = 'unknown'
          )

        ) AS summary,


        COALESCE(

          (
            SELECT jsonb_agg(
              to_jsonb(limited)
            )

            FROM (

              SELECT *

              FROM classified

              ORDER BY

                CASE sla_status
                  WHEN 'breached' THEN 1
                  WHEN 'at_risk' THEN 2
                  WHEN 'unknown' THEN 3
                  ELSE 4
                END,

                resolution_due_at ASC NULLS LAST,

                id ASC

              LIMIT 100

            ) AS limited

          ),

          '[]'::jsonb

        ) AS incidents

      FROM classified
    `

  );

  return result.rows[0];

}


// ========================================
// INCIDENT DETAILS
// ========================================

async function getMonitoringIncidentDetails(id) {

  const result = await pool.query(

    `
      SELECT
        i.*,

        ROUND(
          EXTRACT(
            EPOCH FROM (
              COALESCE(i.resolved_at, NOW())
              - i.opened_at
            )
          ) / 60,
          2
        ) AS duration_minutes,

        (
          SELECT COUNT(*)::integer
          FROM monitoring_incident_events
          WHERE incident_id = i.id
        ) AS events_total,

        COALESCE(
          (
            SELECT jsonb_agg(
              to_jsonb(e)
              ORDER BY e.created_at DESC, e.id DESC
            )
            FROM (
              SELECT
                id,
                event_type,
                actor,
                message,
                metadata,
                created_at
              FROM monitoring_incident_events
              WHERE incident_id = i.id
              ORDER BY created_at DESC, id DESC
              LIMIT 100
            ) e
          ),
          '[]'::jsonb
        ) AS events

      FROM monitoring_incidents i

      WHERE i.id = $1::bigint
    `,

    [id]

  );

  if (!result.rows.length) {
    return null;
  }

  const {
    events,
    events_total,
    ...incident
  } = result.rows[0];

  return {

    incident: {
      ...incident,

      duration_minutes:
        incident.duration_minutes === null
          ? null
          : Number(incident.duration_minutes)
    },

    events,

    events_total

  };

}


// ========================================
// COUNT MONITORING INCIDENTS
// ========================================

async function countMonitoringIncidents({
  status = 'all',
  severity = 'all'
} = {}) {

  const result = await pool.query(
    `
      SELECT COUNT(*)::integer AS total

      FROM monitoring_incidents

      WHERE (
        $1::text = 'all'
        OR status = $1::text
      )

      AND (
        $2::text = 'all'
        OR severity = $2::text
      )
    `,
    [status, severity]
  );

  return result.rows[0].total;

}


async function getMonitoringIncidentSummary() {

  const query = `
    SELECT

      COUNT(*)::integer
        AS total_incidents,

      COUNT(*) FILTER (
        WHERE status = 'open'
      )::integer
        AS open_incidents,

      COUNT(*) FILTER (
        WHERE status = 'acknowledged'
      )::integer
        AS acknowledged_incidents,

      COUNT(*) FILTER (
        WHERE status = 'resolved'
      )::integer
        AS resolved_incidents,

      COUNT(*) FILTER (
        WHERE status IN (
          'open',
          'acknowledged'
        )
      )::integer
        AS active_incidents,

      COUNT(*) FILTER (
        WHERE severity = 'critical'
        AND status IN (
          'open',
          'acknowledged'
        )
      )::integer
        AS critical_active_incidents

    FROM monitoring_incidents
  `;

  const result =
    await pool.query(query);

  return result.rows[0];

}


async function getMonitoringHistory(hours) {
  const query = `
    SELECT
      checked_at,
      overall_status,
      problems_count
    FROM monitoring_snapshots

    WHERE checked_at >=
      NOW() - ($1::integer * INTERVAL '1 hour')

      AND checked_at <= NOW()

    ORDER BY checked_at ASC
  `;

  const result = await pool.query(
    query,
    [hours]
  );

  return result.rows;
}

async function getMonitoringMetrics(hours) {
  const query = `
    WITH bounds AS (
      SELECT date_bin(
        INTERVAL '15 minutes',
        NOW(),
        TIMESTAMPTZ '2000-01-01 00:00:00+00'
      ) AS end_at
    ),

    snapshots AS (
      SELECT *
      FROM monitoring_snapshots
      WHERE checked_at >=
        NOW() - ($1::integer * INTERVAL '1 hour')
        AND checked_at <= NOW()
    ),

    coverage AS (
      SELECT COUNT(DISTINCT date_bin(
        INTERVAL '15 minutes',
        checked_at,
        TIMESTAMPTZ '2000-01-01 00:00:00+00'
      ))::integer AS filled_intervals

      FROM monitoring_snapshots
      CROSS JOIN bounds

      WHERE checked_at >=
        end_at - ($1::integer * INTERVAL '1 hour')
        AND checked_at < end_at
    ),

    component_stats AS (
      SELECT
        component.key AS name,

        COUNT(*)::integer AS total,

        COUNT(*) FILTER (
          WHERE component.value ->> 'status'
            = 'healthy'
        )::integer AS healthy,

        COUNT(*) FILTER (
          WHERE component.value ->> 'status'
            = 'warning'
        )::integer AS warning,

        COUNT(*) FILTER (
          WHERE component.value ->> 'status'
            = 'critical'
        )::integer AS critical,

        COUNT(*) FILTER (
          WHERE component.value ->> 'status'
            = 'unknown'
        )::integer AS unknown

      FROM snapshots

      CROSS JOIN LATERAL
        jsonb_each(components) AS component

      WHERE component.key IN (
        'system_health',
        'availability',
        'performance_frontend',
        'performance_backend',
        'daily_reports'
      )

      GROUP BY component.key
    )

    SELECT
      coverage.filled_intervals,

      (
        SELECT COUNT(*)::integer
        FROM snapshots
      ) AS total_checks,

      COALESCE(
        (
          SELECT jsonb_agg(
            to_jsonb(component_stats)
          )
          FROM component_stats
        ),
        '[]'::jsonb
      ) AS components

    FROM coverage
  `;

  const result = await pool.query(
    query,
    [hours]
  );

  const row = result.rows[0];

  const expectedChecks = hours * 4;

  const filledIntervals = Math.min(
    expectedChecks,
    row.filled_intervals
  );

  const missedChecks =
    expectedChecks - filledIntervals;

  const coveragePercent = Number(
    (
      filledIntervals /
      expectedChecks * 100
    ).toFixed(2)
  );

  const components = row.components.map(
    component => ({
      ...component,

      healthy_percent:
        component.total > 0
          ? Number(
              (
                component.healthy /
                component.total * 100
              ).toFixed(2)
            )
          : null
    })
  );

  const availability = components.find(
    component =>
      component.name === "availability"
  );

  const knownAvailabilityChecks =
    availability
      ? availability.healthy +
        availability.warning +
        availability.critical
      : 0;

  const availabilityPercent =
    knownAvailabilityChecks > 0
      ? Number(
          (
            availability.healthy /
            knownAvailabilityChecks * 100
          ).toFixed(2)
        )
      : null;

  return {
    period_hours: hours,

    total_checks: row.total_checks,

    expected_checks: expectedChecks,

    filled_intervals: filledIntervals,

    missed_checks: missedChecks,

    coverage_percent: coveragePercent,

    availability_percent:
      availabilityPercent,

    availability_known_checks:
      knownAvailabilityChecks,

    components
  };
}


async function cleanupMonitoringHistory() {
  try {
    const result = await pool.query(`
      DELETE FROM monitoring_snapshots
      WHERE checked_at < NOW() - INTERVAL '90 days'
    `);

    console.log(
      'Monitoring cleanup: deleted',
      result.rowCount,
      'old records'
    );

  } catch (error) {
    console.error(
      'Monitoring cleanup failed:',
      error.code || error.message
    );
  }
}

setInterval(
  cleanupMonitoringHistory,
  24 * 60 * 60 * 1000
).unref();


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

// Защищённые CSS-стили административной панели
app.get('/admin/monitoring.css', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.sendFile(
    path.join(__dirname, 'frontend', 'monitoring.css')
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


app.get(
  '/api/monitoring/analytics',
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    const periods = {
      '24h': 24,
      '7d': 168,
      '30d': 720
    };

    const period = req.query.period ?? '24h';

    if (
      typeof period !== 'string' ||
      !Object.hasOwn(periods, period)
    ) {
      return res.status(400).json({
        error: 'Invalid period',
        allowed: ['24h', '7d', '30d']
      });
    }

    const hours = periods[period];

    try {
      const [analytics, comparison] =
  await Promise.all([
    getMonitoringAnalytics(hours),
    getMonitoringComparison(hours)
  ]);

return res.json({
  ok: true,
  period,
  generated_at: new Date().toISOString(),
  analytics,
  comparison
});

    } catch (error) {
      console.error(
        'Monitoring analytics error:',
        error.code || error.message
      );

      return res.status(503).json({
        ok: false,
        error: 'Analytics unavailable'
      });
    }
  }
);



// ========================================
// INCIDENT LIST API
// ========================================

app.get(
  '/api/monitoring/incidents',
  requireAdmin,

  async (req, res) => {

    res.set('Cache-Control', 'no-store');

    const status = req.query.status ?? 'all';

    const severity = req.query.severity ?? 'all';

    const allowedStatuses = [
      'all',
      'open',
      'acknowledged',
      'resolved'
    ];

    const allowedSeverities = [
      'all',
      'warning',
      'critical'
    ];

    if (
      typeof status !== 'string' ||
      !allowedStatuses.includes(status)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid incident status'
      });
    }

    if (
      typeof severity !== 'string' ||
      !allowedSeverities.includes(severity)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid incident severity'
      });
    }

    const rawLimit = req.query.limit ?? '50';

    const rawOffset = req.query.offset ?? '0';

    if (
      typeof rawLimit !== 'string' ||
      typeof rawOffset !== 'string' ||
      !/^\d+$/.test(rawLimit) ||
      !/^\d+$/.test(rawOffset)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid pagination parameters'
      });
    }

    const limit = Number(rawLimit);

    const offset = Number(rawOffset);

    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Pagination parameters out of range'
      });
    }

    try {

      const [incidents, total] = await Promise.all([

        getMonitoringIncidents({
          status,
          severity,
          limit,
          offset
        }),

        countMonitoringIncidents({
          status,
          severity
        })

      ]);

      return res.json({
        ok: true,
        generated_at: new Date().toISOString(),
        status,
        severity,
        limit,
        offset,
        count: incidents.length,
        total,
        incidents
      });

    } catch (error) {

      console.error(
        'Incident list API error:',
        error.message
      );

      return res.status(503).json({
        ok: false,
        error: 'Incident service unavailable'
      });

    }

  }
);



// ========================================
// INCIDENT SUMMARY API
// ========================================

// ========================================
// ACKNOWLEDGE INCIDENT API
// ========================================

app.post(

  '/api/monitoring/incidents/:id/acknowledge',

  requireAdmin,

  async (req, res) => {

    res.set('Cache-Control', 'no-store');

    // Проверка источника запроса:
    // разрешаем изменение только из нашей панели.

    const allowedOrigin =
      'https://aura-coffee-api-2lty.onrender.com';

    const requestOrigin = req.get('Origin');

    if (requestOrigin !== allowedOrigin) {

      return res.status(403).json({

        ok: false,

        error: 'Forbidden request origin'

      });

    }

    if (!req.is('application/json')) {

      return res.status(415).json({

        ok: false,

        error: 'JSON content type required'

      });

    }

    const id = req.params.id;

    if (
      typeof id !== 'string' ||
      !/^[1-9]\d{0,18}$/.test(id)
    ) {

      return res.status(400).json({

        ok: false,

        error: 'Invalid incident ID'

      });

    }

    if (BigInt(id) > 9223372036854775807n) {

      return res.status(400).json({

        ok: false,

        error: 'Incident ID out of range'

      });

    }

    try {

      const incident =
        await acknowledgeMonitoringIncident(id);

      if (!incident) {

        return res.status(409).json({

          ok: false,

          error:
            'Incident does not exist or is no longer open'

        });

      }

      console.log(

        'Monitoring incident acknowledged:',

        incident.id

      );

      return res.json({

        ok: true,

        incident

      });

    } catch (error) {

      console.error(

        'Incident acknowledge API error:',

        error.message

      );

      return res.status(503).json({

        ok: false,

        error: 'Incident service unavailable'

      });

    }

  }

);

app.get(

  '/api/monitoring/incidents/summary',

  requireAdmin,

  async (req, res) => {

    res.set(
      'Cache-Control',
      'no-store'
    );

    try {

      const summary =
        await getMonitoringIncidentSummary();

      return res.json({

        ok: true,

        generated_at:
          new Date().toISOString(),

        summary

      });

    } catch (error) {

      console.error(

        'Incident summary API error:',

        error.message

      );

      return res.status(503).json({

        ok: false,

        error: 'Incident summary unavailable'

      });

    }

  }

);


// ========================================
// INCIDENT PERFORMANCE METRICS API
// ========================================

app.get(
  '/api/monitoring/incident-metrics',

  requireAdmin,

  async (req, res) => {

    res.set(
      'Cache-Control',
      'no-store'
    );

    const period =
      req.query.period ?? '30d';

    const periods = {
      '24h': 24,
      '7d': 168,
      '30d': 720
    };

    if (
      typeof period !== 'string' ||
      !Object.prototype.hasOwnProperty.call(
        periods,
        period
      )
    ) {

      return res.status(400).json({
        ok: false,
        error: 'Invalid period'
      });

    }

    try {

      const metrics =
        await getIncidentPerformanceMetrics(
          periods[period]
        );

      return res.json({

        ok: true,

        period,

        generated_at:
          new Date().toISOString(),

        metrics

      });

    } catch (error) {

      console.error(
        'Incident performance metrics error:',
        error.message
      );

      return res.status(503).json({

        ok: false,

        error:
          'Incident metrics unavailable'

      });

    }

  }

);


// ========================================
// INCIDENT SLA API
// ========================================

app.get(

  '/api/monitoring/sla',

  requireAdmin,

  async (req, res) => {

    res.set(
      'Cache-Control',
      'no-store'
    );

    try {

      const data =
        await getMonitoringSla();

      return res.json({

        ok: true,

        generated_at:
          new Date().toISOString(),

        summary: data.summary,

        incidents: data.incidents

      });

    } catch (error) {

      console.error(
        'Monitoring SLA API error:',
        error.message
      );

      return res.status(503).json({

        ok: false,

        error:
          'Monitoring SLA service unavailable'

      });

    }

  }

);


// ========================================
// INCIDENT DETAILS API
// ========================================

app.get(

  '/api/monitoring/incidents/:id',

  requireAdmin,

  async (req, res) => {

    res.set('Cache-Control', 'no-store');

    const id = req.params.id;

    if (
      !/^[1-9]\d{0,18}$/.test(id) ||
      BigInt(id) > 9223372036854775807n
    ) {

      return res.status(400).json({
        ok: false,
        error: 'Invalid incident ID'
      });

    }

    try {

      const details =
        await getMonitoringIncidentDetails(id);

      if (!details) {

        return res.status(404).json({
          ok: false,
          error: 'Incident not found'
        });

      }

      return res.json({

        ok: true,

        generated_at: new Date().toISOString(),

        ...details

      });

    } catch (error) {

      console.error(
        'Incident details API error:',
        error.message
      );

      return res.status(503).json({
        ok: false,
        error: 'Incident service unavailable'
      });

    }

  }

);


app.get(
  '/api/monitoring/history',
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    const periods = {
      '24h': 24,
      '7d': 168,
      '30d': 720
    };

    const period = req.query.period ?? '24h';

    if (
      typeof period !== 'string' ||
      !Object.hasOwn(periods, period)
    ) {
      return res.status(400).json({
        error: 'Invalid period',
        allowed: ['24h', '7d', '30d']
      });
    }

    try {
      const history =
        await getMonitoringHistory(
          periods[period]
        );

      return res.json({
        ok: true,
        period,
        generated_at: new Date().toISOString(),
        total: history.length,
        history
      });

    } catch (error) {
      console.error(
        'Monitoring history error:',
        error.code || error.message
      );

      return res.status(503).json({
        ok: false,
        error: 'History unavailable'
      });
    }
  }
);

app.get(
  '/api/monitoring/metrics',
  requireAdmin,
  async (req, res) => {
    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    const periods = {
      '24h': 24,
      '7d': 168,
      '30d': 720
    };

    const period = req.query.period ?? '24h';

    if (
      typeof period !== 'string' ||
      !Object.hasOwn(periods, period)
    ) {
      return res.status(400).json({
        error: 'Invalid period',
        allowed: ['24h', '7d', '30d']
      });
    }

    try {
      const metrics =
        await getMonitoringMetrics(
          periods[period]
        );

      return res.json({
        ok: true,
        period,
        generated_at: new Date().toISOString(),
        metrics
      });

    } catch (error) {
      console.error(
        'Monitoring metrics error:',
        error.code || error.message
      );

      return res.status(503).json({
        ok: false,
        error: 'Metrics unavailable'
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


// ========================================
// AUTOMATED RECOVERY SYSTEM
// ========================================

const recoveryAllowedComponents = new Set([

  "system_health",

  "availability",

  "performance_frontend",

  "performance_backend"

]);


const recoveryAllowedOrigin =
  "https://aura-coffee-api-2lty.onrender.com";


// ========================================
// MUTATION SECURITY
// ========================================

function requireRecoveryMutation(
  req,
  res,
  next
) {

  if (
    req.get("origin") !==
    recoveryAllowedOrigin
  ) {

    return res.status(403).json({

      ok: false,

      error: "Invalid origin"

    });

  }

  if (!req.is("application/json")) {

    return res.status(415).json({

      ok: false,

      error: "JSON required"

    });

  }

  next();

}


// ========================================
// RECOVERY DASHBOARD API
// ========================================

app.get(

  "/api/monitoring/recovery",

  requireAdmin,

  async (req, res) => {

    res.set(
      "Cache-Control",
      "no-store"
    );

    try {

      const [

        summaryResult,

        jobsResult,

        policiesResult,

        eventsResult,

        incidentsResult

      ] = await Promise.all([

        pool.query(`

          SELECT

            COUNT(*)::integer
              AS total_jobs,

            COUNT(*) FILTER (

              WHERE status = 'recovered'

            )::integer
              AS recovered_jobs,

            COUNT(*) FILTER (

              WHERE status = 'failed'

            )::integer
              AS failed_jobs,

            COUNT(*) FILTER (

              WHERE status IN (
                'pending',
                'retry',
                'processing',
                'verifying'
              )

            )::integer
              AS active_jobs,

            ROUND(

              100.0 *

              COUNT(*) FILTER (

                WHERE status = 'recovered'

              )

              / NULLIF(

                COUNT(*) FILTER (

                  WHERE status IN (
                    'recovered',
                    'failed'
                  )

                ),

                0

              ),

              2

            ) AS success_rate,

            ROUND(

              AVG(

                EXTRACT(EPOCH FROM (

                  completed_at -
                  first_started_at

                )) / 60

              ) FILTER (

                WHERE status = 'recovered'

              ),

              2

            ) AS average_recovery_minutes

          FROM monitoring_recovery_jobs

        `),


        pool.query(`

          SELECT

            j.id::text,

            j.incident_id::text,

            j.component,

            j.action_type,

            j.status,

            j.trigger_source,

            j.attempt_count,

            j.max_attempts,

            j.next_attempt_at,

            j.last_error,

            j.created_at,

            j.completed_at,

            i.title AS incident_title

          FROM monitoring_recovery_jobs j

          INNER JOIN monitoring_incidents i
            ON i.id = j.incident_id

          ORDER BY j.id DESC

          LIMIT 50

        `),


        pool.query(`

          SELECT

            component,

            action_type,

            enabled,

            max_attempts,

            cooldown_minutes,

            failure_threshold,

            consecutive_failures,

            circuit_open_until,

            last_started_at,

            COALESCE(

              circuit_open_until > NOW(),

              FALSE

            ) AS circuit_open

          FROM monitoring_recovery_policies

          ORDER BY component

        `),


        pool.query(`

          SELECT

            id::text,

            job_id::text,

            event_type,

            message,

            created_at

          FROM monitoring_recovery_events

          ORDER BY id DESC

          LIMIT 50

        `),


        pool.query(`

          SELECT

            i.id::text,

            i.component,

            i.title,

            i.severity

          FROM monitoring_incidents i

          INNER JOIN monitoring_recovery_policies p
            ON p.component = i.component

          WHERE i.status IN (
            'open',
            'acknowledged'
          )

          AND p.enabled = TRUE

          AND NOT EXISTS (

            SELECT 1

            FROM monitoring_recovery_jobs j

            WHERE j.incident_id = i.id

            AND j.action_type = p.action_type

          )

          ORDER BY i.id DESC

          LIMIT 50

        `)

      ]);


      const summary =
        summaryResult.rows[0];


      for (const field of [

        "success_rate",

        "average_recovery_minutes"

      ]) {

        if (summary[field] !== null) {

          summary[field] =
            Number(summary[field]);

        }

      }


      return res.json({

        ok: true,

        generated_at:
          new Date().toISOString(),

        summary,

        jobs: jobsResult.rows,

        policies: policiesResult.rows,

        events: eventsResult.rows,

        eligible_incidents:
          incidentsResult.rows

      });


    } catch (error) {

      console.error(

        "Recovery dashboard error:",

        error.message

      );

      return res.status(503).json({

        ok: false,

        error: "Recovery service unavailable"

      });

    }

  }

);


// ========================================
// UPDATE RECOVERY POLICY
// ========================================

app.post(

  "/api/monitoring/recovery/policies/:component",

  requireAdmin,

  requireRecoveryMutation,

  async (req, res) => {

    res.set(
      "Cache-Control",
      "no-store"
    );

    const component =
      req.params.component;

    const enabled =
      req.body?.enabled;

    if (

      !recoveryAllowedComponents.has(
        component
      )

      || typeof enabled !== "boolean"

    ) {

      return res.status(400).json({

        ok: false,

        error: "Invalid recovery policy"

      });

    }

    try {

      const result = await pool.query(

        `

          UPDATE monitoring_recovery_policies

          SET

            enabled = $2,

            updated_at = NOW()

          WHERE component = $1

          RETURNING
            component,
            action_type,
            enabled

        `,

        [component, enabled]

      );

      if (!result.rowCount) {

        return res.status(404).json({

          ok: false,

          error: "Policy not found"

        });

      }

      console.log(

        "Recovery policy updated:",

        component,

        enabled

      );

      return res.json({

        ok: true,

        policy: result.rows[0]

      });

    } catch (error) {

      console.error(

        "Recovery policy error:",

        error.message

      );

      return res.status(503).json({

        ok: false,

        error: "Policy update unavailable"

      });

    }

  }

);


// ========================================
// MANUAL RECOVERY REQUEST
// ========================================

app.post(

  "/api/monitoring/recovery/manual",

  requireAdmin,

  requireRecoveryMutation,

  async (req, res) => {

    res.set(
      "Cache-Control",
      "no-store"
    );

    const incidentId =
      req.body?.incident_id;

    if (

      typeof incidentId !== "string"

      || !/^[1-9]\d{0,18}$/.test(
        incidentId
      )

      || BigInt(incidentId) >
        9223372036854775807n

    ) {

      return res.status(400).json({

        ok: false,

        error: "Invalid incident ID"

      });

    }

    try {

      const result = await pool.query(

        `

          INSERT INTO monitoring_recovery_jobs (

            incident_id,

            component,

            action_type,

            max_attempts,

            trigger_source

          )

          SELECT

            i.id,

            i.component,

            p.action_type,

            p.max_attempts,

            'manual'

          FROM monitoring_incidents i

          INNER JOIN monitoring_recovery_policies p

            ON p.component = i.component

          WHERE i.id = $1::bigint

          AND i.status IN (
            'open',
            'acknowledged'
          )

          AND p.enabled = TRUE

          AND (

            p.circuit_open_until IS NULL

            OR p.circuit_open_until <= NOW()

          )

          ON CONFLICT (
            incident_id,
            action_type
          )

          DO NOTHING

          RETURNING

            id::text,

            incident_id::text,

            component,

            status

        `,

        [incidentId]

      );


      if (!result.rowCount) {

        return res.status(409).json({

          ok: false,

          error:
            "Recovery not permitted or already queued"

        });

      }


      console.log(

        "Manual recovery requested:",

        incidentId

      );


      return res.status(201).json({

        ok: true,

        job: result.rows[0]

      });


    } catch (error) {

      console.error(

        "Manual recovery error:",

        error.message

      );

      return res.status(503).json({

        ok: false,

        error: "Recovery request unavailable"

      });

    }

  }

);


// Запуск сервера
app.listen(port, () => {
  console.log(`AURA COFFEE: http://localhost:${port}`);
});