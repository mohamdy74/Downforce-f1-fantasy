-- DOWNFORCE — RLS verification (READ-ONLY, safe to run any time)
-- Run in Supabase SQL Editor on project xrvpwmarwncaaquywyce.
-- Expected end-state = drizzle/migrations 0000..0012 applied.
-- Paste the output of queries 1, 2 and 5 back to Vibe for analysis.

-- 1) RLS flag per table (rls_enabled must be true everywhere)
select c.relname as table_name,
       c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

-- 2) All policies (full dump)
select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 3) anon / authenticated table grants
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;

-- 4) Lock/audit triggers (expect: on_auth_user_created, predictions_lock_guard,
--    predictions_audit_log, sprint_predictions_lock_guard)
select event_object_table as table_name, trigger_name, event_manipulation
from information_schema.triggers
where trigger_schema = 'public'
order by event_object_table, trigger_name;

-- 5) Per-table verdict vs expected design
select t.tablename,
       c.relrowsecurity as rls_enabled,
       count(p.policyname) as policy_count,
       case t.tablename
         when 'races'           then 'public read'
         when 'drivers'          then 'public read'
         when 'race_results'     then 'public read'
         when 'sprint_results'   then 'public read'
         when 'predictions'      then 'own rows + locked race (race_at <= now)'
         when 'sprint_predictions' then 'own rows + locked sprint (sprint_at <= now)'
         when 'scores'           then 'own + after race start'
         when 'prediction_logs'  then 'own + 1h after race start'
         when 'profiles'         then 'signed-in read; own insert/update'
         when 'weekend_sessions' then 'signed-in read'
         when 'sync_state'       then 'server-only (no policies, anon revoked)'
         else 'REVIEW: unexpected table'
       end as expected,
       case
         when not c.relrowsecurity then 'FAIL: RLS disabled'
         when t.tablename = 'sync_state' and count(p.policyname) = 0 then 'OK'
         when count(p.policyname) = 0 then 'FAIL: RLS on but no policies (deny-all breaks app reads)'
         else 'check policies in query 2'
       end as verdict
from pg_tables t
join pg_class c on c.relname = t.tablename
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
left join pg_policies p on p.schemaname = t.schemaname and p.tablename = t.tablename
where t.schemaname = 'public' and c.relkind = 'r'
group by t.tablename, c.relrowsecurity
order by t.tablename;
