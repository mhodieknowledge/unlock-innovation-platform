-- Restores the registry as it stood before the launch pass: the home-page URLs, the
-- sources that were switched off, and the three that were switched on.
--
-- This puts back a state that was measured not to work — thirteen sources reading
-- navigation menus — so it exists to make the deploy reversible, not because anyone
-- should want it.
UPDATE sources SET url = 'https://www.tonyelumelufoundation.org/', etag = NULL, last_modified = NULL
 WHERE name = 'Tony Elumelu Foundation';
UPDATE sources SET url = 'https://mastercardfdn.org/', etag = NULL, last_modified = NULL
 WHERE name = 'Mastercard Foundation';
UPDATE sources SET url = 'https://injini.co.za/', etag = NULL, last_modified = NULL
 WHERE name = 'Injini';
UPDATE sources SET url = 'https://africabusinessheroes.org/', etag = NULL, last_modified = NULL
 WHERE name = 'Africa''s Business Heroes';
UPDATE sources SET url = 'https://meltwater.org/', etag = NULL, last_modified = NULL
 WHERE name = 'MEST Africa';
UPDATE sources SET url = 'https://scholarshipregion.com/feed/', etag = NULL, last_modified = NULL
 WHERE name = 'Scholarship Region';

-- Only re-activate what robots still permits: the CHECK constraint refuses anything
-- else, and a down migration must not be the thing that fails a rollback.
UPDATE sources SET is_active = true
 WHERE name IN ('University of Zimbabwe — research and innovation',
                'University of Zambia — opportunities',
                'University of Botswana — opportunities',
                'University of Namibia — opportunities',
                'CcHUB', 'She Code Africa', 'GDG chapter events', 'Kaggle competitions')
   AND robots_allowed IS TRUE AND robots_checked_at IS NOT NULL;

UPDATE sources SET is_active = false
 WHERE name IN ('Devpost hackathons', 'Youth Opportunities Hub', 'Opportunities For Youth');
