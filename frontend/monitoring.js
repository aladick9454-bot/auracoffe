

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


    const data = await response.json();

    renderDashboard(data);

    console.log("Monitoring loaded:", data);
  } catch (error) {
    console.error("Monitoring error:", error);

    const status = document.getElementById(
      "overall-status"
    );

    status.textContent = "Нет соединения";
    status.className = "status unknown";
  }
}

loadMonitoring();

setInterval(loadMonitoring, 60 * 1000);

