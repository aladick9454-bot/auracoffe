CREATE TABLE IF NOT EXISTS public.database_metadata (

    key TEXT PRIMARY KEY,

    value TEXT NOT NULL,

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
);


INSERT INTO public.database_metadata (
    key,
    value
)

VALUES

    ('application', 'AURA COFFEE'),

    ('schema_management', 'enabled'),

    ('migration_engine', '1.0.0')

ON CONFLICT (key)

DO NOTHING;


CREATE OR REPLACE VIEW public.database_migration_summary AS

SELECT

    COUNT(*) AS total_migrations,

    MAX(version) AS current_version,

    MAX(applied_at) AS last_migration_at,

    COALESCE(

        ROUND(AVG(execution_ms), 2),

        0

    ) AS average_execution_ms

FROM public.schema_migrations;