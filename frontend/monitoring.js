
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
