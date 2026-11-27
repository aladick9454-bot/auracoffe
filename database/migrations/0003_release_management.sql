CREATE TABLE public.application_releases (

    id BIGSERIAL PRIMARY KEY,

    run_id TEXT NOT NULL UNIQUE,

    release_version TEXT NOT NULL,

    commit_sha TEXT NOT NULL
        CHECK (commit_sha ~ '^[a-f0-9]{40}$'),

    previous_commit_sha TEXT,

    previous_deploy_id TEXT,

    render_deploy_id TEXT,

    rollback_deploy_id TEXT,

    status TEXT NOT NULL
        CHECK (
            status IN (
                'pending',
                'deploying',
                'verifying',
                'success',
                'failed',
                'rolling_back',
                'rolled_back',
                'rollback_failed'
            )
        ),

    migration_version TEXT,

    smoke_passed BOOLEAN,

    duration_ms BIGINT
        CHECK (duration_ms >= 0),

    error_message TEXT,

    started_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    finished_at TIMESTAMPTZ,

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
);


CREATE INDEX idx_application_releases_started

ON public.application_releases (
    started_at DESC
);


CREATE INDEX idx_application_releases_status

ON public.application_releases (
    status
);


CREATE TABLE public.application_release_events (

    id BIGSERIAL PRIMARY KEY,

    release_id BIGINT NOT NULL

        REFERENCES public.application_releases(id)

        ON DELETE RESTRICT,

    event_type TEXT NOT NULL,

    message TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
);


CREATE INDEX idx_application_release_events_release

ON public.application_release_events (
    release_id,
    created_at DESC
);


CREATE OR REPLACE VIEW public.application_release_summary AS

SELECT

    COUNT(*) AS total_releases,

    COUNT(*) FILTER (
        WHERE status = 'success'
    ) AS successful_releases,

    COUNT(*) FILTER (
        WHERE status IN (
            'failed',
            'rolled_back',
            'rollback_failed'
        )
    ) AS failed_releases,

    COUNT(*) FILTER (
        WHERE status = 'rolled_back'
    ) AS successful_rollbacks,

    COUNT(*) FILTER (
        WHERE status = 'rollback_failed'
    ) AS failed_rollbacks,

    COUNT(*) FILTER (
        WHERE status IN (
            'pending',
            'deploying',
            'verifying',
            'rolling_back'
        )
    ) AS active_releases,

    COALESCE(

        ROUND(

            100.0 *

            COUNT(*) FILTER (
                WHERE status = 'success'
            )

            /

            NULLIF(

                COUNT(*) FILTER (
                    WHERE status IN (
                        'success',
                        'failed',
                        'rolled_back',
                        'rollback_failed'
                    )
                ),

                0
            ),

            2
        ),

        0

    ) AS success_rate,

    COALESCE(
        ROUND(AVG(duration_ms) / 1000.0, 2),
        0
    ) AS average_duration_seconds,

    MAX(finished_at) FILTER (
        WHERE status = 'success'
    ) AS last_successful_release_at

FROM public.application_releases;