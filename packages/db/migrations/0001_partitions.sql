-- Partitionnement mensuel de `match` et `match_participant`.
--
-- drizzle-kit ne sait pas générer de table partitionnée : cette migration est
-- écrite à la main et doit être appliquée AVANT toute insertion. La clé de
-- partition (game_creation) fait partie de la PK, d'où sa présence dans
-- match_participant alors qu'elle y est redondante.
--
-- Intérêt : détacher une saison passée est un ALTER TABLE ... DETACH instantané,
-- là où un DELETE sur des dizaines de millions de lignes bloquerait la table.

-- Crée les partitions manquantes pour les N prochains mois.
CREATE OR REPLACE FUNCTION laneform_ensure_partitions(months_ahead int DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  tbl text;
  start_date date;
  end_date date;
  part_name text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['match', 'match_participant'] LOOP
    FOR i IN -1..months_ahead LOOP
      start_date := date_trunc('month', CURRENT_DATE) + (i || ' month')::interval;
      end_date   := start_date + interval '1 month';
      part_name  := format('%s_p%s', tbl, to_char(start_date, 'YYYYMM'));

      IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
          part_name, tbl, start_date, end_date
        );
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

SELECT laneform_ensure_partitions(3);
