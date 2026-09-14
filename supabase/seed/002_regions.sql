-- Regions. PRODUCT_SPEC.md §28: the five African subregions plus africa_wide,
-- global and remote_accessible.
--
-- `member_countries` is populated from `countries` rather than hand-listed, so
-- the two can never drift. AI_SYSTEM.md §5 relies on this: "country_in lists are
-- expanded from region words using our own regions table, never the model's
-- country list."

INSERT INTO regions (code, name, slug, is_african, sort_order, member_countries) VALUES
  ('northern_africa', 'Northern Africa', 'northern-africa', true, 10, '{}'),
  ('western_africa',  'Western Africa',  'western-africa',  true, 20, '{}'),
  ('central_africa',  'Central Africa',  'central-africa',  true, 30, '{}'),
  ('eastern_africa',  'Eastern Africa',  'eastern-africa',  true, 40, '{}'),
  ('southern_africa', 'Southern Africa', 'southern-africa', true, 50, '{}'),
  ('africa_wide',     'Africa-wide',     'africa-wide',     true, 60, '{}'),
  ('global',          'Global',          'global',          false, 70, '{}'),
  ('remote_accessible','Remote accessible','remote-accessible', false, 80, '{}')
ON CONFLICT (code) DO NOTHING;

-- The five subregions take their members from the countries table.
UPDATE regions r
   SET member_countries = sub.members
  FROM (
    SELECT region, array_agg(iso2 ORDER BY iso2)::char(2)[] AS members
      FROM countries
     WHERE is_african
     GROUP BY region
  ) AS sub
 WHERE r.code = sub.region;

-- africa_wide is every African country. This is the expansion used whenever a
-- source says "open to Africa", which AI_SYSTEM.md §5 requires be read as
-- country_in over all 54 rather than as `global`.
UPDATE regions
   SET member_countries = (
     SELECT array_agg(iso2 ORDER BY iso2)::char(2)[] FROM countries WHERE is_african
   )
 WHERE code = 'africa_wide';
