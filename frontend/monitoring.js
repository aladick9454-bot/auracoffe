

const statusLabels = {
  healthy: "Работает",
  warning: "Предупреждение",
  critical: "Критическая ошибка",
  unknown: "Нет данных"
};

function updateStatus(elementId, status) {
  const element = document.getElementById(elementId);

  if (!element) return;

  element.textContent =
    statusLabels[status] ?? "Неизвестно";

  element.className =
  elementId === "overall-status"
    ? `status ${status}`
    : status;
}

function renderDashboard(data) {
  updateStatus(
    "overall-status",
    data.overall_status
  );

  updateStatus(
    "crm-status",
    data.components.system_health.status
  );

  updateStatus(
    "availability-status",
    data.components.availability.status
  );

  updateStatus(
    "frontend-status",
    data.components.performance_frontend.status
  );

  updateStatus(
    "backend-status",
    data.components.performance_backend.status
  );

  updateStatus(
    "reports-status",
    data.components.daily_reports.status
  );

  document.getElementById(
    "problems-count"
  ).textContent = data.problems_count;

  document.getElementById(
    "last-update"
  ).textContent =
    "Последняя проверка: " +
    new Date(data.checked_at).toLocaleString("ru-RU");
}


const API_URL = "/api/monitoring/admin";


function updateFreshnessWarning(freshness) {
  const warning = document.getElementById(
    "freshness-warning"
  );

  if (!warning) return;

  const messages = {
    stale: "Данные мониторинга устарели. Текущее состояние системы неизвестно.",
    missing: "Данные мониторинга отсутствуют.",
    invalid: "Ошибка времени последней проверки.",
    unavailable: "Не удалось получить данные мониторинга."
  };

  if (freshness === "fresh") {
    warning.hidden = true;
    return;
  }

  warning.textContent =
    messages[freshness] || "Состояние неизвестно.";

  warning.hidden = false;
}

async function loadMonitoring() {
  try {   
const response = await fetch(API_URL, {
  credentials: "same-origin",
  cache: "no-store"
});

if (response.status === 401) {
  window.location.replace("/admin/login");
  return;
}

if (!response.ok) {
  throw new Error(`HTTP ${response.status}`);
}

    const data = await response.json();

const freshness = getMonitoringFreshness(
  data.checked_at
);

updateFreshnessWarning(freshness);

if (freshness !== "fresh") {
  data.overall_status = "unknown";
  data.problems_count = "—";

  for (const component of Object.values(
    data.components || {}
  )) {
    component.status = "unknown";
  }
}


    renderDashboard(data);

    console.log("Monitoring loaded:", data);
  } catch (error) {
    console.error("Monitoring error:", error);

    const status = document.getElementById(
      "overall-status"
    );

    status.textContent = "Нет соединения";
    status.className = "status unknown";
    updateFreshnessWarning("unavailable");
  }
}


const MAX_DATA_AGE_MS = 45 * 60 * 1000;

function getMonitoringFreshness(checkedAt) {
  if (!checkedAt) {
    return "missing";
  }

  const timestamp = new Date(checkedAt).getTime();

  if (!Number.isFinite(timestamp)) {
    return "invalid";
  }

  const age = Date.now() - timestamp;

  if (age < 0) {
    return "invalid";
  }

  if (age > MAX_DATA_AGE_MS) {
    return "stale";
  }

  return "fresh";
}

loadMonitoring();

setInterval(loadMonitoring, 60 * 1000);

