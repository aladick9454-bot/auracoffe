
// ========================================
// AURA COFFEE — MONITORING DASHBOARD
// Lesson 71 — Practices 1–25
// ========================================


// ========================================
// 1. CONSTANTS AND STATE
// ========================================

const API_URL = "/api/monitoring/admin";

const ANALYTICS_API_URL =
  "/api/monitoring/analytics";

const HISTORY_API_URL =
  "/api/monitoring/history";

const METRICS_API_URL =
  "/api/monitoring/metrics";

const MAX_DATA_AGE_MS = 45 * 60 * 1000;

const MAX_FUTURE_OFFSET_MS = 60 * 1000;

const REQUEST_TIMEOUT_MS = 15000;

const REFRESH_INTERVAL_MS = 60 * 1000;

const ANALYTICS_REFRESH_INTERVAL_MS =
  5 * 60 * 1000;

const MONITORING_INTERVAL_MS =
  15 * 60 * 1000;

const MONITORING_GAP_THRESHOLD_MS =
  1.5 * MONITORING_INTERVAL_MS;

const ALLOWED_PERIODS = [
  "24h",
  "7d",
  "30d"
];

const ALLOWED_PAGE_SIZES = [
  10,
  25,
  50,
  100
];

let monitoringLoading = false;

let selectedAnalyticsPeriod = "24h";

let lastAnalyticsRefreshAt = 0;

let monitoringHistoryChart = null;

let monitoringStatusChart = null;

let monitoringHistoryRows = [];

let historyCurrentPage = 1;

let historyPageSize = 25;

let historyTableState = "loading";

let dashboardInitialized = false;

const requests = {
  analytics: {
    id: 0,
    controller: null
  },

  history: {
    id: 0,
    controller: null
  },

  metrics: {
    id: 0,
    controller: null
  }
};

const statusLabels = {
  healthy: "Работает",
  warning: "Предупреждение",
  critical: "Критическая ошибка",
  unknown: "Нет данных"
};

const componentElements = {
  system_health: "crm-status",
  availability: "availability-status",
  performance_frontend: "frontend-status",
  performance_backend: "backend-status",
  daily_reports: "reports-status"
};

const historyStatusColors = {
  healthy: "#22c55e",
  warning: "#eab308",
  critical: "#ef4444",
  unknown: "#94a3b8"
};

const metricsComponentNames = {
  system_health: "CRM",
  availability: "Сайт и API",
  performance_frontend: "Frontend",
  performance_backend: "Backend",
  daily_reports: "Ежедневные отчёты"
};


// ========================================
// 2. HELPER FUNCTIONS
// ========================================

function setAnalyticsText(id, value) {

  const element =
    document.getElementById(id);

  if (element) {
    element.textContent = value ?? "—";
  }

}

function setMessage(id, message = "") {

  const element =
    document.getElementById(id);

  if (!element) return;

  element.textContent = message;

  element.hidden = !message;

}

function formatMetricsPercent(value) {

  return Number.isFinite(value)
    ? value.toFixed(2) + "%"
    : "—";

}

function getSafeStatus(status) {

  return Object.hasOwn(statusLabels, status)
    ? status
    : "unknown";

}

function formatDateTime(value) {

  if (!value) return "—";

  const timestamp =
    new Date(value).getTime();

  return Number.isFinite(timestamp)
    ? new Date(timestamp)
        .toLocaleString("ru-RU")
    : "—";

}

function updateStatus(elementId, status) {

  const element =
    document.getElementById(elementId);

  if (!element) return;

  const safeStatus =
    getSafeStatus(status);

  element.textContent =
    statusLabels[safeStatus];

  element.className =
    elementId === "overall-status"
      ? `status ${safeStatus}`
      : safeStatus;

}


// ========================================
// 3. DATA FRESHNESS
// ========================================

function getMonitoringFreshness(checkedAt) {

  if (!checkedAt) {
    return "missing";
  }

  const timestamp =
    new Date(checkedAt).getTime();

  if (!Number.isFinite(timestamp)) {
    return "invalid";
  }

  const age =
    Date.now() - timestamp;

  if (age < -MAX_FUTURE_OFFSET_MS) {
    return "invalid";
  }

  if (age > MAX_DATA_AGE_MS) {
    return "stale";
  }

  return "fresh";

}

function updateFreshnessWarning(freshness) {

  const messages = {

    stale:
      "Данные мониторинга устарели. Текущее состояние системы неизвестно.",

    missing:
      "Данные мониторинга отсутствуют.",

    invalid:
      "Ошибка времени последней проверки.",

    unavailable:
      "Не удалось получить данные мониторинга."

  };

  setMessage(
    "freshness-warning",

    freshness === "fresh"
      ? ""
      : messages[freshness]
        || "Состояние неизвестно."
  );

}


// ========================================
// 4. MAIN MONITORING
// ========================================

function renderDashboard(data) {

  updateStatus(
    "overall-status",
    data.overall_status
  );

  for (const [key, elementId] of Object.entries(
    componentElements
  )) {

    updateStatus(
      elementId,

      data.components?.[key]?.status
        ?? "unknown"
    );

  }

  setAnalyticsText(
    "problems-count",

    Number.isInteger(data.problems_count) &&
    data.problems_count >= 0

      ? data.problems_count
      : "—"
  );

  setAnalyticsText(
    "last-update",

    data.checked_at
      ? "Последняя проверка: " +
        formatDateTime(data.checked_at)

      : "Последняя проверка: нет данных"
  );

}

function resetMonitoringDashboard(
  checkedAt = null
) {

  renderDashboard({
    checked_at: checkedAt,
    overall_status: "unknown",
    problems_count: null,
    components: {}
  });

}

async function loadMonitoring() {

  if (monitoringLoading) return;

  monitoringLoading = true;

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {

    const response = await fetch(
      API_URL,
      {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal
      }
    );

    if (response.status === 401) {

      window.location.replace(
        "/admin/login"
      );

      return;

    }

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      throw new Error(
        "Invalid monitoring response"
      );
    }

    const freshness =
      getMonitoringFreshness(
        data.checked_at
      );

    updateFreshnessWarning(
      freshness
    );

    if (freshness !== "fresh") {

      resetMonitoringDashboard(
        freshness === "stale"
          ? data.checked_at
          : null
      );

      return;

    }

    renderDashboard(data);

    console.log(
      "Monitoring loaded:",
      data
    );

  } catch (error) {

    console.error(
      "Monitoring error:",
      error
    );

    resetMonitoringDashboard();

    updateFreshnessWarning(
      "unavailable"
    );

  } finally {

    clearTimeout(timeout);

    monitoringLoading = false;

  }

}


// ========================================
// 5. PERIOD API REQUESTS
// ========================================

async function loadPeriodData(
  key,
  apiUrl,
  validate,
  onSuccess,
  onError
) {

  const state = requests[key];

  const requestId = ++state.id;

  const period =
    selectedAnalyticsPeriod;

  if (state.controller) {
    state.controller.abort();
  }

  const controller =
    new AbortController();

  state.controller = controller;

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {

    const response = await fetch(

      `${apiUrl}?period=${encodeURIComponent(period)}`,

      {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal
      }

    );

    if (requestId !== state.id) {
      return;
    }

    if (response.status === 401) {

      window.location.replace(
        "/admin/login"
      );

      return;

    }

    if (!response.ok) {

      throw new Error(
        `HTTP ${response.status}`
      );

    }

    const result =
      await response.json();

    if (requestId !== state.id) {
      return;
    }

    if (
      !result ||
      !result.ok ||
      result.period !== period ||
      !validate(result)
    ) {

      throw new Error(
        `Invalid ${key} response`
      );

    }

    onSuccess(result);

  } catch (error) {

    if (requestId !== state.id) {
      return;
    }

    console.error(
      `${key} error:`,
      error
    );

    onError(error);

  } finally {

    clearTimeout(timeout);

    if (requestId === state.id) {

      state.controller = null;

    }

  }

}


// ========================================
// 6. ANALYTICS CARDS
// ========================================

function renderTrend(
  id,
  value,
  higherIsBetter,
  suffix = ""
) {

  const element =
    document.getElementById(id);

  if (!element) return;

  element.classList.remove(
    "trend-positive",
    "trend-negative",
    "trend-neutral"
  );

  if (!Number.isFinite(value)) {

    element.textContent = "—";

    element.classList.add(
      "trend-neutral"
    );

    return;

  }

  const sign = value > 0 ? "+" : "";

  element.textContent =
    sign + value + suffix;

  if (value === 0) {

    element.classList.add(
      "trend-neutral"
    );

    return;

  }

  const improved =
    higherIsBetter
      ? value > 0
      : value < 0;

  element.classList.add(

    improved
      ? "trend-positive"
      : "trend-negative"

  );

}

function resetComparison() {

  renderTrend(
    "comparison-healthy",
    null,
    true
  );

  renderTrend(
    "comparison-warning",
    null,
    false
  );

  renderTrend(
    "comparison-critical",
    null,
    false
  );

  [
    "comparison-healthy-previous",
    "comparison-warning-previous",
    "comparison-critical-previous"
  ].forEach(id => {
    setAnalyticsText(id, "");
  });

  setAnalyticsText(
    "comparison-description",
    "Недостаточно данных для сравнения."
  );

}

function renderComparison(data) {

  if (!data?.comparable) {

    resetComparison();

    return;

  }

  const periods = {

    "24h": "24 часа",

    "7d": "7 дней",

    "30d": "30 дней"

  };

  setAnalyticsText(

    "comparison-description",

    `Последние ${periods[selectedAnalyticsPeriod]} относительно предыдущего аналогичного периода. Проверок: ${data.current.total_checks} против ${data.previous.total_checks}.`

  );

  renderTrend(

    "comparison-healthy",

    data.changes.healthy_percent,

    true,

    " п. п."

  );

  renderTrend(

    "comparison-warning",

    data.changes.warning_checks,

    false

  );

  renderTrend(

    "comparison-critical",

    data.changes.critical_checks,

    false

  );

  setAnalyticsText(

    "comparison-healthy-previous",

    "Ранее: " +

      formatMetricsPercent(
        data.previous.healthy_percent
      )

  );

  setAnalyticsText(

    "comparison-warning-previous",

    "Ранее: " +
      data.previous.warning_checks

  );

  setAnalyticsText(

    "comparison-critical-previous",

    "Ранее: " +
      data.previous.critical_checks

  );

}


function renderAnalytics(data) {

  setAnalyticsText(
    "analytics-total",
    data.total_checks
  );

  setAnalyticsText(
    "analytics-healthy",
    data.healthy_checks
  );

  setAnalyticsText(
    "analytics-warning",
    data.warning_checks
  );

  setAnalyticsText(
    "analytics-critical",
    data.critical_checks
  );

  setAnalyticsText(
    "analytics-unknown",
    data.unknown_checks
  );

  setAnalyticsText(
    "analytics-percent",

    formatMetricsPercent(
      data.healthy_percent
    )
  );

  renderAnalyticsBar(data);

  renderStatusChart(data);

}

function renderAnalyticsBar(data) {

  const total =
    Number(data.total_checks) || 0;

  const segments = {

    "bar-healthy":
      data.healthy_checks,

    "bar-warning":
      data.warning_checks,

    "bar-critical":
      data.critical_checks,

    "bar-unknown":
      data.unknown_checks

  };

  for (const [id, count] of Object.entries(
    segments
  )) {

    const element =
      document.getElementById(id);

    if (!element) continue;

    const percent =
      total > 0

        ? Math.min(
            100,
            Math.max(
              0,
              (Number(count) || 0)
                / total * 100
            )
          )

        : 0;

    element.style.width =
      percent + "%";

  }

}

function resetAnalytics() {

  const ids = [
    "analytics-total",
    "analytics-healthy",
    "analytics-warning",
    "analytics-critical",
    "analytics-unknown",
    "analytics-percent"
  ];

  ids.forEach(id => {
    setAnalyticsText(id, "—");
  });

  renderAnalyticsBar({

    total_checks: 0,

    healthy_checks: 0,

    warning_checks: 0,

    critical_checks: 0,

    unknown_checks: 0

  });

  clearStatusChart();
  resetComparison();
}

function loadAnalytics() {

  return loadPeriodData(

    "analytics",

    ANALYTICS_API_URL,

    result =>
      result.analytics &&
      typeof result.analytics === "object",

    result => {

      renderAnalytics(
        result.analytics
      );
      renderComparison(
      result.comparison
      );

      setAnalyticsText(

        "analytics-updated",

        "Аналитика обновлена: " +
          formatDateTime(
            result.generated_at
          )

      );

      setMessage(
        "analytics-error"
      );

      console.log(
        "Analytics loaded:",
        result
      );

    },

    () => {

      resetAnalytics();

      setMessage(
        "analytics-error",
        "Не удалось загрузить аналитику."
      );

      setAnalyticsText(
        "analytics-updated",
        "Аналитика недоступна"
      );

    }

  );

}


// ========================================
// 7. DOUGHNUT CHART
// ========================================

function clearStatusChart() {

  if (monitoringStatusChart) {

    monitoringStatusChart.destroy();

    monitoringStatusChart = null;

  }

  setMessage(
    "status-chart-message"
  );

}

function renderStatusChart(data) {

  const canvas =
    document.getElementById(
      "monitoring-status-chart"
    );

  if (!canvas) return;

  clearStatusChart();

  if (typeof Chart === "undefined") {

    setMessage(
      "status-chart-message",
      "Не удалось загрузить библиотеку графиков."
    );

    return;

  }

  if (!data.total_checks) {

    setMessage(
      "status-chart-message",
      "За выбранный период нет проверок."
    );

    return;

  }

  monitoringStatusChart = new Chart(

    canvas,

    {

      type: "doughnut",

      data: {

        labels: [

          "Успешные",

          "Предупреждения",

          "Критические",

          "Неизвестные"

        ],

        datasets: [{

          data: [

            data.healthy_checks,

            data.warning_checks,

            data.critical_checks,

            data.unknown_checks

          ],

          backgroundColor: [

            "#22c55e",

            "#eab308",

            "#ef4444",

            "#94a3b8"

          ],

          borderWidth: 0,

          hoverOffset: 6

        }]

      },

      options: {

        responsive: true,

        maintainAspectRatio: false,

        animation: false,

        cutout: "70%",

        plugins: {

          legend: {

            position: "bottom",

            labels: {

              color: "#d1d5db",

              padding: 16

            }

          }

        }

      }

    }

  );

}


// ========================================
// 8. HISTORY POINTS AND GAPS
// ========================================

function buildHistoryPoints(history) {

  return history

    .map(item => ({

      x: item.checked_at
        ? new Date(
            item.checked_at
          ).getTime()
        : NaN,

      y: item.problems_count,

      status: getSafeStatus(
        item.overall_status
      )

    }))

    .filter(point =>

      Number.isFinite(point.x) &&

      Number.isInteger(point.y) &&

      point.y >= 0

    )

    .sort((a, b) => a.x - b.x);

}

function insertMonitoringGaps(points) {

  const result = [];

  let gapsCount = 0;

  for (
    let i = 0;
    i < points.length;
    i++
  ) {

    const current = points[i];

    const previous = points[i - 1];

    if (previous) {

      const difference =
        current.x - previous.x;

      if (
        difference >
        MONITORING_GAP_THRESHOLD_MS
      ) {

        result.push({

          x:
            previous.x +
            difference / 2,

          y: null,

          status: "unknown"

        });

        gapsCount++;

      }

    }

    result.push(current);

  }

  return {

    points: result,

    gapsCount

  };

}

function updateHistoryGapMessage(
  count = 0
) {

  setMessage(

    "history-gap-message",

    count > 0

      ? `Обнаружено разрывов мониторинга: ${count}. В этих промежутках состояние системы неизвестно.`

      : ""

  );

}


// ========================================
// 9. HISTORY CHART
// ========================================

function showHistoryMessage(
  message = ""
) {

  setMessage(
    "history-message",
    message
  );

}

function clearHistoryChart() {

  if (monitoringHistoryChart) {

    monitoringHistoryChart.destroy();

    monitoringHistoryChart = null;

  }

  updateHistoryGapMessage(0);

}

function renderHistoryChart(history) {

  const canvas =
    document.getElementById(
      "monitoring-history-chart"
    );

  if (!canvas) return;

  clearHistoryChart();

  const rawPoints =
    buildHistoryPoints(history);

  if (!rawPoints.length) {

    showHistoryMessage(
      "За выбранный период нет проверок."
    );

    return;

  }

  const gapResult =
    insertMonitoringGaps(
      rawPoints
    );

  const points =
    gapResult.points;

  updateHistoryGapMessage(
    gapResult.gapsCount
  );

  if (typeof Chart === "undefined") {

    showHistoryMessage(
      "Не удалось загрузить библиотеку графиков."
    );

    return;

  }

  showHistoryMessage();

  monitoringHistoryChart = new Chart(

    canvas,

    {

      type: "line",

      data: {

        datasets: [{

          label: "Количество проблем",

          data: points,

          parsing: false,

          borderColor: "#fbbf24",

          backgroundColor:
            "rgba(251, 191, 36, 0.08)",

          pointBackgroundColor:
            context =>

              historyStatusColors[
                context.raw?.status
              ]

              || historyStatusColors.unknown,

          pointBorderColor:
            context =>

              historyStatusColors[
                context.raw?.status
              ]

              || historyStatusColors.unknown,

          pointRadius:
            points.length > 300
              ? 0
              : 3,

          pointHoverRadius: 6,

          borderWidth: 2,

          tension: 0,

          fill: true,

          spanGaps: false

        }]

      },

      options: {

        responsive: true,

        maintainAspectRatio: false,

        animation: false,

        interaction: {

          mode: "nearest",

          intersect: false

        },

        plugins: {

          legend: {

            labels: {

              color: "#d1d5db"

            }

          },

          tooltip: {

            callbacks: {

              title(items) {

                if (!items.length) {
                  return "";
                }

                return new Date(
                  items[0].parsed.x
                ).toLocaleString("ru-RU");

              },

              afterLabel(context) {

                const status =
                  getSafeStatus(
                    context.raw?.status
                  );

                return "Статус: " +
                  statusLabels[status];

              }

            }

          }

        },

        scales: {

          x: {

            type: "linear",

            ticks: {

              color: "#9ca3af",

              maxTicksLimit: 8,

              callback(value) {

                return new Date(value)

                  .toLocaleString(

                    "ru-RU",

                    {

                      day: "2-digit",

                      month: "2-digit",

                      hour: "2-digit",

                      minute: "2-digit"

                    }

                  );

              }

            },

            grid: {

              color:
                "rgba(156, 163, 175, 0.08)"

            }

          },

          y: {

            beginAtZero: true,

            ticks: {

              color: "#9ca3af",

              precision: 0

            },

            grid: {

              color:
                "rgba(156, 163, 175, 0.12)"

            }

          }

        }

      }

    }

  );

}


// ========================================
// 10. LOAD HISTORY
// ========================================

function loadMonitoringHistory() {

  return loadPeriodData(

    "history",

    HISTORY_API_URL,

    result =>
      Array.isArray(result.history),

    result => {

      updateHistoryTable(
        result.history
      );

      try {

        renderHistoryChart(
          result.history
        );

      } catch (error) {

        console.error(
          "History chart error:",
          error
        );

        clearHistoryChart();

        showHistoryMessage(
          "Не удалось построить график."
        );

      }

      console.log(
        "Monitoring history loaded:",
        result.history.length
      );

    },

    () => {

      clearHistoryChart();

      resetHistoryTable(
        "История мониторинга недоступна"
      );

      showHistoryMessage(
        "Не удалось загрузить историю мониторинга."
      );

    }

  );

}


// ========================================
// 11. ADVANCED METRICS
// ========================================

function showMetricsMessage(
  message = ""
) {

  setMessage(
    "metrics-message",
    message
  );

}


function resetMonitoringInsights() {

  setAnalyticsText(

    "monitoring-insights",

    "Ожидание актуальных аналитических данных..."

  );

}

function renderMonitoringInsights(data) {

  const container =
    document.getElementById(
      "monitoring-insights"
    );

  if (!container) return;

  container.replaceChildren();

  function addInsight(message, type) {

    const element =
      document.createElement("div");

    element.className =
      `insight-item insight-${type}`;

    element.textContent = message;

    container.append(element);

  }

  if (!data.total_checks) {

    addInsight(

      "За выбранный период нет проверок. Аналитические выводы пока недоступны.",

      "neutral"

    );

    return;

  }

  // 1. Доступность сайта и API

  const availability =
    data.availability_percent;

  if (!Number.isFinite(availability)) {

    addInsight(

      "Недостаточно известных проверок доступности сайта и API.",

      "neutral"

    );

  } else if (availability >= 99) {

    addInsight(

      `Высокая доля успешных проверок доступности сайта и API: ${availability.toFixed(2)}%.`,

      "success"

    );

  } else if (availability >= 95) {

    addInsight(

      `Доля успешных проверок доступности снижена до ${availability.toFixed(2)}%. Рекомендуется изучить историю предупреждений.`,

      "warning"

    );

  } else {

    addInsight(

      `Низкая доля успешных проверок доступности: ${availability.toFixed(2)}%. Необходимо проверить сайт и API.`,

      "critical"

    );

  }

  // 2. Полнота мониторинга

  if (
    Number.isFinite(data.missed_checks) &&
    data.missed_checks > 0
  ) {

    addInsight(

      `Незаполненных интервалов мониторинга: ${data.missed_checks}. Возможные причины: мониторинг ещё не был запущен, остановка workflow или ошибка передачи данных.`,

      "warning"

    );

  } else if (data.missed_checks === 0) {

    addInsight(

      "Все ожидаемые интервалы мониторинга заполнены.",

      "success"

    );

  }

  // 3. Наименее стабильный компонент

  const components =
    Array.isArray(data.components)
      ? data.components
      : [];

  const measuredComponents = components

    .filter(component =>

      component.total > 0 &&

      Number.isFinite(
        component.healthy_percent
      )

    )

    .sort((a, b) =>

      a.healthy_percent -
      b.healthy_percent

    );

  const weakest =
    measuredComponents[0];

  if (weakest) {

    const name =
      metricsComponentNames[weakest.name]
      || weakest.name;

    if (weakest.healthy_percent < 90) {

      addInsight(

        `Наименее стабильный компонент: ${name}. Успешность ${weakest.healthy_percent.toFixed(2)}%. Рекомендуется проверить связанные сервисы и workflow в n8n.`,

        "critical"

      );

    } else if (weakest.healthy_percent < 99) {

      addInsight(

        `Компонент, требующий внимания: ${name}. Успешность ${weakest.healthy_percent.toFixed(2)}%.`,

        "warning"

      );

    } else {

      addInsight(

        "Все компоненты с имеющимися данными показывают высокую успешность проверок.",

        "success"

      );

    }

  }

  // 4. Размер выборки

  if (data.total_checks < 10) {

    addInsight(

      `Выводы основаны только на ${data.total_checks} проверках. Для надёжной оценки необходимо накопить больше данных.`,

      "neutral"

    );

  }

}


function renderMetrics(data) {

  setAnalyticsText(

    "metrics-availability",

    formatMetricsPercent(
      data.availability_percent
    )

  );

  setAnalyticsText(

    "metrics-coverage",

    formatMetricsPercent(
      data.coverage_percent
    )

  );

  setAnalyticsText(

    "metrics-expected",

    data.expected_checks

  );

  setAnalyticsText(

    "metrics-missed",

    data.missed_checks

  );

  setAnalyticsText(

    "metrics-samples",

    "Известных проверок доступности: " +

      data.availability_known_checks +

      " из " +

      data.total_checks

  );

  renderComponentMetrics(
    data.components
  );
  renderMonitoringInsights(data);

}

function renderComponentMetrics(
  components
) {

  const container =
    document.getElementById(
      "metrics-components-list"
    );

  if (!container) return;

  container.replaceChildren();

  for (const [key, name] of Object.entries(
    metricsComponentNames
  )) {

    const component =
      components.find(
        item => item.name === key
      );

    const percent =
      Number.isFinite(
        component?.healthy_percent
      )

        ? component.healthy_percent

        : null;

    const wrapper =
      document.createElement("div");

    wrapper.className =
      "metrics-component";

    const header =
      document.createElement("div");

    header.className =
      "metrics-component-header";

    const label =
      document.createElement("span");

    label.textContent = name;

    const value =
      document.createElement("strong");

    value.textContent =
      formatMetricsPercent(percent);

    header.append(
      label,
      value
    );

    const progress =
      document.createElement("div");

    progress.className =
      "metrics-progress";

    const fill =
      document.createElement("div");

    fill.className =
      "metrics-progress-fill";

    fill.style.width =

      Math.min(

        100,

        Math.max(
          0,
          percent ?? 0
        )

      ) + "%";

    fill.style.background =

      percent === null

        ? "#94a3b8"

        : percent >= 99

          ? "#22c55e"

          : percent >= 90

            ? "#eab308"

            : "#ef4444";

    progress.append(fill);

    wrapper.append(
      header,
      progress
    );

    container.append(wrapper);

  }

}

function resetMetrics() {

  const ids = [

    "metrics-availability",

    "metrics-coverage",

    "metrics-expected",

    "metrics-missed"

  ];

  ids.forEach(id => {

    setAnalyticsText(
      id,
      "—"
    );

  });

  setAnalyticsText(
    "metrics-samples",
    ""
  );

  renderComponentMetrics([]);
  resetMonitoringInsights();

}

function loadMonitoringMetrics() {

  return loadPeriodData(

    "metrics",

    METRICS_API_URL,

    result =>

      result.metrics &&

      Array.isArray(
        result.metrics.components
      ),

    result => {

      renderMetrics(
        result.metrics
      );

      showMetricsMessage();

      console.log(

        "Monitoring metrics loaded:",

        result.metrics

      );

    },

    () => {

      resetMetrics();

      showMetricsMessage(
        "Не удалось загрузить показатели."
      );

    }

  );

}


// ========================================
// 12. HISTORY FILTERING
// ========================================

function getFilteredHistory() {

  const filter =
    document.getElementById(
      "history-status-filter"
    );

  const selectedStatus =
    filter?.value || "all";

  return monitoringHistoryRows

    .filter(item =>

      selectedStatus === "all" ||

      getSafeStatus(
        item.overall_status
      ) === selectedStatus

    )

    .sort((a, b) =>

      new Date(b.checked_at) -

      new Date(a.checked_at)

    );

}


// ========================================
// 13. HISTORY TABLE AND PAGINATION
// ========================================

function renderHistoryTable() {

  const tbody =
    document.getElementById(
      "history-table-body"
    );

  if (!tbody) return;

  const filtered =
    getFilteredHistory();

  const totalPages = Math.max(

    1,

    Math.ceil(

      filtered.length /
      historyPageSize

    )

  );

  historyCurrentPage = Math.max(

    1,

    Math.min(
      historyCurrentPage,
      totalPages
    )

  );

  const start =

    (historyCurrentPage - 1) *

    historyPageSize;

  const visibleRows =
    filtered.slice(

      start,

      start + historyPageSize

    );

  tbody.replaceChildren();

  const fragment =
    document.createDocumentFragment();

  for (const item of visibleRows) {

    const row =
      document.createElement("tr");

    const dateCell =
      document.createElement("td");

    dateCell.textContent =
      formatDateTime(
        item.checked_at
      );

    const statusCell =
      document.createElement("td");

    const status =
      getSafeStatus(
        item.overall_status
      );

    statusCell.textContent =
      statusLabels[status];

    statusCell.style.color =
      historyStatusColors[status];

    const problemsCell =
      document.createElement("td");

    problemsCell.textContent =

      item.problems_count ?? "—";

    row.append(

      dateCell,

      statusCell,

      problemsCell

    );

    fragment.append(row);

  }

  tbody.append(fragment);

  setAnalyticsText(

    "history-table-count",

    historyTableState === "loading"

      ? "Загрузка истории..."

      : historyTableState === "error"

        ? "История мониторинга недоступна"

        : filtered.length

          ? `Показано ${start + 1}–${start + visibleRows.length} из ${filtered.length} проверок`

          : "Нет проверок по выбранному фильтру"

  );

  setAnalyticsText(

    "history-page-info",

    `${historyCurrentPage} / ${totalPages}`

  );

  const previous =
    document.getElementById(
      "history-prev-page"
    );

  const next =
    document.getElementById(
      "history-next-page"
    );

  const exportButton =
    document.getElementById(
      "history-export-csv"
    );

  if (previous) {

    previous.disabled =

      historyTableState !== "ready" ||

      historyCurrentPage <= 1;

  }

  if (next) {

    next.disabled =

      historyTableState !== "ready" ||

      historyCurrentPage >= totalPages;

  }

  if (exportButton) {

    exportButton.disabled =

      historyTableState !== "ready" ||

      filtered.length === 0;

  }

}

function updateHistoryTable(history) {

  monitoringHistoryRows = history;

  historyTableState = "ready";

  renderHistoryTable();

}

function resetHistoryTable(message) {

  monitoringHistoryRows = [];

  historyCurrentPage = 1;

  historyTableState =

    message === "Загрузка истории..."

      ? "loading"

      : "error";

  renderHistoryTable();

}

function initializeHistoryPagination() {

  const previous =
    document.getElementById(
      "history-prev-page"
    );

  const next =
    document.getElementById(
      "history-next-page"
    );

  const pageSize =
    document.getElementById(
      "history-page-size"
    );

  const filter =
    document.getElementById(
      "history-status-filter"
    );

  const initialSize =
    Number(pageSize?.value);

  if (
    ALLOWED_PAGE_SIZES.includes(
      initialSize
    )
  ) {

    historyPageSize = initialSize;

  }

  previous?.addEventListener(

    "click",

    () => {

      historyCurrentPage--;

      renderHistoryTable();

    }

  );

  next?.addEventListener(

    "click",

    () => {

      historyCurrentPage++;

      renderHistoryTable();

    }

  );

  pageSize?.addEventListener(

    "change",

    () => {

      const size =
        Number(pageSize.value);

      if (
        !ALLOWED_PAGE_SIZES.includes(size)
      ) {

        return;

      }

      historyPageSize = size;

      historyCurrentPage = 1;

      renderHistoryTable();

    }

  );

  filter?.addEventListener(

    "change",

    () => {

      historyCurrentPage = 1;

      renderHistoryTable();

    }

  );

}


// ========================================
// 14. CSV EXPORT
// ========================================

function escapeCsvValue(value) {

  let text =
    String(value ?? "");

  // Защита от выполнения формул Excel

  if (
    /^\s*[=+\-@\t\r\n]/.test(text)
  ) {

    text = "'" + text;

  }

  return '"' +

    text.replace(/"/g, '""') +

    '"';

}

function exportHistoryToCSV() {

  if (
    historyTableState !== "ready"
  ) {

    return;

  }

  const history =
    getFilteredHistory();

  if (!history.length) {

    alert(
      "Нет данных для экспорта."
    );

    return;

  }

  const rows = [

    [

      "Дата и время",

      "Статус",

      "Количество проблем"

    ],

    ...history.map(item => [

      formatDateTime(
        item.checked_at
      ),

      statusLabels[
        getSafeStatus(
          item.overall_status
        )
      ],

      item.problems_count

    ])

  ];

  const csv = rows

    .map(row =>

      row

        .map(escapeCsvValue)

        .join(";")

    )

    .join("\r\n");

  const blob = new Blob(

    [

      "\uFEFF",

      csv

    ],

    {

      type: "text/csv;charset=utf-8;"

    }

  );

  const url =
    URL.createObjectURL(blob);

  const link =
    document.createElement("a");

  const date =
    new Date()
      .toISOString()
      .slice(0, 10);

  link.href = url;

  link.download =

    `aura-monitoring-${selectedAnalyticsPeriod}-${date}.csv`;

  document.body.append(link);

  link.click();

  link.remove();

  setTimeout(

    () => {

      URL.revokeObjectURL(url);

    },

    1000

  );

  console.log(

    "CSV exported:",

    history.length,

    "records"

  );

}


// ========================================
// 15. ANALYTICS PERIOD SWITCHING
// ========================================

function initializeAnalyticsPeriods() {

  const buttons =
    document.querySelectorAll(
      ".analytics-periods .period-btn"
    );

  buttons.forEach(button => {

    button.addEventListener(

      "click",

      () => {

        const period =
          button.dataset.period;

        if (
          !ALLOWED_PERIODS.includes(period)
        ) {

          return;

        }

        if (
          period === selectedAnalyticsPeriod
        ) {

          return;

        }

        selectedAnalyticsPeriod = period;

        buttons.forEach(item => {

          const active =
            item === button;

          item.classList.toggle(
            "active",
            active
          );

          item.setAttribute(

            "aria-pressed",

            String(active)

          );

        });

        resetAnalytics();

        setMessage(
          "analytics-error"
        );

        setAnalyticsText(

          "analytics-updated",

          "Загрузка аналитики..."

        );

        clearHistoryChart();

        showHistoryMessage(

          "Загрузка истории..."

        );

        resetHistoryTable(

          "Загрузка истории..."

        );

        resetMetrics();

        showMetricsMessage(

          "Загрузка показателей..."

        );

        lastAnalyticsRefreshAt =
          Date.now();

        // Старые запросы отменяются
        // внутри loadPeriodData

        loadAnalytics();

        loadMonitoringHistory();

        loadMonitoringMetrics();

      }

    );

  });

}


// ========================================
// 16. OPTIMIZED AUTO REFRESH
// ========================================


let manualRefreshInProgress = false;

async function manualRefreshDashboard() {

  const analyticsBusy =
    Object.values(requests).some(
      state => state.controller !== null
    );

  if (
    manualRefreshInProgress ||
    monitoringLoading ||
    analyticsBusy
  ) {

    setAnalyticsText(

      "dashboard-refresh-status",

      "Обновление уже выполняется. Подождите."

    );

    return;

  }

  manualRefreshInProgress = true;

  const button =
    document.getElementById(
      "dashboard-refresh-button"
    );

  if (button) {

    button.disabled = true;

    button.textContent =
      "Обновление...";

  }

  setAnalyticsText(

    "dashboard-refresh-status",

    "Запрашиваем актуальные данные..."

  );

  try {

    lastAnalyticsRefreshAt =
      Date.now();

    await Promise.allSettled([

      loadMonitoring(),

      loadAnalytics(),

      loadMonitoringHistory(),

      loadMonitoringMetrics()

    ]);

    setAnalyticsText(

      "dashboard-refresh-status",

      "Запросы завершены: " +

        new Date().toLocaleTimeString(
          "ru-RU"
        ) +

        ". Состояние данных указано в разделах."

    );

  } finally {

    manualRefreshInProgress = false;

    if (button) {

      button.disabled = false;

      button.textContent =
        "↻ Обновить данные";

    }

  }

}


function refreshMonitoringDashboard(
  force = false
) {

  if (manualRefreshInProgress) {
  return;
  }
  if (
    document.hidden &&
    !force
  ) {

    return;

  }

  if (!monitoringLoading) {

    loadMonitoring();

  }

  const now = Date.now();

  const shouldRefreshAnalytics =

    force ||

    now - lastAnalyticsRefreshAt >=

      ANALYTICS_REFRESH_INTERVAL_MS;

  if (!shouldRefreshAnalytics) {

    return;

  }

  const analyticsBusy =

    Object.values(requests)

      .some(
        state => state.controller !== null
      );

  if (analyticsBusy) {

    return;

  }

  lastAnalyticsRefreshAt = now;

  loadAnalytics();

  loadMonitoringHistory();

  loadMonitoringMetrics();

}


// ========================================
// 17. DASHBOARD INITIALIZATION
// ========================================

function initializeMonitoringDashboard() {

  if (dashboardInitialized) {

    return;

  }

  dashboardInitialized = true;

  resetAnalytics();

  resetMetrics();

  resetHistoryTable(

    "Загрузка истории..."

  );

  showHistoryMessage(

    "Загрузка истории..."

  );

  showMetricsMessage(

    "Загрузка показателей..."

  );

  setAnalyticsText(

    "analytics-updated",

    "Загрузка аналитики..."

  );

  initializeAnalyticsPeriods();

  initializeHistoryPagination();

  document.getElementById(
  "dashboard-refresh-button"
)?.addEventListener(
  "click",
  manualRefreshDashboard
);

  document.getElementById(

    "history-export-csv"

  )?.addEventListener(

    "click",

    exportHistoryToCSV

  );

  // Первая загрузка всех разделов

  refreshMonitoringDashboard(true);

  // Один общий таймер обновления

  setInterval(

    refreshMonitoringDashboard,

    REFRESH_INTERVAL_MS

  );

  // Обновление при возвращении на вкладку

  document.addEventListener(

    "visibilitychange",

    () => {

      if (!document.hidden) {

        refreshMonitoringDashboard(true);

      }

    }

  );

  console.log(

    "AURA COFFEE Monitoring initialized successfully"

  );

}


// ========================================
// 18. START AFTER DOM IS READY
// ========================================

if (
  document.readyState === "loading"
) {

  document.addEventListener(

    "DOMContentLoaded",

    initializeMonitoringDashboard,

    { once: true }

  );

} else {

  initializeMonitoringDashboard();

}
