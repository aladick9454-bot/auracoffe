(() => {

    "use strict";

    let chart = null;

    let loading = false;


    const byId = id =>

        document.getElementById(id);


    function formatNumber(value) {

        return Number(value || 0).toFixed(2);

    }


    async function request(url) {

        const response = await fetch(url, {

            credentials: "same-origin",

            cache: "no-store",

            signal: AbortSignal.timeout(20000)

        });

        if (response.status === 401) {

            window.location.href = "/admin/login";

            throw new Error("Unauthorized");

        }

        if (!response.ok) {

            throw new Error(

                `HTTP ${response.status}`

            );

        }

        const data = await response.json();

        if (!data.ok) {

            throw new Error(
                "Invalid performance response"
            );

        }

        return data;

    }


    function renderSummary(summary) {

        byId("performance-total").textContent =

            summary.total_tests;

        byId("performance-success").textContent =

            `${formatNumber(summary.success_rate)}%`;

        byId("performance-p95").textContent =

            `${formatNumber(summary.average_p95_ms)} ms`;

        byId("performance-rps").textContent =

            formatNumber(summary.average_rps);

    }


    function renderHistory(history) {

        const body = byId("performance-history");

        body.replaceChildren();

        if (!history.length) {

            const row = document.createElement("tr");

            const cell = document.createElement("td");

            cell.colSpan = 9;

            cell.textContent =
                "Нагрузочные тесты пока отсутствуют";

            row.appendChild(cell);

            body.appendChild(row);

            return;

        }


        for (const item of history) {

            const row = document.createElement("tr");

            const values = [

                new Date(
                    item.started_at
                ).toLocaleString("ru-RU"),

                item.environment,

                item.endpoint,

                item.total_requests,

                formatNumber(
                    item.requests_per_second
                ),

                `${formatNumber(item.p95_ms)} ms`,

                `${formatNumber(item.p99_ms)} ms`,

                `${formatNumber(item.error_rate)}%`,

                item.status.toUpperCase()

            ];

            values.forEach((value, index) => {

                const cell =
                    document.createElement("td");

                cell.textContent = String(value);

                if (index === 8) {

                    cell.className =

                        item.status === "passed"

                            ? "performance-passed"

                            : "performance-failed";

                }

                row.appendChild(cell);

            });

            body.appendChild(row);

        }

    }


    function renderChart(history) {

        if (typeof Chart === "undefined") {

            return;

        }

        if (chart) {

            chart.destroy();

            chart = null;

        }

        const items = [...history].reverse();

        chart = new Chart(

            byId("performance-chart"),

            {

                type: "line",

                data: {

                    labels: items.map(item =>

                        new Date(
                            item.started_at
                        ).toLocaleString("ru-RU")

                    ),

                    datasets: [

                        {

                            label: "P95, ms",

                            data: items.map(

                                item => Number(
                                    item.p95_ms
                                )

                            ),

                            borderColor: "#38bdf8",

                            tension: 0.2

                        },

                        {

                            label: "P95 threshold",

                            data: items.map(() => 500),

                            borderColor: "#f87171",

                            borderDash: [6, 6],

                            pointRadius: 0

                        }

                    ]

                },

                options: {

                    responsive: true,

                    maintainAspectRatio: false,

                    scales: {

                        y: {

                            beginAtZero: true

                        }

                    }

                }

            }

        );

    }


    async function refresh() {

        if (loading) {
            return;
        }

        loading = true;

        const button = byId(
            "performance-refresh-btn"
        );

        const message = byId(
            "performance-message"
        );

        button.disabled = true;

        message.textContent = "Загрузка...";

        try {

            const [summary, history] =

                await Promise.all([

                    request(
                        "/api/performance/summary"
                    ),

                    request(
                        "/api/performance/history?limit=20"
                    )

                ]);

            renderSummary(summary.summary);

            renderHistory(history.history);

            renderChart(history.history);

            message.textContent = "";

            byId("performance-updated")
                .textContent =

                "Обновлено: " +

                new Date().toLocaleString("ru-RU");

            console.log(
                "Performance monitoring loaded"
            );

        } catch (error) {

            message.textContent =

                "Ошибка загрузки: " + error.message;

        } finally {

            loading = false;

            button.disabled = false;

        }

    }


    function init() {

        if (!byId("performance-dashboard")) {

            return;

        }

        byId("performance-refresh-btn")
            .addEventListener("click", refresh);

        refresh();

        setInterval(() => {

            if (!document.hidden) {

                refresh();

            }

        }, 60000);

        console.log(
            "Performance monitoring initialized"
        );

    }


    if (document.readyState === "loading") {

        document.addEventListener(
            "DOMContentLoaded",
            init
        );

    } else {

        init();

    }

})();