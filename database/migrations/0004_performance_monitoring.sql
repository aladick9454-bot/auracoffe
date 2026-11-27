CREATE TABLE public.performance_test_runs (

    id BIGSERIAL PRIMARY KEY,

    run_id TEXT NOT NULL UNIQUE,

    environment TEXT NOT NULL
        CHECK (environment IN ('local', 'ci')),

    endpoint TEXT NOT NULL,

    started_at TIMESTAMPTZ NOT NULL,

    finished_at TIMESTAMPTZ NOT NULL,

    duration_seconds DOUBLE PRECISION NOT NULL
        CHECK (duration_seconds > 0),

    concurrency INTEGER NOT NULL
        CHECK (concurrency > 0),

    total_requests INTEGER NOT NULL
        CHECK (total_requests > 0),

    successful_requests INTEGER NOT NULL
        CHECK (successful_requests >= 0),

    failed_requests INTEGER NOT NULL
        CHECK (failed_requests >= 0),

    error_rate DOUBLE PRECISION NOT NULL
        CHECK (error_rate BETWEEN 0 AND 100),

    requests_per_second DOUBLE PRECISION NOT NULL
        CHECK (requests_per_second >= 0),

    avg_latency_ms DOUBLE PRECISION NOT NULL
        CHECK (avg_latency_ms >= 0),

    p50_ms DOUBLE PRECISION NOT NULL
        CHECK (p50_ms >= 0),

    p95_ms DOUBLE PRECISION NOT NULL
        CHECK (p95_ms >= 0),

    p99_ms DOUBLE PRECISION NOT NULL
        CHECK (p99_ms >= 0),

    max_latency_ms DOUBLE PRECISION NOT NULL
        CHECK (max_latency_ms >= 0),

    status TEXT NOT NULL
        CHECK (status IN ('passed', 'failed')),

    details JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        total_requests =
        successful_requests + failed_requests
    ),

    CHECK (finished_at >= started_at),

    CHECK (
        p50_ms <= p95_ms
        AND p95_ms <= p99_ms
        AND p99_ms <= max_latency_ms
    )
);


CREATE INDEX idx_performance_runs_started_at

ON public.performance_test_runs (
    started_at DESC
);


CREATE INDEX idx_performance_runs_endpoint

ON public.performance_test_runs (
    endpoint,
    started_at DESC
);


CREATE INDEX idx_performance_runs_status

ON public.performance_test_runs (
    status,
    started_at DESC
);


CREATE VIEW public.performance_test_summary AS

SELECT

    COUNT(*) AS total_tests,

    COUNT(*) FILTER (
        WHERE status = 'passed'
    ) AS passed_tests,

    COUNT(*) FILTER (
        WHERE status = 'failed'
    ) AS failed_tests,

    COALESCE(
        ROUND(
            COUNT(*) FILTER (
                WHERE status = 'passed'
            ) * 100.0
            / NULLIF(COUNT(*), 0),
            2
        ),
        0
    ) AS success_rate,

    COALESCE(
        ROUND(AVG(p95_ms)::numeric, 2),
        0
    ) AS average_p95_ms,

    COALESCE(
        ROUND(AVG(p99_ms)::numeric, 2),
        0
    ) AS average_p99_ms,

    COALESCE(
        ROUND(
            AVG(requests_per_second)::numeric,
            2
        ),
        0
    ) AS average_rps,

    MAX(finished_at) AS last_test_at

FROM public.performance_test_runs;