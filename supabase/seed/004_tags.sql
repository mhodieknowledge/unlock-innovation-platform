-- Starter tags. DATA_MODEL.md §1 keeps skills, technologies, industries, themes
-- and roles in one lookup table keyed by `kind`, so all of these are row inserts
-- and the set grows without a migration.
--
-- Deliberately small. Extraction proposes new tags from real documents
-- (OPPORTUNITY_INGESTION.md §4.5) and an admin approves them; inventing a large
-- taxonomy up front would guess at a vocabulary we have not observed yet.

INSERT INTO tags (kind, code, name, slug, aliases) VALUES
  ('skill','software_engineering','Software engineering','software-engineering','{"programming","coding","swe"}'),
  ('skill','data_science','Data science','data-science','{"ds"}'),
  ('skill','machine_learning','Machine learning','machine-learning','{"ml"}'),
  ('skill','product_design','Product design','product-design','{"ux","ui","design"}'),
  ('skill','research','Research','research','{}'),
  ('skill','business_development','Business development','business-development','{"bizdev"}'),
  ('skill','data_analysis','Data analysis','data-analysis','{"analytics"}'),
  ('skill','devops','DevOps','devops','{"sre","infrastructure"}'),
  ('skill','mobile_development','Mobile development','mobile-development','{"android","ios"}'),
  ('skill','technical_writing','Technical writing','technical-writing','{}'),

  ('technology','python','Python','python','{}'),
  ('technology','javascript','JavaScript','javascript','{"js","typescript"}'),
  ('technology','react','React','react','{}'),
  ('technology','flutter','Flutter','flutter','{"dart"}'),
  ('technology','postgres','PostgreSQL','postgresql','{"postgres","sql"}'),
  ('technology','tensorflow','TensorFlow','tensorflow','{}'),
  ('technology','pytorch','PyTorch','pytorch','{}'),
  ('technology','android','Android','android','{"kotlin","java"}'),
  ('technology','figma','Figma','figma','{}'),
  ('technology','solidity','Solidity','solidity','{}'),

  ('industry','agriculture','Agriculture','agriculture','{"agritech","farming"}'),
  ('industry','health','Health','health','{"healthtech","medical"}'),
  ('industry','education','Education','education','{"edtech"}'),
  ('industry','fintech','Financial services','financial-services','{"fintech","payments"}'),
  ('industry','energy','Energy','energy','{"cleantech","solar"}'),
  ('industry','climate','Climate','climate','{"environment","sustainability"}'),
  ('industry','logistics','Logistics','logistics','{"transport","mobility"}'),
  ('industry','governance','Governance','governance','{"civictech","government"}'),
  ('industry','water_sanitation','Water and sanitation','water-and-sanitation','{"wash"}'),
  ('industry','creative','Creative industries','creative-industries','{"media","arts"}'),

  ('theme','open_data','Open data','open-data','{}'),
  ('theme','financial_inclusion','Financial inclusion','financial-inclusion','{}'),
  ('theme','women_in_tech','Women in tech','women-in-tech','{}'),
  ('theme','youth_employment','Youth employment','youth-employment','{}'),

  -- Roles power the team-formation surfaces (TEAM_FORMATION.md §2.1,
  -- roles_offered and roles_needed). Complementarity is computed from these and
  -- nothing else -- we never score people against each other (§6).
  ('role','backend','Backend','backend','{"server","api"}'),
  ('role','frontend','Frontend','frontend','{"ui engineer"}'),
  ('role','fullstack','Full-stack','full-stack','{}'),
  ('role','designer','Designer','designer','{"ux","ui"}'),
  ('role','data','Data','data','{"data scientist","analyst"}'),
  ('role','ml_engineer','ML engineer','ml-engineer','{}'),
  ('role','mobile','Mobile','mobile','{}'),
  ('role','product','Product','product','{"pm"}'),
  ('role','business','Business','business','{"commercial"}'),
  ('role','domain_expert','Domain expert','domain-expert','{"subject matter expert"}')
ON CONFLICT (kind, code) DO NOTHING;
