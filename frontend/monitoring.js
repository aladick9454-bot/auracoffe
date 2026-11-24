
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
