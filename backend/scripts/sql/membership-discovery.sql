-- ============================================================================
-- Multi-building memberships: discovery and data profile (DB-4)
--
-- READ-ONLY. Every statement is a SELECT, inside a read-only transaction that
-- ends with ROLLBACK. Running it against the shared staging database still
-- needs the database owner's approval first.
--
--   psql "$DATABASE_URL" -f scripts/sql/membership-discovery.sql
--
-- Share the output before migration 1775740000000-CreateGateMemberships runs
-- anywhere shared. The answers settle:
--   * the staff question (A6) and the backfill role list;
--   * inactive / pending rows that have a building (A2, status split);
--   * super admins that carry a building (A1);
--   * case-insensitive duplicate emails (one human, two rows);
--   * dangling tenant ids and orphan Keycloak links.
-- Each result set starts with a check_name column so the output reads on its own.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

-- C01 enum types behind gate_users.role / status (their names depend on how the
-- table was built; the migration copies through ::text for that reason)
SELECT 'C01 gate_users enum types' AS check_name,
       a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS type_name,
       (SELECT string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder)
          FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS labels
  FROM pg_attribute a
 WHERE a.attrelid = to_regclass('public.gate_users')
   AND a.attname IN ('role', 'status')
   AND NOT a.attisdropped
 ORDER BY a.attname;

-- C02 indexes on gate_users and building_join_requests
SELECT 'C02 indexes' AS check_name, tablename, indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename IN ('gate_users', 'building_join_requests')
 ORDER BY tablename, indexname;

-- C03 constraints on gate_users and building_join_requests
SELECT 'C03 constraints' AS check_name,
       c.conrelid::regclass AS table_name,
       c.conname,
       c.contype,
       pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
 WHERE c.conrelid IN (to_regclass('public.gate_users'), to_regclass('public.building_join_requests'))
 ORDER BY 2, 3;

-- C04 foreign keys that point at gate_users (they keep working: gate_users stays one row per person)
SELECT 'C04 FKs referencing gate_users' AS check_name,
       c.conrelid::regclass AS referencing_table,
       c.conname,
       pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
 WHERE c.contype = 'f'
   AND c.confrelid = to_regclass('public.gate_users')
 ORDER BY 2, 3;

-- C05 extensions the migrations rely on (uuid_generate_v4)
SELECT 'C05 extensions' AS check_name, extname, extversion
  FROM pg_extension
 WHERE extname IN ('uuid-ossp', 'pgcrypto')
 ORDER BY extname;

-- C06 views that read the legacy membership columns of gate_users
SELECT DISTINCT 'C06 dependent views' AS check_name,
       v.oid::regclass AS view_name,
       a.attname AS column_name
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid
  JOIN pg_class v ON v.oid = r.ev_class
  JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
 WHERE d.classid = 'pg_rewrite'::regclass
   AND d.refobjid = to_regclass('public.gate_users')
   AND v.oid <> d.refobjid
   AND a.attname IN ('tenant_id', 'role', 'unit', 'status')
 ORDER BY 2, 3;

-- C07 does gate_memberships already exist? (expected: NULL before the migration)
SELECT 'C07 gate_memberships present' AS check_name,
       to_regclass('public.gate_memberships') AS gate_memberships,
       to_regclass('public.migrations') AS migrations_table;

-- ---------------------------------------------------------------------------
-- Data profile
-- ---------------------------------------------------------------------------

-- D01 people by role, status and building state
SELECT 'D01 gate_users profile' AS check_name,
       u.role::text AS role,
       u.status::text AS status,
       (u.deleted_at IS NOT NULL) AS person_soft_deleted,
       CASE
         WHEN u.tenant_id IS NULL THEN 'no building'
         WHEN t.id IS NULL THEN 'dangling tenant_id'
         WHEN t.deleted_at IS NOT NULL THEN 'building soft-deleted'
         ELSE 'live building'
       END AS building_state,
       count(*) AS people
  FROM gate_users u
  LEFT JOIN tenants t ON t.id = u.tenant_id
 GROUP BY 2, 3, 4, 5
 ORDER BY 2, 3, 4, 5;

-- D02 what the backfill will produce (role list: building_admin, resident,
-- security, staff). Compare these counts with the migration's result.
SELECT 'D02 expected backfill' AS check_name,
       u.role::text AS role,
       u.status::text AS status,
       (t.deleted_at IS NOT NULL) AS becomes_ended_membership,
       count(*) AS memberships
  FROM gate_users u
  JOIN tenants t ON t.id = u.tenant_id
 WHERE u.deleted_at IS NULL
   AND u.tenant_id IS NOT NULL
   AND u.role::text IN ('building_admin', 'resident', 'security', 'staff')
 GROUP BY 2, 3, 4
 ORDER BY 2, 3, 4;

-- D03 staff rows (A6)
SELECT 'D03 staff rows' AS check_name,
       count(*) AS staff_rows,
       count(*) FILTER (WHERE u.tenant_id IS NOT NULL AND u.deleted_at IS NULL) AS live_with_building,
       count(*) FILTER (WHERE u.status::text <> 'active') AS not_active
  FROM gate_users u
 WHERE u.role::text = 'staff';

-- D04 super admins that carry a building (A1: they get no membership by default)
SELECT 'D04 super_admin with tenant' AS check_name,
       u.id, u.tenant_id, u.status::text AS status, (u.deleted_at IS NOT NULL) AS soft_deleted
  FROM gate_users u
 WHERE u.role::text = 'super_admin'
   AND u.tenant_id IS NOT NULL
 ORDER BY u.created_at;

-- D05 tenant ids with no tenants row (skipped by the backfill)
SELECT 'D05 dangling tenant_id' AS check_name,
       u.id, u.tenant_id, u.role::text AS role, (u.deleted_at IS NOT NULL) AS soft_deleted
  FROM gate_users u
 WHERE u.tenant_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = u.tenant_id)
 ORDER BY u.created_at;

-- D06 case-insensitive duplicate emails (one human, several rows?)
SELECT 'D06 duplicate emails' AS check_name,
       lower(u.email) AS email,
       count(*) AS rows_for_email,
       string_agg(u.id::text || ' ' || u.role::text || ' ' || coalesce(u.tenant_id::text, '-')
                  || CASE WHEN u.deleted_at IS NULL THEN '' ELSE ' (soft-deleted)' END,
                  '; ' ORDER BY u.created_at) AS rows_oldest_first
  FROM gate_users u
 GROUP BY lower(u.email)
HAVING count(*) > 1
 ORDER BY 2;

-- D07 people with more than one pending join request (expected 0 today)
SELECT 'D07 multiple pending requests' AS check_name,
       r.user_id, count(*) AS pending_requests
  FROM building_join_requests r
 WHERE r.status::text = 'pending'
   AND r.deleted_at IS NULL
 GROUP BY r.user_id
HAVING count(*) > 1;

-- D08 inactive or pending people who have a building (A2: building status or platform ban?)
SELECT 'D08 non-active with building' AS check_name,
       u.role::text AS role,
       u.status::text AS status,
       count(*) AS people
  FROM gate_users u
 WHERE u.tenant_id IS NOT NULL
   AND u.deleted_at IS NULL
   AND u.status::text <> 'active'
 GROUP BY 2, 3
 ORDER BY 2, 3;

-- D09 orphan links: gate_users.user_id (Keycloak sub) missing from the global
-- users mirror (table from migration 1775736200000)
SELECT 'D09 orphan gate_users.user_id' AS check_name,
       count(*) FILTER (WHERE u.user_id IS NOT NULL) AS linked_rows,
       count(*) FILTER (WHERE u.user_id IS NOT NULL
                          AND NOT EXISTS (SELECT 1 FROM users g WHERE g.id = u.user_id)) AS orphan_links
  FROM gate_users u;

-- D10 join requests whose person or building row is gone
SELECT 'D10 orphan join requests' AS check_name,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM gate_users u WHERE u.id = r.user_id)) AS missing_person,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = r.tenant_id)) AS missing_building
  FROM building_join_requests r;

-- ---------------------------------------------------------------------------
-- Migrations already applied (needs the TypeORM "migrations" table; C07 shows
-- whether it exists). Nothing at or above 1775740000000 should be listed yet.
-- ---------------------------------------------------------------------------
SELECT 'M01 applied migrations' AS check_name, id, "timestamp", name
  FROM migrations
 ORDER BY "timestamp";

SELECT 'M02 membership migrations already applied' AS check_name, count(*) AS applied
  FROM migrations
 WHERE "timestamp" >= 1775740000000;

ROLLBACK;
