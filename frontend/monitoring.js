
const API_URL = "/api/monitoring/admin";

const MAX_DATA_AGE_MS = 45 * 60 * 1000;
const MAX_FUTURE_OFFSET_MS = 60 * 1000;

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

// Обновление статуса карточки
function updateStatus(elementId, status) {
  const element = document.getElementById(elementId);

  if (!element) return;

  const safeStatus = Object.hasOwn(statusLabels, status)
    ? status
    : "unknown";

  element.textContent = statusLabels[safeStatus];

  element.className =
    elementId === "overall-status"
      ? `status ${safeStatus}`
      : safeStatus;
}

// Проверка свежести данных
function getMonitoringFreshness(checkedAt) {
  if (!checkedAt) {
    return "missing";
  }

  const timestamp = new Date(checkedAt).getTime();

  if (!Number.isFinite(timestamp)) {
    return "invalid";
  }

  const age = Date.now() - timestamp;

  if (age < -MAX_FUTURE_OFFSET_MS) {
    return "invalid";
  }

  if (age > MAX_DATA_AGE_MS) {
    return "stale";
  }

  return "fresh";
}

// Предупреждение о состоянии данных
function updateFreshnessWarning(freshness) {
  const warning = document.getElementById(
    "freshness-warning"
  );

  if (!warning) return;

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

  if (freshness === "fresh") {
    warning.hidden = true;
    return;
  }

  warning.textContent =
    messages[freshness] || "Состояние неизвестно.";

  warning.hidden = false;
}

// Безопасное отображение панели
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
      data.components?.[key]?.status ?? "unknown"
    );
  }

  const problems = document.getElementById(
    "problems-count"
  );

  if (problems) {
    problems.textContent =
      Number.isInteger(data.problems_count) &&
      data.problems_count >= 0
        ? data.problems_count
        : "—";
  }

  const lastUpdate = document.getElementById(
    "last-update"
  );

  if (lastUpdate) {
    const timestamp = data.checked_at
      ? new Date(data.checked_at).getTime()
      : NaN;

    lastUpdate.textContent =
      Number.isFinite(timestamp)
        ? "Последняя проверка: " +
          new Date(timestamp).toLocaleString("ru-RU")
        : "Последняя проверка: нет данных";
  }
}

// Сброс всех статусов
function resetMonitoringDashboard(checkedAt = null) {
  renderDashboard({
    checked_at: checkedAt,
    overall_status: "unknown",
    problems_count: null,
    components: {}
  });
}

// Защита от параллельных запросов
let monitoringLoading = false;

// Получение данных мониторинга
async function loadMonitoring() {
  if (monitoringLoading) return;

  monitoringLoading = true;

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    15000
  );

  try {
    const response = await fetch(API_URL, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal
    });

    if (response.status === 401) {
      window.location.replace("/admin/login");
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      throw new Error("Invalid monitoring response");
    }

    const freshness = getMonitoringFreshness(
      data.checked_at
    );

    updateFreshnessWarning(freshness);

    if (freshness !== "fresh") {
      resetMonitoringDashboard(
        freshness === "stale"
          ? data.checked_at
          : null
      );

      return;
    }

    renderDashboard(data);

    console.log("Monitoring loaded:", data);

  } catch (error) {
    console.error("Monitoring error:", error);

    resetMonitoringDashboard();

    updateFreshnessWarning("unavailable");

  } finally {
    clearTimeout(timeout);

    monitoringLoading = false;
  }
}

// Первоначальная загрузка
loadMonitoring();

// Автоматическое обновление каждую минуту
setInterval(loadMonitoring, 60 * 1000);

// =========================
// MONITORING ANALYTICS
// =========================

const ANALYTICS_API_URL =
  "/api/monitoring/analytics";

let selectedAnalyticsPeriod = "24h";

let analyticsRequestId = 0;
let analyticsController = null;

// Безопасное обновление текста
function setAnalyticsText(id, value) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = value;
  }
}

// Отображение статистики
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

  const percent = data.healthy_percent;

  setAnalyticsText(
    "analytics-percent",
    Number.isFinite(percent)
      ? percent.toFixed(2) + "%"
      : "—"
  );

  renderAnalyticsBar(data);
  renderStatusChart(data);
}

// Диаграмма распределения
function renderAnalyticsBar(data) {
  const total = data.total_checks;

  const segments = {
    "bar-healthy": data.healthy_checks,
    "bar-warning": data.warning_checks,
    "bar-critical": data.critical_checks,
    "bar-unknown": data.unknown_checks
  };

  for (const [id, count] of Object.entries(
    segments
  )) {
    const element = document.getElementById(id);

    if (!element) continue;

    const percent =
      total > 0 ? count / total * 100 : 0;

    element.style.width = percent + "%";
  }
}

// Получение аналитики с сервера
async function loadAnalytics() {
  const requestId = ++analyticsRequestId;

  if (analyticsController) {
    analyticsController.abort();
  }

  const controller = new AbortController();

  analyticsController = controller;

  const timeout = setTimeout(
    () => controller.abort(),
    15000
  );

  const errorElement = document.getElementById(
    "analytics-error"
  );

  try {
    const response = await fetch(
      `${ANALYTICS_API_URL}?period=${encodeURIComponent(
        selectedAnalyticsPeriod
      )}`,
      {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal
      }
    );

    if (requestId !== analyticsRequestId) {
      return;
    }

    if (response.status === 401) {
      window.location.replace("/admin/login");
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();

    if (requestId !== analyticsRequestId) {
      return;
    }

    if (!result.ok || !result.analytics) {
      throw new Error("Invalid analytics response");
    }

    renderAnalytics(result.analytics);

    setAnalyticsText(
      "analytics-updated",
      "Аналитика обновлена: " +
      new Date(
        result.generated_at
      ).toLocaleString("ru-RU")
    );

    if (errorElement) {
      errorElement.hidden = true;
    }

    console.log("Analytics loaded:", result);

  } catch (error) {
    if (requestId !== analyticsRequestId) {
      return;
    }

    console.error("Analytics error:", error);

    resetAnalytics();

    if (errorElement) {
      errorElement.textContent =
        "Не удалось загрузить аналитику.";

      errorElement.hidden = false;
    }

    setAnalyticsText(
      "analytics-updated",
      "Аналитика недоступна"
    );

  } finally {
    clearTimeout(timeout);

    if (requestId === analyticsRequestId) {
      analyticsController = null;
    }
  }
  clearStatusChart();
}

// Переключение периода аналитики
function initializeAnalyticsPeriods() {
  const buttons = document.querySelectorAll(
    ".analytics-periods .period-btn"
  );

  buttons.forEach(button => {
    button.addEventListener("click", () => {
      const period = button.dataset.period;

      if (!["24h", "7d", "30d"].includes(period)) {
        return;
      }

      if (period === selectedAnalyticsPeriod) {
        return;
      }

      selectedAnalyticsPeriod = period;

      buttons.forEach(item => {
        const active = item === button;

        item.classList.toggle("active", active);

        item.setAttribute(
          "aria-pressed",
          String(active)
        );
      });

      resetAnalytics();

      const errorElement =
        document.getElementById("analytics-error");

      if (errorElement) {
        errorElement.hidden = true;
      }

      setAnalyticsText(
        "analytics-updated",
        "Загрузка аналитики..."
      );

      loadAnalytics();
      clearHistoryChart();

showHistoryMessage(
  "Загрузка истории..."
);

loadMonitoringHistory();
    });
  });
}


// Сброс аналитики при ошибке
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
}

// Запуск аналитики
initializeAnalyticsPeriods();

loadAnalytics();

// Автоматическое обновление
// каждые 60 секунд
setInterval(() => {
  if (!analyticsController) {
    loadAnalytics();
  }
}, 60 * 1000);


// =========================
// MONITORING HISTORY
// =========================

const HISTORY_API_URL =
  "/api/monitoring/history";

let monitoringHistoryChart = null;

let historyRequestId = 0;
let historyController = null;

const historyStatusColors = {
  healthy: "#22c55e",
  warning: "#eab308",
  critical: "#ef4444",
  unknown: "#94a3b8"
};

function showHistoryMessage(message = "") {
  const element = document.getElementById(
    "history-message"
  );

  if (!element) return;

  element.textContent = message;
  element.hidden = !message;
}

function clearHistoryChart() {
  if (monitoringHistoryChart) {
    monitoringHistoryChart.destroy();
    monitoringHistoryChart = null;
  }
}

function renderHistoryChart(history) {
  const canvas = document.getElementById(
    "monitoring-history-chart"
  );

  if (!canvas) return;

  clearHistoryChart();

  if (!history.length) {
    showHistoryMessage(
      "За выбранный период нет проверок."
    );

    return;
  }

  if (typeof Chart === "undefined") {
    showHistoryMessage(
      "Не удалось загрузить библиотеку графиков."
    );

    return;
  }

  showHistoryMessage();

  const labels = history.map(item =>
    new Date(item.checked_at)
      .toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      })
  );

  const values = history.map(
    item => item.problems_count
  );

  const colors = history.map(
    item =>
      historyStatusColors[item.overall_status]
      || historyStatusColors.unknown
  );

  monitoringHistoryChart = new Chart(
    canvas,
    {
      type: "line",

      data: {
        labels,

        datasets: [{
          label: "Количество проблем",
          data: values,

          borderColor: "#fbbf24",

          backgroundColor:
            "rgba(251, 191, 36, 0.08)",

          pointBackgroundColor: colors,
          pointBorderColor: colors,

          pointRadius: 4,
          pointHoverRadius: 7,

          borderWidth: 2,
          tension: 0,
          fill: true
        }]
      },

      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,

        interaction: {
          mode: "index",
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
              afterLabel(context) {
                const item =
                  history[context.dataIndex];

                return "Статус: " + (
                  statusLabels[
                    item.overall_status
                  ] || "Нет данных"
                );
              }
            }
          }
        },

        scales: {
          x: {
            ticks: {
              color: "#9ca3af",
              maxTicksLimit: 10
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


async function loadMonitoringHistory() {
  const requestId = ++historyRequestId;

  const period = selectedAnalyticsPeriod;

  if (historyController) {
    historyController.abort();
  }

  const controller = new AbortController();

  historyController = controller;

  const timeout = setTimeout(
    () => controller.abort(),
    15000
  );

  try {
    const response = await fetch(
      `${HISTORY_API_URL}?period=${encodeURIComponent(
        period
      )}`,
      {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal
      }
    );

    if (requestId !== historyRequestId) {
      return;
    }

    if (response.status === 401) {
      window.location.replace("/admin/login");
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();

    if (requestId !== historyRequestId) {
      return;
    }

    if (
      !result.ok ||
      result.period !== period ||
      !Array.isArray(result.history)
    ) {
      throw new Error(
        "Invalid history response"
      );
    }

    renderHistoryChart(result.history);
    updateHistoryTable(result.history);

    console.log(
      "Monitoring history loaded:",
      result.total
    );

  } catch (error) {
    if (requestId !== historyRequestId) {
      return;
    }

    console.error(
      "Monitoring history error:",
      error
    );

    clearHistoryChart();
    resetHistoryTable(
  "История мониторинга недоступна"
);

    showHistoryMessage(
      "Не удалось загрузить историю мониторинга."
    );

  } finally {
    clearTimeout(timeout);

    if (requestId === historyRequestId) {
      historyController = null;
    }
  }
}

// Первоначальная загрузка истории
loadMonitoringHistory();

resetHistoryTable(
  "Загрузка истории..."
);

resetMetrics();

showMetricsMessage(
  "Загрузка показателей..."
);

loadMonitoringMetrics();

// Автоматическое обновление истории
setInterval(() => {
  if (!historyController) {
    loadMonitoringHistory();
  }
}, 60 * 1000);


// =========================
// ADVANCED MONITORING METRICS
// =========================

const METRICS_API_URL =
  "/api/monitoring/metrics";

let metricsController = null;
let metricsRequestId = 0;

const metricsComponentNames = {
  system_health: "CRM",
  availability: "Сайт и API",
  performance_frontend: "Frontend",
  performance_backend: "Backend",
  daily_reports: "Ежедневные отчёты"
};

function formatMetricsPercent(value) {
  return Number.isFinite(value)
    ? value.toFixed(2) + "%"
    : "—";
}

function showMetricsMessage(message = "") {
  const element = document.getElementById(
    "metrics-message"
  );

  if (!element) return;

  element.textContent = message;
  element.hidden = !message;
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
      " из " + data.total_checks
  );

  renderComponentMetrics(data.components);
}

function renderComponentMetrics(components) {
  const container = document.getElementById(
    "metrics-components-list"
  );

  if (!container) return;

  container.replaceChildren();

  for (const [key, name] of Object.entries(
    metricsComponentNames
  )) {
    const component = components.find(
      item => item.name === key
    );

    const percent =
      component?.healthy_percent ?? null;

    const wrapper =
      document.createElement("div");

    wrapper.className = "metrics-component";

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

    header.append(label, value);

    const progress =
      document.createElement("div");

    progress.className = "metrics-progress";

    const fill =
      document.createElement("div");

    fill.className =
      "metrics-progress-fill";

    fill.style.width =
      Math.min(100, Math.max(0, percent ?? 0))
      + "%";

    fill.style.background =
      percent === null
        ? "#94a3b8"
        : percent >= 99
          ? "#22c55e"
          : percent >= 90
            ? "#eab308"
            : "#ef4444";

    progress.append(fill);

    wrapper.append(header, progress);

    container.append(wrapper);
  }
}

function resetMetrics() {
  [
    "metrics-availability",
    "metrics-coverage",
    "metrics-expected",
    "metrics-missed"
  ].forEach(id => {
    setAnalyticsText(id, "—");
  });

  setAnalyticsText("metrics-samples", "");

  renderComponentMetrics([]);
}

async function loadMonitoringMetrics() {
  const requestId = ++metricsRequestId;
  const period = selectedAnalyticsPeriod;

  if (metricsController) {
    metricsController.abort();
  }

  const controller = new AbortController();

  metricsController = controller;

  const timeout = setTimeout(
    () => controller.abort(),
    15000
  );

  try {
    const response = await fetch(
      `${METRICS_API_URL}?period=${encodeURIComponent(period)}`,
      {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal
      }
    );

    if (requestId !== metricsRequestId) return;

    if (response.status === 401) {
      window.location.replace("/admin/login");
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();

    if (requestId !== metricsRequestId) return;

    if (
      !result.ok ||
      result.period !== period ||
      !result.metrics ||
      !Array.isArray(result.metrics.components)
    ) {
      throw new Error("Invalid metrics response");
    }

    renderMetrics(result.metrics);

    showMetricsMessage();

  } catch (error) {
    if (requestId !== metricsRequestId) return;

    console.error("Metrics error:", error);

    resetMetrics();

    showMetricsMessage(
      "Не удалось загрузить показатели."
    );

  } finally {
    clearTimeout(timeout);

    if (requestId === metricsRequestId) {
      metricsController = null;
    }
  }
}

let monitoringStatusChart = null;

function clearStatusChart() {
  if (monitoringStatusChart) {
    monitoringStatusChart.destroy();
    monitoringStatusChart = null;
  }
}

function renderStatusChart(data) {
  const canvas = document.getElementById(
    "monitoring-status-chart"
  );

  if (!canvas) return;

  clearStatusChart();

  if (
    typeof Chart === "undefined" ||
    !data.total_checks
  ) {
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


// =========================
// MONITORING HISTORY TABLE
// =========================

let monitoringHistoryRows = [];

const HISTORY_TABLE_LIMIT = 50;

function renderHistoryTable() {
  const tbody = document.getElementById(
    "history-table-body"
  );

  const filter = document.getElementById(
    "history-status-filter"
  );

  if (!tbody) return;

  const selectedStatus =
    filter?.value || "all";

  const filtered = monitoringHistoryRows
    .filter(item =>
      selectedStatus === "all" ||
      item.overall_status === selectedStatus
    )
    .slice()
    .reverse();

  const visibleRows = filtered.slice(
    0,
    HISTORY_TABLE_LIMIT
  );

  tbody.replaceChildren();

  for (const item of visibleRows) {
    const row =
      document.createElement("tr");

    const dateCell =
      document.createElement("td");

    dateCell.textContent =
      new Date(item.checked_at)
        .toLocaleString("ru-RU");

    const statusCell =
      document.createElement("td");

    statusCell.textContent =
      statusLabels[item.overall_status]
      || "Нет данных";

    statusCell.style.color =
      historyStatusColors[item.overall_status]
      || historyStatusColors.unknown;

    const problemsCell =
      document.createElement("td");

    problemsCell.textContent =
      item.problems_count;

    row.append(
      dateCell,
      statusCell,
      problemsCell
    );

    tbody.append(row);
  }

  setAnalyticsText(
    "history-table-count",
    filtered.length
      ? `Показано ${visibleRows.length} из ${filtered.length} проверок`
      : "Нет проверок по выбранному фильтру"
  );
}

function updateHistoryTable(history) {
  monitoringHistoryRows = history;

  renderHistoryTable();
}

function resetHistoryTable(message) {
  monitoringHistoryRows = [];

  const tbody = document.getElementById(
    "history-table-body"
  );

  if (tbody) {
    tbody.replaceChildren();
  }

  setAnalyticsText(
    "history-table-count",
    message
  );
}

document.getElementById(
  "history-status-filter"
)?.addEventListener(
  "change",
  renderHistoryTable
);

// Первоначальная загрузка показателей
loadMonitoringMetrics();

// Автоматическое обновление показателей
setInterval(() => {
  if (!metricsController) {
    loadMonitoringMetrics();
  }
}, 60 * 1000);