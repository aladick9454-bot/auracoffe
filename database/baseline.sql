--
-- PostgreSQL database dump
--

\restrict yqJYVyp9iGQfbwK4sIDQGRljzDZUkLkP0TuCTsT3xRvW5AnST79RXhg5stdKSUb

-- Dumped from database version 18.7 (3190d2f)
-- Dumped by pg_dump version 18.7 (Debian 18.7-1.pgdg13+5)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: assign_monitoring_incident_sla(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_monitoring_incident_sla() RETURNS trigger
    LANGUAGE plpgsql
    AS $$

DECLARE

    policy_record RECORD;

BEGIN

    SELECT
        response_minutes,
        resolution_minutes

    INTO policy_record

    FROM monitoring_sla_policies

    WHERE severity = NEW.severity;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'SLA policy not found for severity: %',
            NEW.severity;

    END IF;


    NEW.sla_response_minutes :=
        policy_record.response_minutes;


    NEW.sla_resolution_minutes :=
        policy_record.resolution_minutes;


    NEW.response_due_at :=
        NEW.opened_at
        + make_interval(
            mins => policy_record.response_minutes
        );


    NEW.resolution_due_at :=
        NEW.opened_at
        + make_interval(
            mins => policy_record.resolution_minutes
        );


    RETURN NEW;

END;

$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: monitoring_recovery_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_recovery_jobs (
    id bigint NOT NULL,
    incident_id bigint NOT NULL,
    component text NOT NULL,
    action_type text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    trigger_source text DEFAULT 'automatic'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now(),
    first_started_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    verification_after timestamp with time zone,
    verification_deadline timestamp with time zone,
    locked_until timestamp with time zone,
    claim_token uuid,
    last_error text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_recovery_jobs_action_type_check CHECK ((action_type = ANY (ARRAY['resync_monitoring'::text, 'recheck_availability'::text]))),
    CONSTRAINT monitoring_recovery_jobs_check CHECK (((attempt_count >= 0) AND (attempt_count <= max_attempts))),
    CONSTRAINT monitoring_recovery_jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 5))),
    CONSTRAINT monitoring_recovery_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'verifying'::text, 'retry'::text, 'recovered'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT monitoring_recovery_jobs_trigger_source_check CHECK ((trigger_source = ANY (ARRAY['automatic'::text, 'manual'::text])))
);


--
-- Name: claim_recovery_job(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_recovery_job() RETURNS SETOF public.monitoring_recovery_jobs
    LANGUAGE plpgsql
    AS $$

DECLARE

    selected_job_id BIGINT;

    selected_component TEXT;

BEGIN

    -- Prevent concurrent claim operations.

    PERFORM pg_advisory_xact_lock(
        730001::bigint
    );

    SELECT
        j.id,
        j.component

    INTO
        selected_job_id,
        selected_component

    FROM monitoring_recovery_jobs j

    INNER JOIN monitoring_recovery_policies p
        ON p.component = j.component

    INNER JOIN monitoring_incidents i
        ON i.id = j.incident_id

    WHERE j.status IN (
        'pending',
        'retry'
    )

    AND j.attempt_count < j.max_attempts

    AND j.next_attempt_at <= NOW()

    AND i.status IN (
        'open',
        'acknowledged'
    )

    AND p.enabled = TRUE

    AND p.action_type = j.action_type

    AND (
        p.circuit_open_until IS NULL
        OR p.circuit_open_until <= NOW()
    )

    AND (
        p.last_started_at IS NULL

        OR p.last_started_at <=
            NOW() - make_interval(
                mins => p.cooldown_minutes
            )
    )

    AND NOT EXISTS (

        SELECT 1

        FROM monitoring_recovery_jobs active_job

        WHERE active_job.component = j.component

        AND active_job.status IN (
            'processing',
            'verifying'
        )

    )

    ORDER BY j.created_at, j.id

    LIMIT 1

    FOR UPDATE OF j, p SKIP LOCKED;


    IF selected_job_id IS NULL THEN

        RETURN;

    END IF;


    UPDATE monitoring_recovery_policies

    SET

        last_started_at = NOW(),

        updated_at = NOW()

    WHERE component = selected_component;


    RETURN QUERY

    UPDATE monitoring_recovery_jobs j

    SET

        status = 'processing',

        attempt_count = j.attempt_count + 1,

        first_started_at = COALESCE(
            j.first_started_at,
            NOW()
        ),

        last_attempt_at = NOW(),

        locked_until =
            NOW() + INTERVAL '10 minutes',

        claim_token = gen_random_uuid(),

        last_error = NULL,

        updated_at = NOW()

    WHERE j.id = selected_job_id

    RETURNING j.*;

END;

$$;


--
-- Name: security_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_alerts (
    id bigint NOT NULL,
    alert_type text NOT NULL,
    severity text NOT NULL,
    ip_address text NOT NULL,
    event_count integer NOT NULL,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    notification_status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now(),
    locked_until timestamp with time zone,
    claim_token uuid,
    notified_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_alerts_event_count_check CHECK ((event_count > 0)),
    CONSTRAINT security_alerts_notification_status_check CHECK ((notification_status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'dead'::text]))),
    CONSTRAINT security_alerts_severity_check CHECK ((severity = ANY (ARRAY['warning'::text, 'critical'::text])))
);


--
-- Name: claim_security_alert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_security_alert() RETURNS SETOF public.security_alerts
    LANGUAGE sql
    AS $$

    WITH candidate AS (

        SELECT id

        FROM security_alerts

        WHERE notification_status IN (
            'pending',
            'failed'
        )

        AND attempt_count < 5

        AND next_attempt_at <= NOW()

        ORDER BY created_at ASC, id ASC

        LIMIT 1

        FOR UPDATE SKIP LOCKED
    )

    UPDATE security_alerts AS alert

    SET
        notification_status = 'processing',

        attempt_count =
            alert.attempt_count + 1,

        locked_until =
            NOW() + INTERVAL '10 minutes',

        claim_token = gen_random_uuid()

    FROM candidate

    WHERE alert.id = candidate.id

    RETURNING alert.*;

$$;


--
-- Name: monitoring_incident_escalations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_incident_escalations (
    id bigint NOT NULL,
    incident_id bigint NOT NULL,
    escalation_type text NOT NULL,
    severity text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    notification_status text DEFAULT 'pending'::text NOT NULL,
    notified_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now(),
    last_attempt_at timestamp with time zone,
    last_error text,
    telegram_message_id text,
    locked_until timestamp with time zone,
    claim_token uuid,
    CONSTRAINT monitoring_incident_escalations_escalation_type_check CHECK ((escalation_type = ANY (ARRAY['response_breach'::text, 'resolution_breach'::text]))),
    CONSTRAINT monitoring_incident_escalations_notification_status_check CHECK ((notification_status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'dead'::text]))),
    CONSTRAINT monitoring_incident_escalations_severity_check CHECK ((severity = ANY (ARRAY['warning'::text, 'critical'::text])))
);


--
-- Name: claim_sla_notification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_sla_notification() RETURNS SETOF public.monitoring_incident_escalations
    LANGUAGE sql
    AS $$

    WITH candidate AS (

        SELECT id

        FROM monitoring_incident_escalations

        WHERE notification_status IN (
            'pending',
            'failed'
        )

          AND attempt_count < 5

          AND next_attempt_at <= NOW()

        ORDER BY detected_at ASC, id ASC

        LIMIT 1

        FOR UPDATE SKIP LOCKED

    )

    UPDATE monitoring_incident_escalations e

    SET

        notification_status = 'processing',

        attempt_count = e.attempt_count + 1,

        last_attempt_at = NOW(),

        locked_until =
            NOW() + INTERVAL '10 minutes',

        claim_token = gen_random_uuid()

    FROM candidate

    WHERE e.id = candidate.id

    RETURNING e.*;

$$;


--
-- Name: cleanup_api_protection(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_api_protection() RETURNS TABLE(deleted_counters bigint, deleted_blocks bigint, deleted_events bigint)
    LANGUAGE plpgsql
    AS $$

DECLARE

    counters_count BIGINT;

    blocks_count BIGINT;

    events_count BIGINT;

BEGIN


    DELETE FROM security_rate_limits

    WHERE updated_at <

        NOW() - INTERVAL '2 days';


    GET DIAGNOSTICS counters_count = ROW_COUNT;


    DELETE FROM security_ip_blocks

    WHERE expires_at <

        NOW() - INTERVAL '90 days';


    GET DIAGNOSTICS blocks_count = ROW_COUNT;


    DELETE FROM security_protection_events

    WHERE created_at <

        NOW() - INTERVAL '90 days';


    GET DIAGNOSTICS events_count = ROW_COUNT;


    RETURN QUERY

    SELECT

        counters_count,

        blocks_count,

        events_count;

END;

$$;


--
-- Name: cleanup_ci_monitoring(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_ci_monitoring() RETURNS bigint
    LANGUAGE plpgsql
    AS $$

DECLARE

    deleted_count BIGINT;

BEGIN

    DELETE FROM monitoring_ci_runs

    WHERE checked_at <

        NOW() - INTERVAL '90 days';


    GET DIAGNOSTICS

        deleted_count = ROW_COUNT;


    RETURN deleted_count;

END;

$$;


--
-- Name: cleanup_security_logs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_security_logs() RETURNS TABLE(deleted_events bigint, deleted_alerts bigint)
    LANGUAGE plpgsql
    AS $$

DECLARE

    events_count BIGINT;

    alerts_count BIGINT;

BEGIN

    DELETE FROM security_events

    WHERE created_at <
        NOW() - INTERVAL '30 days';

    GET DIAGNOSTICS events_count = ROW_COUNT;


    DELETE FROM security_alerts

    WHERE created_at <
        NOW() - INTERVAL '90 days'

    AND notification_status IN (
        'sent',
        'dead'
    );

    GET DIAGNOSTICS alerts_count = ROW_COUNT;


    RETURN QUERY

    SELECT events_count, alerts_count;

END;

$$;


--
-- Name: consume_security_rate_limit(inet, text, integer, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.consume_security_rate_limit(p_ip inet, p_scope text, p_window_seconds integer, p_limit integer, p_auto_block boolean DEFAULT false) RETURNS TABLE(allowed boolean, blocked boolean, used_count bigint, remaining bigint, retry_after integer)
    LANGUAGE plpgsql
    AS $$

DECLARE

    v_now TIMESTAMPTZ;

    v_window TIMESTAMPTZ;

    v_count BIGINT;

    v_expires TIMESTAMPTZ;

    v_violations BIGINT;

BEGIN

    IF p_window_seconds < 1

        OR p_window_seconds > 86400

        OR p_limit < 1

        OR p_limit > 100000

        OR p_ip IS NULL

        OR p_scope IS NULL

    THEN

        RAISE EXCEPTION 'Invalid rate limit parameters';

    END IF;


    PERFORM pg_advisory_xact_lock(

        hashtextextended(
            host(p_ip),
            0
        )
    );


    v_now := clock_timestamp();


    SELECT MAX(b.expires_at)

    INTO v_expires

    FROM security_ip_blocks b

    WHERE b.ip_address = p_ip

    AND b.revoked_at IS NULL

    AND b.expires_at > v_now;


    IF v_expires IS NOT NULL THEN

        RETURN QUERY

        SELECT

            FALSE,

            TRUE,

            0::BIGINT,

            0::BIGINT,

            GREATEST(
                1,

                CEIL(
                    EXTRACT(
                        EPOCH FROM (
                            v_expires - v_now
                        )
                    )
                )::INTEGER
            );

        RETURN;

    END IF;


    v_window := to_timestamp(

        FLOOR(
            EXTRACT(EPOCH FROM v_now)
            / p_window_seconds
        ) * p_window_seconds
    );


    INSERT INTO security_rate_limits AS r (

        ip_address,

        scope,

        window_start,

        request_count,

        updated_at
    )

    VALUES (

        p_ip,

        p_scope,

        v_window,

        1,

        v_now
    )

    ON CONFLICT (
        ip_address,
        scope,
        window_start
    )

    DO UPDATE SET

        request_count =
            r.request_count + 1,

        updated_at = v_now

    RETURNING request_count

    INTO v_count;


    IF v_count > p_limit THEN

        -- Регистрируем одно превышение на интервал.
        -- Это предотвращает переполнение журнала.

        IF v_count = p_limit + 1 THEN

            INSERT INTO security_protection_events (

                event_type,

                ip_address,

                scope,

                details,

                created_at
            )

            VALUES (

                'rate_limit_exceeded',

                p_ip,

                p_scope,

                jsonb_build_object(

                    'limit', p_limit,

                    'window_seconds',
                    p_window_seconds

                ),

                v_now
            );

        END IF;


        IF p_auto_block THEN

            SELECT COUNT(*)

            INTO v_violations

            FROM security_protection_events e

            WHERE e.ip_address = p_ip

            AND e.event_type =
                'rate_limit_exceeded'

            AND e.scope = p_scope

            AND e.created_at >=

                v_now - INTERVAL '10 minutes';


            IF v_violations >= 5 THEN

                v_expires :=

                    v_now + INTERVAL '30 minutes';


                INSERT INTO security_ip_blocks (

                    ip_address,

                    block_type,

                    reason,

                    blocked_at,

                    expires_at
                )

                VALUES (

                    p_ip,

                    'automatic',

                    'Repeated rate limit violations',

                    v_now,

                    v_expires
                );


                INSERT INTO security_protection_events (

                    event_type,

                    ip_address,

                    scope,

                    details,

                    created_at
                )

                VALUES (

                    'automatic_block',

                    p_ip,

                    p_scope,

                    jsonb_build_object(

                        'violations', v_violations,

                        'duration_minutes', 30
                    ),

                    v_now
                );


                RETURN QUERY

                SELECT

                    FALSE,

                    TRUE,

                    v_count,

                    0::BIGINT,

                    1800;

                RETURN;

            END IF;

        END IF;


        RETURN QUERY

        SELECT

            FALSE,

            FALSE,

            v_count,

            0::BIGINT,

            GREATEST(

                1,

                CEIL(

                    EXTRACT(

                        EPOCH FROM (

                            v_window

                            + make_interval(
                                secs => p_window_seconds
                            )

                            - v_now
                        )
                    )

                )::INTEGER
            );

        RETURN;

    END IF;


    RETURN QUERY

    SELECT

        TRUE,

        FALSE,

        v_count,

        GREATEST(
            0::BIGINT,
            p_limit::BIGINT - v_count
        ),

        0;

END;

$$;


--
-- Name: detect_monitoring_sla_breaches(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.detect_monitoring_sla_breaches() RETURNS SETOF public.monitoring_incident_escalations
    LANGUAGE sql
    AS $$

    INSERT INTO
        monitoring_incident_escalations (

        incident_id,

        escalation_type,

        severity,

        due_at

    )

    SELECT

        id,

        'response_breach',

        severity,

        response_due_at

    FROM monitoring_incident_sla

    WHERE response_sla_status = 'breached'

      AND response_due_at IS NOT NULL


    UNION ALL


    SELECT

        id,

        'resolution_breach',

        severity,

        resolution_due_at

    FROM monitoring_incident_sla

    WHERE resolution_sla_status = 'breached'

      AND resolution_due_at IS NOT NULL


    ON CONFLICT (
        incident_id,
        escalation_type
    )

    DO NOTHING


    RETURNING *;

$$;


--
-- Name: detect_security_threats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.detect_security_threats() RETURNS integer
    LANGUAGE plpgsql
    AS $$

DECLARE
    inserted_count INTEGER;

BEGIN

    WITH suspicious AS (

        SELECT
            ip_address,

            CASE

                WHEN event_type = 'login_failed'
                    THEN 'repeated_login_failures'

                ELSE 'repeated_unauthorized_access'

            END AS alert_type,

            COUNT(*)::integer AS event_count,

            date_bin(
                INTERVAL '10 minutes',
                created_at,
                TIMESTAMPTZ '2000-01-01 00:00:00+00'
            ) AS window_start

        FROM security_events

        WHERE created_at >= NOW()
            - INTERVAL '20 minutes'

        AND event_type IN (
            'login_failed',
            'unauthorized_access'
        )

        AND ip_address IS NOT NULL

        AND ip_address <> 'unknown'

        GROUP BY
            ip_address,
            event_type,
            date_bin(
                INTERVAL '10 minutes',
                created_at,
                TIMESTAMPTZ '2000-01-01 00:00:00+00'
            )

        HAVING COUNT(*) >=

            CASE

                WHEN event_type = 'login_failed'
                    THEN 5

                ELSE 10

            END
    ),

    inserted AS (

        INSERT INTO security_alerts (
            alert_type,
            severity,
            ip_address,
            event_count,
            window_start,
            window_end
        )

        SELECT
            alert_type,

            CASE

                WHEN alert_type =
                    'repeated_login_failures'
                    THEN 'critical'

                ELSE 'warning'

            END,

            ip_address,

            event_count,

            window_start,

            window_start + INTERVAL '10 minutes'

        FROM suspicious

        ON CONFLICT (
            alert_type,
            ip_address,
            window_start
        )

        DO NOTHING

        RETURNING id
    )

    SELECT COUNT(*)::integer

    INTO inserted_count

    FROM inserted;

    RETURN inserted_count;

END;

$$;


--
-- Name: enqueue_recovery_jobs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_recovery_jobs() RETURNS integer
    LANGUAGE plpgsql
    AS $$

DECLARE

    inserted_count INTEGER;

BEGIN

    INSERT INTO monitoring_recovery_jobs (
        incident_id,
        component,
        action_type,
        max_attempts
    )

    SELECT

        i.id,
        i.component,
        p.action_type,
        p.max_attempts

    FROM monitoring_incidents i

    INNER JOIN monitoring_recovery_policies p
        ON p.component = i.component

    WHERE i.status IN (
        'open',
        'acknowledged'
    )

    AND i.severity = 'critical'

    AND p.enabled = TRUE

    AND (
        p.circuit_open_until IS NULL
        OR p.circuit_open_until <= NOW()
    )

    ON CONFLICT (
        incident_id,
        action_type
    ) DO NOTHING;

    GET DIAGNOSTICS
        inserted_count = ROW_COUNT;

    RETURN inserted_count;

END;

$$;


--
-- Name: fail_recovery_job(bigint, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fail_recovery_job(p_job_id bigint, p_claim_token uuid, p_error text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$

DECLARE

    affected_job monitoring_recovery_jobs%ROWTYPE;

BEGIN

    UPDATE monitoring_recovery_jobs j

    SET

        status = CASE

            WHEN j.attempt_count >= j.max_attempts
                THEN 'failed'

            ELSE 'retry'

        END,

        next_attempt_at = CASE

            WHEN j.attempt_count >= j.max_attempts
                THEN NULL

            ELSE NOW() + make_interval(

                mins => CASE j.attempt_count

                    WHEN 1 THEN 5

                    WHEN 2 THEN 10

                    WHEN 3 THEN 20

                    ELSE 40

                END

            )

        END,

        completed_at = CASE

            WHEN j.attempt_count >= j.max_attempts
                THEN NOW()

            ELSE NULL

        END,

        last_error = LEFT(
            COALESCE(p_error, 'Unknown error'),
            500
        ),

        locked_until = NULL,

        claim_token = NULL,

        verification_after = NULL,

        verification_deadline = NULL,

        updated_at = NOW()

    WHERE j.id = p_job_id

    AND j.claim_token = p_claim_token

    AND j.status IN (
        'processing',
        'verifying'
    )

    RETURNING j.*

    INTO affected_job;


    IF NOT FOUND THEN

        RETURN FALSE;

    END IF;


    UPDATE monitoring_recovery_policies p

    SET

        consecutive_failures =
            p.consecutive_failures + 1,

        circuit_open_until = CASE

            WHEN p.consecutive_failures + 1
                >= p.failure_threshold

            THEN NOW() + INTERVAL '60 minutes'

            ELSE p.circuit_open_until

        END,

        updated_at = NOW()

    WHERE p.component = affected_job.component;


    RETURN TRUE;

END;

$$;


--
-- Name: log_monitoring_incident_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_monitoring_incident_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$

DECLARE

    event_actor TEXT;

BEGIN

    event_actor := CASE
        WHEN current_setting(
            'app.incident_actor',
            true
        ) = 'admin'
        THEN 'admin'

        WHEN current_setting(
            'app.incident_actor',
            true
        ) = 'system'
        THEN 'system'

        ELSE 'unknown'
    END;


    -- Создание инцидента

    IF TG_OP = 'INSERT' THEN

        INSERT INTO monitoring_incident_events (
            incident_id,
            event_type,
            actor,
            message,
            metadata
        )
        VALUES (
            NEW.id,
            'opened',
            event_actor,
            'Обнаружен новый инцидент',
            jsonb_build_object(
                'component', NEW.component,
                'severity', NEW.severity,
                'status', NEW.status,
                'occurrences', NEW.occurrences
            )
        );

        RETURN NEW;

    END IF;


    -- Изменение статуса

    IF OLD.status IS DISTINCT FROM NEW.status THEN

        INSERT INTO monitoring_incident_events (
            incident_id,
            event_type,
            actor,
            message,
            metadata
        )
        VALUES (
            NEW.id,

            CASE
                WHEN NEW.status = 'acknowledged'
                THEN 'acknowledged'

                WHEN NEW.status = 'resolved'
                THEN 'resolved'

                ELSE 'status_changed'
            END,

            event_actor,

            CASE
                WHEN NEW.status = 'acknowledged'
                THEN 'Инцидент принят в работу'

                WHEN NEW.status = 'resolved'
                THEN 'Инцидент устранён'

                ELSE 'Статус инцидента изменён'
            END,

            jsonb_build_object(
                'old_status', OLD.status,
                'new_status', NEW.status
            )
        );

    END IF;


    -- Изменение критичности

    IF OLD.severity IS DISTINCT FROM NEW.severity THEN

        INSERT INTO monitoring_incident_events (
            incident_id,
            event_type,
            actor,
            message,
            metadata
        )
        VALUES (
            NEW.id,
            'severity_changed',
            event_actor,
            'Критичность инцидента изменена',
            jsonb_build_object(
                'old_severity', OLD.severity,
                'new_severity', NEW.severity
            )
        );

    END IF;


    -- Повторное обнаружение

    IF NEW.occurrences > OLD.occurrences THEN

        INSERT INTO monitoring_incident_events (
            incident_id,
            event_type,
            actor,
            message,
            metadata
        )
        VALUES (
            NEW.id,
            'repeated',
            event_actor,
            'Проблема обнаружена повторно',
            jsonb_build_object(
                'old_occurrences', OLD.occurrences,
                'new_occurrences', NEW.occurrences
            )
        );

    END IF;


    RETURN NEW;

END;

$$;


--
-- Name: log_recovery_job_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_recovery_job_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$

BEGIN

    IF TG_OP = 'INSERT' THEN

        INSERT INTO monitoring_recovery_events (
            job_id,
            event_type,
            message
        )
        VALUES (
            NEW.id,
            'created',
            'Recovery job created'
        );

    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN

        INSERT INTO monitoring_recovery_events (
            job_id,
            event_type,
            message
        )
        VALUES (
            NEW.id,
            NEW.status,
            COALESCE(
                NEW.last_error,
                'Status changed to ' || NEW.status
            )
        );

    END IF;

    RETURN NEW;

END;

$$;


--
-- Name: maintain_recovery_jobs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.maintain_recovery_jobs() RETURNS integer
    LANGUAGE plpgsql
    AS $$

DECLARE

    job RECORD;

    processed_count INTEGER := 0;

BEGIN

    PERFORM pg_advisory_xact_lock(
        730001::bigint
    );


    -- Recover expired processing leases.

    FOR job IN

        SELECT id, claim_token

        FROM monitoring_recovery_jobs

        WHERE status = 'processing'

        AND locked_until <= NOW()

        FOR UPDATE

    LOOP

        PERFORM fail_recovery_job(
            job.id,
            job.claim_token,
            'Processing lease expired'
        );

        processed_count :=
            processed_count + 1;

    END LOOP;


    -- Cancel queued jobs when the incident
    -- is resolved or the policy is disabled.

    UPDATE monitoring_recovery_jobs j

    SET

        status = 'cancelled',

        completed_at = NOW(),

        next_attempt_at = NULL,

        last_error =
            'Incident resolved or policy disabled',

        updated_at = NOW()

    FROM monitoring_incidents i,
         monitoring_recovery_policies p

    WHERE j.incident_id = i.id

    AND j.component = p.component

    AND j.status IN (
        'pending',
        'retry'
    )

    AND (
        i.status = 'resolved'
        OR p.enabled = FALSE
    );


    -- Verify using the latest real snapshot.

    FOR job IN

        SELECT

            j.*,

            i.status AS incident_status,

            s.checked_at AS snapshot_time,

            s.components -> j.component
                ->> 'status' AS component_status

        FROM monitoring_recovery_jobs j

        INNER JOIN monitoring_incidents i
            ON i.id = j.incident_id

        LEFT JOIN LATERAL (

            SELECT
                checked_at,
                components

            FROM monitoring_snapshots

            ORDER BY checked_at DESC

            LIMIT 1

        ) s ON TRUE

        WHERE j.status = 'verifying'

        FOR UPDATE OF j

    LOOP

        IF job.snapshot_time >=
            job.verification_after

        AND job.snapshot_time <= NOW()

        AND job.snapshot_time >=
            NOW() - INTERVAL '45 minutes'

        AND job.component_status = 'healthy'

        AND job.incident_status = 'resolved'

        THEN

            UPDATE monitoring_recovery_jobs

            SET

                status = 'recovered',

                completed_at = NOW(),

                next_attempt_at = NULL,

                claim_token = NULL,

                locked_until = NULL,

                last_error = NULL,

                updated_at = NOW()

            WHERE id = job.id;


            UPDATE monitoring_recovery_policies

            SET

                consecutive_failures = 0,

                circuit_open_until = NULL,

                updated_at = NOW()

            WHERE component = job.component;


            processed_count :=
                processed_count + 1;


        ELSIF job.verification_deadline <= NOW()

        THEN

            PERFORM fail_recovery_job(

                job.id,

                job.claim_token,

                'Recovery verification timed out'

            );

            processed_count :=
                processed_count + 1;

        END IF;

    END LOOP;


    RETURN processed_count;

END;

$$;


--
-- Name: mark_recovery_verifying(bigint, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_recovery_verifying(p_job_id bigint, p_claim_token uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$

BEGIN

    UPDATE monitoring_recovery_jobs

    SET

        status = 'verifying',

        verification_after = NOW(),

        verification_deadline =
            NOW() + INTERVAL '45 minutes',

        locked_until = NULL,

        updated_at = NOW()

    WHERE id = p_job_id

    AND claim_token = p_claim_token

    AND status = 'processing'

    AND locked_until > NOW();

    RETURN FOUND;

END;

$$;


--
-- Name: monitoring_backup_alert_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_backup_alert_state (
    id integer NOT NULL,
    last_status text DEFAULT 'unknown'::text NOT NULL,
    last_notified_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_backup_alert_state_id_check CHECK ((id = 1)),
    CONSTRAINT monitoring_backup_alert_state_last_status_check CHECK ((last_status = ANY (ARRAY['healthy'::text, 'warning'::text, 'critical'::text, 'unknown'::text])))
);


--
-- Name: monitoring_backup_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_backup_runs (
    id bigint NOT NULL,
    backup_id text NOT NULL,
    status text NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    duration_seconds numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_backup_runs_duration_seconds_check CHECK ((duration_seconds >= (0)::numeric)),
    CONSTRAINT monitoring_backup_runs_status_check CHECK ((status = ANY (ARRAY['completed'::text, 'failed'::text])))
);


--
-- Name: monitoring_backup_health; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.monitoring_backup_health AS
 WITH latest AS (
         SELECT monitoring_backup_runs.backup_id,
            monitoring_backup_runs.status,
            monitoring_backup_runs.checked_at
           FROM public.monitoring_backup_runs
          ORDER BY monitoring_backup_runs.checked_at DESC, monitoring_backup_runs.id DESC
         LIMIT 1
        ), last_success AS (
         SELECT monitoring_backup_runs.backup_id,
            monitoring_backup_runs.checked_at
           FROM public.monitoring_backup_runs
          WHERE (monitoring_backup_runs.status = 'completed'::text)
          ORDER BY monitoring_backup_runs.checked_at DESC, monitoring_backup_runs.id DESC
         LIMIT 1
        ), stats AS (
         SELECT count(*) AS total_runs,
            count(*) FILTER (WHERE (monitoring_backup_runs.status = 'completed'::text)) AS successful_runs,
            count(*) FILTER (WHERE (monitoring_backup_runs.status = 'failed'::text)) AS failed_runs
           FROM public.monitoring_backup_runs
          WHERE (monitoring_backup_runs.checked_at >= (now() - '30 days'::interval))
        ), base AS (
         SELECT latest.backup_id AS latest_backup_id,
            latest.status AS latest_backup_status,
            latest.checked_at AS latest_backup_at,
            last_success.backup_id AS last_success_id,
            last_success.checked_at AS last_success_at,
                CASE
                    WHEN (last_success.checked_at IS NULL) THEN NULL::numeric
                    ELSE round((EXTRACT(epoch FROM (now() - last_success.checked_at)) / (3600)::numeric), 2)
                END AS backup_age_hours,
            stats.total_runs,
            stats.successful_runs,
            stats.failed_runs,
            round(((100.0 * (stats.successful_runs)::numeric) / (NULLIF(stats.total_runs, 0))::numeric), 2) AS success_rate
           FROM ((stats
             LEFT JOIN latest ON (true))
             LEFT JOIN last_success ON (true))
        )
 SELECT latest_backup_id,
    latest_backup_status,
    latest_backup_at,
    last_success_id,
    last_success_at,
    backup_age_hours,
    total_runs,
    successful_runs,
    failed_runs,
    success_rate,
        CASE
            WHEN (last_success_at IS NULL) THEN 'unknown'::text
            WHEN (backup_age_hours >= (48)::numeric) THEN 'critical'::text
            WHEN (latest_backup_status = 'failed'::text) THEN 'warning'::text
            WHEN (backup_age_hours >= (26)::numeric) THEN 'warning'::text
            ELSE 'healthy'::text
        END AS overall_status,
        CASE
            WHEN (last_success_at IS NULL) THEN 'No successful backup registered'::text
            WHEN (backup_age_hours >= (48)::numeric) THEN 'Backup is older than 48 hours'::text
            WHEN (latest_backup_status = 'failed'::text) THEN 'Latest backup attempt failed'::text
            WHEN (backup_age_hours >= (26)::numeric) THEN 'Backup is older than 26 hours'::text
            ELSE 'Backup system is healthy'::text
        END AS status_reason
   FROM base;


--
-- Name: monitoring_backup_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monitoring_backup_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitoring_backup_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monitoring_backup_runs_id_seq OWNED BY public.monitoring_backup_runs.id;


--
-- Name: monitoring_ci_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_ci_runs (
    id bigint NOT NULL,
    run_id text NOT NULL,
    workflow_name text NOT NULL,
    commit_sha text NOT NULL,
    branch_name text NOT NULL,
    status text NOT NULL,
    duration_seconds integer DEFAULT 0 NOT NULL,
    run_url text NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_ci_runs_duration_seconds_check CHECK ((duration_seconds >= 0)),
    CONSTRAINT monitoring_ci_runs_status_check CHECK ((status = ANY (ARRAY['success'::text, 'failure'::text, 'cancelled'::text])))
);


--
-- Name: monitoring_ci_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monitoring_ci_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitoring_ci_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monitoring_ci_runs_id_seq OWNED BY public.monitoring_ci_runs.id;


--
-- Name: monitoring_ci_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.monitoring_ci_summary AS
 SELECT count(*) AS total_runs,
    count(*) FILTER (WHERE (status = 'success'::text)) AS successful_runs,
    count(*) FILTER (WHERE (status = 'failure'::text)) AS failed_runs,
    count(*) FILTER (WHERE (status = 'cancelled'::text)) AS cancelled_runs,
    COALESCE(round(((100.0 * (count(*) FILTER (WHERE (status = 'success'::text)))::numeric) / (NULLIF(count(*) FILTER (WHERE (status = ANY (ARRAY['success'::text, 'failure'::text]))), 0))::numeric), 2), (0)::numeric) AS success_rate,
    COALESCE(round(avg(duration_seconds), 2), (0)::numeric) AS average_duration_seconds,
    max(checked_at) AS last_run_at
   FROM public.monitoring_ci_runs
  WHERE (checked_at >= (now() - '30 days'::interval));


--
-- Name: monitoring_cloud_alert_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_cloud_alert_state (
    id integer NOT NULL,
    last_signature text,
    last_notified_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_cloud_alert_state_id_check CHECK ((id = 1))
);


--
-- Name: monitoring_cloud_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_cloud_checks (
    id bigint NOT NULL,
    run_id text NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    overall_status text NOT NULL,
    problems_count integer DEFAULT 0 NOT NULL,
    components jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_cloud_checks_overall_status_check CHECK ((overall_status = ANY (ARRAY['healthy'::text, 'warning'::text, 'critical'::text, 'unknown'::text]))),
    CONSTRAINT monitoring_cloud_checks_problems_count_check CHECK ((problems_count >= 0))
);


--
-- Name: monitoring_cloud_checks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monitoring_cloud_checks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitoring_cloud_checks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monitoring_cloud_checks_id_seq OWNED BY public.monitoring_cloud_checks.id;


--
-- Name: monitoring_cloud_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_cloud_notifications (
    id bigint NOT NULL,
    run_id text NOT NULL,
    signature text NOT NULL,
    telegram_message_id text NOT NULL,
    notified_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: monitoring_cloud_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monitoring_cloud_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitoring_cloud_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monitoring_cloud_notifications_id_seq OWNED BY public.monitoring_cloud_notifications.id;


--
-- Name: monitoring_heartbeats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_heartbeats (
    source text NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    execution_id text,
    received_count bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: monitoring_heartbeat_health; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.monitoring_heartbeat_health AS
 SELECT 'local_n8n'::text AS source,
    h.last_seen_at,
    COALESCE(h.received_count, (0)::bigint) AS received_count,
    round((EXTRACT(epoch FROM (now() - h.last_seen_at)) / (60)::numeric), 2) AS age_minutes,
        CASE
            WHEN (h.last_seen_at IS NULL) THEN 'unknown'::text
            WHEN (h.last_seen_at < (now() - '00:30:00'::interval)) THEN 'critical'::text
            WHEN (h.last_seen_at < (now() - '00:15:00'::interval)) THEN 'warning'::text
            ELSE 'healthy'::text
        END AS status
   FROM (( SELECT 1 AS "?column?") base
     LEFT JOIN public.monitoring_heartbeats h ON ((h.source = 'local_n8n'::text)));


--
-- Name: monitoring_incident_escalations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monitoring_incident_escalations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitoring_incident_escalations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monitoring_incident_escalations_id_seq OWNED BY public.monitoring_incident_escalations.id;


--
-- Name: monitoring_incident_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_incident_events (
    id bigint NOT NULL,
    incident_id bigint NOT NULL,
    event_type text NOT NULL,
    actor text NOT NULL,
    message text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_incident_events_actor_check CHECK ((actor = ANY (ARRAY['system'::text, 'admin'::text, 'unknown'::text]))),
    CONSTRAINT monitoring_incident_events_event_type_check CHECK ((event_type = ANY (ARRAY['opened'::text, 'repeated'::text, 'acknowledged'::text, 'resolved'::text, 'severity_changed'::text, 'status_changed'::text])))
);


--
-- Name: monitoring_incident_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monitoring_incident_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitoring_incident_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monitoring_incident_events_id_seq OWNED BY public.monitoring_incident_events.id;


--
-- Name: monitoring_incident_processing_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_incident_processing_state (
    id integer NOT NULL,
    last_processed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_incident_processing_state_id_check CHECK ((id = 1))
);


--
-- Name: monitoring_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_incidents (
    id bigint NOT NULL,
    component text NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    severity text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    resolved_at timestamp with time zone,
    occurrences integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sla_response_minutes integer,
    sla_resolution_minutes integer,
    response_due_at timestamp with time zone,
    resolution_due_at timestamp with time zone,
    CONSTRAINT incident_acknowledged_valid CHECK (((acknowledged_at IS NULL) OR (acknowledged_at >= opened_at))),
    CONSTRAINT incident_last_seen_valid CHECK ((last_seen_at >= opened_at)),
    CONSTRAINT incident_resolution_status_valid CHECK ((((status = 'resolved'::text) AND (resolved_at IS NOT NULL)) OR ((status <> 'resolved'::text) AND (resolved_at IS NULL)))),
    CONSTRAINT incident_resolved_valid CHECK (((resolved_at IS NULL) OR (resolved_at >= last_seen_at))),
    CONSTRAINT monitoring_incidents_component_check CHECK ((component = ANY (ARRAY['system_health'::text, 'availability'::text, 'performance_frontend'::text, 'performance_backend'::text, 'daily_reports'::text]))),
    CONSTRAINT monitoring_incidents_occurrences_check CHECK ((occurrences >= 1)),
    CONSTRAINT monitoring_incidents_severity_check CHECK ((severity = ANY (ARRAY['warning'::text, 'critical'::text]))),
    CONSTRAINT monitoring_incidents_status_check CHECK ((status = ANY (ARRAY['open'::text, 'acknowledged'::text, 'resolved'::text])))
);


--
-- Name: monitoring_incident_sla; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.monitoring_incident_sla AS
 WITH calculated AS (
         SELECT i.id,
            i.component,
            i.severity,
            i.status,
            i.opened_at,
            i.acknowledged_at,
            i.resolved_at,
            i.sla_response_minutes,
            i.sla_resolution_minutes,
            i.response_due_at,
            i.resolution_due_at,
            (EXTRACT(epoch FROM (i.response_due_at - COALESCE(i.acknowledged_at, i.resolved_at, now()))) / (60)::numeric) AS response_remaining_minutes,
            (EXTRACT(epoch FROM (i.resolution_due_at - COALESCE(i.resolved_at, now()))) / (60)::numeric) AS resolution_remaining_minutes
           FROM public.monitoring_incidents i
        )
 SELECT id,
    component,
    severity,
    status,
    opened_at,
    acknowledged_at,
    resolved_at,
    sla_response_minutes,
    sla_resolution_minutes,
    response_due_at,
    resolution_due_at,
    response_remaining_minutes,
    resolution_remaining_minutes,
        CASE
            WHEN (response_due_at IS NULL) THEN 'unknown'::text
            WHEN (response_remaining_minutes < (0)::numeric) THEN 'breached'::text
            WHEN ((acknowledged_at IS NOT NULL) OR (resolved_at IS NOT NULL)) THEN 'met'::text
            WHEN (response_remaining_minutes <= ((sla_response_minutes)::numeric * 0.25)) THEN 'at_risk'::text
            ELSE 'on_track'::text
        END AS response_sla_status,
        CASE
            WHEN (resolution_due_at IS NULL) THEN 'unknown'::text
            WHEN (resolution_remaining_minutes < (0)::numeric) THEN 'breached'::text
            WHEN (resolved_at IS NOT NULL) THEN 'met'::text
            WHEN (resolution_remaining_minutes <= ((sla_resolution_minutes)::numeric * 0.25)) THEN 'at_risk'::text
            ELSE 'on_track'::text
        END AS resolution_sla_status
   FROM calculated;


--
-- Name: monitoring_incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monitoring_incidents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitoring_incidents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monitoring_incidents_id_seq OWNED BY public.monitoring_incidents.id;


--
-- Name: monitoring_recovery_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_recovery_events (
    id bigint NOT NULL,
    job_id bigint NOT NULL,
    event_type text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: monitoring_recovery_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monitoring_recovery_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitoring_recovery_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monitoring_recovery_events_id_seq OWNED BY public.monitoring_recovery_events.id;


--
-- Name: monitoring_recovery_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monitoring_recovery_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitoring_recovery_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monitoring_recovery_jobs_id_seq OWNED BY public.monitoring_recovery_jobs.id;


--
-- Name: monitoring_recovery_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_recovery_notifications (
    event_id bigint NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now(),
    locked_until timestamp with time zone,
    claim_token uuid,
    sent_at timestamp with time zone,
    CONSTRAINT monitoring_recovery_notifications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'dead'::text])))
);


--
-- Name: monitoring_recovery_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_recovery_policies (
    component text NOT NULL,
    action_type text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    cooldown_minutes integer DEFAULT 15 NOT NULL,
    failure_threshold integer DEFAULT 3 NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    circuit_open_until timestamp with time zone,
    last_started_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_recovery_policies_action_type_check CHECK ((action_type = ANY (ARRAY['resync_monitoring'::text, 'recheck_availability'::text]))),
    CONSTRAINT monitoring_recovery_policies_cooldown_minutes_check CHECK (((cooldown_minutes >= 1) AND (cooldown_minutes <= 1440))),
    CONSTRAINT monitoring_recovery_policies_failure_threshold_check CHECK (((failure_threshold >= 1) AND (failure_threshold <= 10))),
    CONSTRAINT monitoring_recovery_policies_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 5)))
);


--
-- Name: monitoring_restore_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_restore_tests (
    id bigint NOT NULL,
    backup_id text NOT NULL,
    tested_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    duration_seconds numeric(12,2) NOT NULL,
    checked_tables_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_restore_tests_checked_tables_count_check CHECK ((checked_tables_count >= 0)),
    CONSTRAINT monitoring_restore_tests_duration_seconds_check CHECK ((duration_seconds >= (0)::numeric)),
    CONSTRAINT monitoring_restore_tests_status_check CHECK ((status = ANY (ARRAY['passed'::text, 'failed'::text])))
);


--
-- Name: monitoring_restore_tests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monitoring_restore_tests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitoring_restore_tests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monitoring_restore_tests_id_seq OWNED BY public.monitoring_restore_tests.id;


--
-- Name: monitoring_sla_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_sla_policies (
    severity text NOT NULL,
    response_minutes integer NOT NULL,
    resolution_minutes integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_sla_policies_check CHECK ((resolution_minutes >= response_minutes)),
    CONSTRAINT monitoring_sla_policies_resolution_minutes_check CHECK ((resolution_minutes > 0)),
    CONSTRAINT monitoring_sla_policies_response_minutes_check CHECK ((response_minutes > 0)),
    CONSTRAINT monitoring_sla_policies_severity_check CHECK ((severity = ANY (ARRAY['warning'::text, 'critical'::text])))
);


--
-- Name: monitoring_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_snapshots (
    id bigint NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    overall_status text NOT NULL,
    problems_count integer DEFAULT 0 NOT NULL,
    components jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_snapshots_overall_status_check CHECK ((overall_status = ANY (ARRAY['healthy'::text, 'warning'::text, 'critical'::text, 'unknown'::text]))),
    CONSTRAINT monitoring_snapshots_problems_count_check CHECK ((problems_count >= 0))
);


--
-- Name: monitoring_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monitoring_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monitoring_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monitoring_snapshots_id_seq OWNED BY public.monitoring_snapshots.id;


--
-- Name: security_ip_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_ip_blocks (
    id bigint NOT NULL,
    ip_address inet NOT NULL,
    block_type text NOT NULL,
    reason text NOT NULL,
    blocked_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT security_ip_blocks_block_type_check CHECK ((block_type = ANY (ARRAY['automatic'::text, 'manual'::text]))),
    CONSTRAINT security_ip_blocks_check CHECK ((expires_at > blocked_at))
);


--
-- Name: security_active_blocks; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.security_active_blocks AS
 SELECT id,
    host(ip_address) AS ip_address,
    block_type,
    reason,
    blocked_at,
    expires_at,
    GREATEST((0)::numeric, ceil((EXTRACT(epoch FROM (expires_at - now())) / (60)::numeric))) AS remaining_minutes
   FROM public.security_ip_blocks
  WHERE ((revoked_at IS NULL) AND (expires_at > now()));


--
-- Name: security_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.security_alerts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: security_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.security_alerts_id_seq OWNED BY public.security_alerts.id;


--
-- Name: security_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_events (
    id bigint NOT NULL,
    event_type text NOT NULL,
    severity text NOT NULL,
    ip_address text,
    user_agent text,
    request_method text,
    request_path text,
    status_code integer,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_events_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])))
);


--
-- Name: security_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.security_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: security_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.security_events_id_seq OWNED BY public.security_events.id;


--
-- Name: security_ip_blocks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.security_ip_blocks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: security_ip_blocks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.security_ip_blocks_id_seq OWNED BY public.security_ip_blocks.id;


--
-- Name: security_protection_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_protection_events (
    id bigint NOT NULL,
    event_type text NOT NULL,
    ip_address inet NOT NULL,
    scope text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_protection_events_event_type_check CHECK ((event_type = ANY (ARRAY['rate_limit_exceeded'::text, 'automatic_block'::text, 'manual_block'::text, 'manual_unblock'::text])))
);


--
-- Name: security_protection_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.security_protection_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: security_protection_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.security_protection_events_id_seq OWNED BY public.security_protection_events.id;


--
-- Name: security_protection_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.security_protection_summary AS
 SELECT ( SELECT count(*) AS count
           FROM public.security_active_blocks) AS active_blocks,
    count(*) FILTER (WHERE (event_type = 'rate_limit_exceeded'::text)) AS rate_limit_exceeded,
    count(*) FILTER (WHERE (event_type = 'automatic_block'::text)) AS automatic_blocks,
    count(*) FILTER (WHERE (event_type = 'manual_block'::text)) AS manual_blocks,
    count(*) FILTER (WHERE (event_type = 'manual_unblock'::text)) AS manual_unblocks
   FROM public.security_protection_events
  WHERE (created_at >= (now() - '24:00:00'::interval));


--
-- Name: security_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_rate_limits (
    ip_address inet NOT NULL,
    scope text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    request_count bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: security_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.security_summary AS
 SELECT count(*) AS total_events,
    count(*) FILTER (WHERE (severity = 'warning'::text)) AS warning_events,
    count(*) FILTER (WHERE (severity = 'critical'::text)) AS critical_events,
    count(*) FILTER (WHERE (event_type = 'login_failed'::text)) AS failed_logins,
    count(*) FILTER (WHERE (event_type = 'unauthorized_access'::text)) AS unauthorized_requests,
    count(*) FILTER (WHERE (event_type = 'admin_action'::text)) AS admin_actions
   FROM public.security_events
  WHERE (created_at >= (now() - '24:00:00'::interval));


--
-- Name: monitoring_backup_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_backup_runs ALTER COLUMN id SET DEFAULT nextval('public.monitoring_backup_runs_id_seq'::regclass);


--
-- Name: monitoring_ci_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_ci_runs ALTER COLUMN id SET DEFAULT nextval('public.monitoring_ci_runs_id_seq'::regclass);


--
-- Name: monitoring_cloud_checks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_cloud_checks ALTER COLUMN id SET DEFAULT nextval('public.monitoring_cloud_checks_id_seq'::regclass);


--
-- Name: monitoring_cloud_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_cloud_notifications ALTER COLUMN id SET DEFAULT nextval('public.monitoring_cloud_notifications_id_seq'::regclass);


--
-- Name: monitoring_incident_escalations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_incident_escalations ALTER COLUMN id SET DEFAULT nextval('public.monitoring_incident_escalations_id_seq'::regclass);


--
-- Name: monitoring_incident_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_incident_events ALTER COLUMN id SET DEFAULT nextval('public.monitoring_incident_events_id_seq'::regclass);


--
-- Name: monitoring_incidents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_incidents ALTER COLUMN id SET DEFAULT nextval('public.monitoring_incidents_id_seq'::regclass);


--
-- Name: monitoring_recovery_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_recovery_events ALTER COLUMN id SET DEFAULT nextval('public.monitoring_recovery_events_id_seq'::regclass);


--
-- Name: monitoring_recovery_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_recovery_jobs ALTER COLUMN id SET DEFAULT nextval('public.monitoring_recovery_jobs_id_seq'::regclass);


--
-- Name: monitoring_restore_tests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_restore_tests ALTER COLUMN id SET DEFAULT nextval('public.monitoring_restore_tests_id_seq'::regclass);


--
-- Name: monitoring_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_snapshots ALTER COLUMN id SET DEFAULT nextval('public.monitoring_snapshots_id_seq'::regclass);


--
-- Name: security_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_alerts ALTER COLUMN id SET DEFAULT nextval('public.security_alerts_id_seq'::regclass);


--
-- Name: security_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_events ALTER COLUMN id SET DEFAULT nextval('public.security_events_id_seq'::regclass);


--
-- Name: security_ip_blocks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_ip_blocks ALTER COLUMN id SET DEFAULT nextval('public.security_ip_blocks_id_seq'::regclass);


--
-- Name: security_protection_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_protection_events ALTER COLUMN id SET DEFAULT nextval('public.security_protection_events_id_seq'::regclass);


--
-- Name: monitoring_backup_alert_state monitoring_backup_alert_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_backup_alert_state
    ADD CONSTRAINT monitoring_backup_alert_state_pkey PRIMARY KEY (id);


--
-- Name: monitoring_backup_runs monitoring_backup_runs_backup_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_backup_runs
    ADD CONSTRAINT monitoring_backup_runs_backup_id_key UNIQUE (backup_id);


--
-- Name: monitoring_backup_runs monitoring_backup_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_backup_runs
    ADD CONSTRAINT monitoring_backup_runs_pkey PRIMARY KEY (id);


--
-- Name: monitoring_ci_runs monitoring_ci_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_ci_runs
    ADD CONSTRAINT monitoring_ci_runs_pkey PRIMARY KEY (id);


--
-- Name: monitoring_ci_runs monitoring_ci_runs_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_ci_runs
    ADD CONSTRAINT monitoring_ci_runs_run_id_key UNIQUE (run_id);


--
-- Name: monitoring_cloud_alert_state monitoring_cloud_alert_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_cloud_alert_state
    ADD CONSTRAINT monitoring_cloud_alert_state_pkey PRIMARY KEY (id);


--
-- Name: monitoring_cloud_checks monitoring_cloud_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_cloud_checks
    ADD CONSTRAINT monitoring_cloud_checks_pkey PRIMARY KEY (id);


--
-- Name: monitoring_cloud_checks monitoring_cloud_checks_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_cloud_checks
    ADD CONSTRAINT monitoring_cloud_checks_run_id_key UNIQUE (run_id);


--
-- Name: monitoring_cloud_notifications monitoring_cloud_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_cloud_notifications
    ADD CONSTRAINT monitoring_cloud_notifications_pkey PRIMARY KEY (id);


--
-- Name: monitoring_cloud_notifications monitoring_cloud_notifications_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_cloud_notifications
    ADD CONSTRAINT monitoring_cloud_notifications_run_id_key UNIQUE (run_id);


--
-- Name: monitoring_heartbeats monitoring_heartbeats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_heartbeats
    ADD CONSTRAINT monitoring_heartbeats_pkey PRIMARY KEY (source);


--
-- Name: monitoring_incident_escalations monitoring_incident_escalations_incident_id_escalation_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_incident_escalations
    ADD CONSTRAINT monitoring_incident_escalations_incident_id_escalation_type_key UNIQUE (incident_id, escalation_type);


--
-- Name: monitoring_incident_escalations monitoring_incident_escalations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_incident_escalations
    ADD CONSTRAINT monitoring_incident_escalations_pkey PRIMARY KEY (id);


--
-- Name: monitoring_incident_events monitoring_incident_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_incident_events
    ADD CONSTRAINT monitoring_incident_events_pkey PRIMARY KEY (id);


--
-- Name: monitoring_incident_processing_state monitoring_incident_processing_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_incident_processing_state
    ADD CONSTRAINT monitoring_incident_processing_state_pkey PRIMARY KEY (id);


--
-- Name: monitoring_incidents monitoring_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_incidents
    ADD CONSTRAINT monitoring_incidents_pkey PRIMARY KEY (id);


--
-- Name: monitoring_recovery_events monitoring_recovery_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_recovery_events
    ADD CONSTRAINT monitoring_recovery_events_pkey PRIMARY KEY (id);


--
-- Name: monitoring_recovery_jobs monitoring_recovery_jobs_incident_id_action_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_recovery_jobs
    ADD CONSTRAINT monitoring_recovery_jobs_incident_id_action_type_key UNIQUE (incident_id, action_type);


--
-- Name: monitoring_recovery_jobs monitoring_recovery_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_recovery_jobs
    ADD CONSTRAINT monitoring_recovery_jobs_pkey PRIMARY KEY (id);


--
-- Name: monitoring_recovery_notifications monitoring_recovery_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_recovery_notifications
    ADD CONSTRAINT monitoring_recovery_notifications_pkey PRIMARY KEY (event_id);


--
-- Name: monitoring_recovery_policies monitoring_recovery_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_recovery_policies
    ADD CONSTRAINT monitoring_recovery_policies_pkey PRIMARY KEY (component);


--
-- Name: monitoring_restore_tests monitoring_restore_tests_backup_id_tested_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_restore_tests
    ADD CONSTRAINT monitoring_restore_tests_backup_id_tested_at_key UNIQUE (backup_id, tested_at);


--
-- Name: monitoring_restore_tests monitoring_restore_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_restore_tests
    ADD CONSTRAINT monitoring_restore_tests_pkey PRIMARY KEY (id);


--
-- Name: monitoring_sla_policies monitoring_sla_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_sla_policies
    ADD CONSTRAINT monitoring_sla_policies_pkey PRIMARY KEY (severity);


--
-- Name: monitoring_snapshots monitoring_snapshots_checked_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_snapshots
    ADD CONSTRAINT monitoring_snapshots_checked_at_key UNIQUE (checked_at);


--
-- Name: monitoring_snapshots monitoring_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_snapshots
    ADD CONSTRAINT monitoring_snapshots_pkey PRIMARY KEY (id);


--
-- Name: security_alerts security_alerts_alert_type_ip_address_window_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_alerts
    ADD CONSTRAINT security_alerts_alert_type_ip_address_window_start_key UNIQUE (alert_type, ip_address, window_start);


--
-- Name: security_alerts security_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_alerts
    ADD CONSTRAINT security_alerts_pkey PRIMARY KEY (id);


--
-- Name: security_events security_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_events
    ADD CONSTRAINT security_events_pkey PRIMARY KEY (id);


--
-- Name: security_ip_blocks security_ip_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_ip_blocks
    ADD CONSTRAINT security_ip_blocks_pkey PRIMARY KEY (id);


--
-- Name: security_protection_events security_protection_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_protection_events
    ADD CONSTRAINT security_protection_events_pkey PRIMARY KEY (id);


--
-- Name: security_rate_limits security_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_rate_limits
    ADD CONSTRAINT security_rate_limits_pkey PRIMARY KEY (ip_address, scope, window_start);


--
-- Name: idx_backup_runs_checked_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_backup_runs_checked_at ON public.monitoring_backup_runs USING btree (checked_at DESC);


--
-- Name: idx_backup_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_backup_runs_status ON public.monitoring_backup_runs USING btree (status, checked_at DESC);


--
-- Name: idx_ci_runs_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ci_runs_date ON public.monitoring_ci_runs USING btree (checked_at DESC);


--
-- Name: idx_ci_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ci_runs_status ON public.monitoring_ci_runs USING btree (status, checked_at DESC);


--
-- Name: idx_cloud_checks_checked_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_checks_checked_at ON public.monitoring_cloud_checks USING btree (checked_at DESC);


--
-- Name: idx_cloud_notifications_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_notifications_date ON public.monitoring_cloud_notifications USING btree (notified_at DESC);


--
-- Name: idx_escalations_notification_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_escalations_notification_queue ON public.monitoring_incident_escalations USING btree (notification_status, next_attempt_at, id);


--
-- Name: idx_incident_events_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incident_events_history ON public.monitoring_incident_events USING btree (incident_id, created_at DESC, id DESC);


--
-- Name: idx_monitoring_escalations_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_monitoring_escalations_pending ON public.monitoring_incident_escalations USING btree (notification_status, detected_at);


--
-- Name: idx_protection_events_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_protection_events_date ON public.security_protection_events USING btree (created_at DESC);


--
-- Name: idx_protection_events_ip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_protection_events_ip ON public.security_protection_events USING btree (ip_address, event_type, created_at DESC);


--
-- Name: idx_rate_limits_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_limits_updated ON public.security_rate_limits USING btree (updated_at);


--
-- Name: idx_recovery_events_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recovery_events_job ON public.monitoring_recovery_events USING btree (job_id, created_at DESC);


--
-- Name: idx_recovery_jobs_component; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recovery_jobs_component ON public.monitoring_recovery_jobs USING btree (component, status);


--
-- Name: idx_recovery_jobs_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recovery_jobs_queue ON public.monitoring_recovery_jobs USING btree (status, next_attempt_at, id);


--
-- Name: idx_recovery_notification_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recovery_notification_queue ON public.monitoring_recovery_notifications USING btree (status, next_attempt_at);


--
-- Name: idx_restore_tests_tested_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_restore_tests_tested_at ON public.monitoring_restore_tests USING btree (tested_at DESC);


--
-- Name: idx_security_alerts_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_security_alerts_created ON public.security_alerts USING btree (created_at DESC);


--
-- Name: idx_security_alerts_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_security_alerts_queue ON public.security_alerts USING btree (notification_status, next_attempt_at, id);


--
-- Name: idx_security_blocks_ip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_security_blocks_ip ON public.security_ip_blocks USING btree (ip_address, expires_at DESC) WHERE (revoked_at IS NULL);


--
-- Name: idx_security_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_security_events_created ON public.security_events USING btree (created_at DESC);


--
-- Name: idx_security_events_ip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_security_events_ip ON public.security_events USING btree (ip_address, created_at DESC);


--
-- Name: idx_security_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_security_events_type ON public.security_events USING btree (event_type, created_at DESC);


--
-- Name: monitoring_incidents_active_component_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX monitoring_incidents_active_component_idx ON public.monitoring_incidents USING btree (component) WHERE (status = ANY (ARRAY['open'::text, 'acknowledged'::text]));


--
-- Name: monitoring_incidents_opened_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX monitoring_incidents_opened_at_idx ON public.monitoring_incidents USING btree (opened_at DESC);


--
-- Name: monitoring_incidents_status_opened_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX monitoring_incidents_status_opened_idx ON public.monitoring_incidents USING btree (status, opened_at DESC);


--
-- Name: monitoring_incidents trg_assign_monitoring_incident_sla; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_assign_monitoring_incident_sla BEFORE INSERT ON public.monitoring_incidents FOR EACH ROW EXECUTE FUNCTION public.assign_monitoring_incident_sla();


--
-- Name: monitoring_incidents trg_monitoring_incident_events; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_monitoring_incident_events AFTER INSERT OR UPDATE ON public.monitoring_incidents FOR EACH ROW EXECUTE FUNCTION public.log_monitoring_incident_event();


--
-- Name: monitoring_recovery_jobs trg_recovery_job_event; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_recovery_job_event AFTER INSERT OR UPDATE ON public.monitoring_recovery_jobs FOR EACH ROW EXECUTE FUNCTION public.log_recovery_job_event();


--
-- Name: monitoring_incident_escalations monitoring_incident_escalations_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_incident_escalations
    ADD CONSTRAINT monitoring_incident_escalations_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.monitoring_incidents(id) ON DELETE RESTRICT;


--
-- Name: monitoring_incident_events monitoring_incident_events_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_incident_events
    ADD CONSTRAINT monitoring_incident_events_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.monitoring_incidents(id) ON DELETE RESTRICT;


--
-- Name: monitoring_recovery_events monitoring_recovery_events_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_recovery_events
    ADD CONSTRAINT monitoring_recovery_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.monitoring_recovery_jobs(id) ON DELETE RESTRICT;


--
-- Name: monitoring_recovery_jobs monitoring_recovery_jobs_component_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_recovery_jobs
    ADD CONSTRAINT monitoring_recovery_jobs_component_fkey FOREIGN KEY (component) REFERENCES public.monitoring_recovery_policies(component);


--
-- Name: monitoring_recovery_jobs monitoring_recovery_jobs_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_recovery_jobs
    ADD CONSTRAINT monitoring_recovery_jobs_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.monitoring_incidents(id) ON DELETE RESTRICT;


--
-- Name: monitoring_recovery_notifications monitoring_recovery_notifications_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_recovery_notifications
    ADD CONSTRAINT monitoring_recovery_notifications_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.monitoring_recovery_events(id);


--
-- PostgreSQL database dump complete
--

\unrestrict yqJYVyp9iGQfbwK4sIDQGRljzDZUkLkP0TuCTsT3xRvW5AnST79RXhg5stdKSUb

