CREATE TABLE IF NOT EXISTS public.schema_migrations (

    version TEXT PRIMARY KEY,

    name TEXT NOT NULL,

    checksum TEXT NOT NULL
        CHECK (
            checksum ~ '^[a-f0-9]{64}$'
        ),

    execution_ms INTEGER NOT NULL
        DEFAULT 0
        CHECK (execution_ms >= 0),

    applied_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS idx_schema_migrations_date

ON public.schema_migrations (
    applied_at DESC
);
