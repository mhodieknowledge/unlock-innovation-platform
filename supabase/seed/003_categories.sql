-- The opportunity taxonomy. PRODUCT_SPEC.md §11.1, verbatim and complete.
--
-- "Adding a category must require no code change" [PR]. These are rows in a
-- lookup table; the UI renders whatever is active and never hard-codes the set.

INSERT INTO categories (code, name, slug, sort_order, description) VALUES
  ('hackathon',                'Hackathon',                'hackathons',                 10, 'Time-boxed build events, usually team-based, usually with a submission and judging.'),
  ('coding_competition',       'Coding competition',       'coding-competitions',         20, 'Algorithmic or software contests scored on correctness or performance.'),
  ('ai_challenge',             'AI challenge',             'ai-challenges',               30, 'Challenges centred on machine learning or AI systems.'),
  ('data_competition',         'Data competition',         'data-competitions',           40, 'Prediction and analysis contests scored on a held-out dataset.'),
  ('innovation_challenge',     'Innovation challenge',     'innovation-challenges',       50, 'Open calls for solutions to a stated problem, often sector-specific.'),
  ('startup_competition',      'Startup competition',      'startup-competitions',        60, 'Contests for existing ventures, usually with funding attached.'),
  ('pitch_competition',        'Pitch competition',        'pitch-competitions',          70, 'Presentation-led contests judged on a pitch.'),
  ('grant',                    'Grant',                    'grants',                      80, 'Non-repayable funding awarded against an application.'),
  ('fellowship',               'Fellowship',               'fellowships',                 90, 'Funded programmes combining stipend, mentorship and cohort.'),
  ('scholarship',              'Scholarship',              'scholarships',               100, 'Funding for study, tuition or training.'),
  ('internship',              'Internship',                'internships',                110, 'Fixed-term work placements, paid or unpaid.'),
  ('accelerator',              'Accelerator',              'accelerators',               120, 'Cohort programmes for ventures, typically with investment.'),
  ('incubator',                'Incubator',                'incubators',                 130, 'Early-stage venture support, typically pre-investment.'),
  ('bootcamp',                 'Bootcamp',                 'bootcamps',                  140, 'Intensive training programmes.'),
  ('developer_program',        'Developer programme',      'developer-programmes',       150, 'Vendor or community programmes for developers.'),
  ('research_opportunity',     'Research opportunity',     'research-opportunities',     160, 'Research positions, funding and calls for papers with a research output.'),
  ('open_source_program',      'Open source programme',    'open-source-programmes',     170, 'Structured open-source contribution programmes and labelled issues ingested via API.'),
  ('entrepreneurship_program', 'Entrepreneurship programme','entrepreneurship-programmes',180, 'Training and support for founders, without an investment component.'),
  ('conference_cfp',           'Conference call for papers','conference-calls-for-papers',190, 'Speaker and paper submission calls.'),
  ('community_challenge',      'Community challenge',      'community-challenges',       200, 'Local or chapter-run challenges, including university and GDG events.'),
  ('other',                    'Other',                    'other',                      999, 'Does not fit the taxonomy. Reviewed periodically; a recurring pattern earns its own category.')
ON CONFLICT (code) DO NOTHING;
