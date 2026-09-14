-- All 54 African countries, plus the non-African rows the eligibility model
-- needs for diaspora and global-scope calls.
--
-- PRODUCT_SPEC.md §4.2: tiering affects content seeding and promotion ONLY,
-- never eligibility logic or the data model. All 54 are first-class from day one.
-- PRODUCT_SPEC.md §28: ISO 3166-1 alpha-2; never display "Africa" as a single
-- origin or destination in any eligibility context.
--
-- Regions follow the five subregions named in PRODUCT_SPEC.md §28 (Northern,
-- Western, Central, Eastern, Southern). Note this is a geographic grouping and
-- is independent of priority_tier: Zimbabwe, Zambia, Malawi and Mozambique are
-- Eastern Africa geographically while being Tier-1 launch markets.

INSERT INTO countries (iso2, iso3, name, region, is_african, slug, priority_tier, timezone_default, common_names) VALUES
-- Tier 1 — launch focus (CONTENT_AND_LAUNCH.md §2)
('ZW','ZWE','Zimbabwe','eastern_africa',true,'zimbabwe',1,'Africa/Harare','{}'),
('ZM','ZMB','Zambia','eastern_africa',true,'zambia',1,'Africa/Lusaka','{}'),
('BW','BWA','Botswana','southern_africa',true,'botswana',1,'Africa/Gaborone','{}'),
('NA','NAM','Namibia','southern_africa',true,'namibia',1,'Africa/Windhoek','{}'),
('MW','MWI','Malawi','eastern_africa',true,'malawi',1,'Africa/Blantyre','{}'),
('MZ','MOZ','Mozambique','eastern_africa',true,'mozambique',1,'Africa/Maputo','{}'),
-- Tier 2
('GH','GHA','Ghana','western_africa',true,'ghana',2,'Africa/Accra','{}'),
('KE','KEN','Kenya','eastern_africa',true,'kenya',2,'Africa/Nairobi','{}'),
('NG','NGA','Nigeria','western_africa',true,'nigeria',2,'Africa/Lagos','{}'),
('RW','RWA','Rwanda','eastern_africa',true,'rwanda',2,'Africa/Kigali','{}'),
('UG','UGA','Uganda','eastern_africa',true,'uganda',2,'Africa/Kampala','{}'),
('TZ','TZA','Tanzania','eastern_africa',true,'tanzania',2,'Africa/Dar_es_Salaam','{"United Republic of Tanzania"}'),
('ZA','ZAF','South Africa','southern_africa',true,'south-africa',2,'Africa/Johannesburg','{"RSA"}'),
-- Tier 3 — the remainder of the 54
('DZ','DZA','Algeria','northern_africa',true,'algeria',3,'Africa/Algiers','{}'),
('AO','AGO','Angola','central_africa',true,'angola',3,'Africa/Luanda','{}'),
('BJ','BEN','Benin','western_africa',true,'benin',3,'Africa/Porto-Novo','{}'),
('BF','BFA','Burkina Faso','western_africa',true,'burkina-faso',3,'Africa/Ouagadougou','{}'),
('BI','BDI','Burundi','eastern_africa',true,'burundi',3,'Africa/Bujumbura','{}'),
('CV','CPV','Cabo Verde','western_africa',true,'cabo-verde',3,'Atlantic/Cape_Verde','{"Cape Verde"}'),
('CM','CMR','Cameroon','central_africa',true,'cameroon',3,'Africa/Douala','{}'),
('CF','CAF','Central African Republic','central_africa',true,'central-african-republic',3,'Africa/Bangui','{"CAR"}'),
('TD','TCD','Chad','central_africa',true,'chad',3,'Africa/Ndjamena','{}'),
('KM','COM','Comoros','eastern_africa',true,'comoros',3,'Indian/Comoro','{}'),
('CG','COG','Congo','central_africa',true,'congo',3,'Africa/Brazzaville','{"Republic of the Congo","Congo-Brazzaville"}'),
('CD','COD','Democratic Republic of the Congo','central_africa',true,'democratic-republic-of-the-congo',3,'Africa/Kinshasa','{"DR Congo","DRC","Congo-Kinshasa"}'),
('CI','CIV','Côte d''Ivoire','western_africa',true,'cote-divoire',3,'Africa/Abidjan','{"Ivory Coast"}'),
('DJ','DJI','Djibouti','eastern_africa',true,'djibouti',3,'Africa/Djibouti','{}'),
('EG','EGY','Egypt','northern_africa',true,'egypt',3,'Africa/Cairo','{}'),
('GQ','GNQ','Equatorial Guinea','central_africa',true,'equatorial-guinea',3,'Africa/Malabo','{}'),
('ER','ERI','Eritrea','eastern_africa',true,'eritrea',3,'Africa/Asmara','{}'),
('SZ','SWZ','Eswatini','southern_africa',true,'eswatini',3,'Africa/Mbabane','{"Swaziland"}'),
('ET','ETH','Ethiopia','eastern_africa',true,'ethiopia',3,'Africa/Addis_Ababa','{}'),
('GA','GAB','Gabon','central_africa',true,'gabon',3,'Africa/Libreville','{}'),
('GM','GMB','Gambia','western_africa',true,'gambia',3,'Africa/Banjul','{"The Gambia"}'),
('GN','GIN','Guinea','western_africa',true,'guinea',3,'Africa/Conakry','{}'),
('GW','GNB','Guinea-Bissau','western_africa',true,'guinea-bissau',3,'Africa/Bissau','{}'),
('LS','LSO','Lesotho','southern_africa',true,'lesotho',3,'Africa/Maseru','{}'),
('LR','LBR','Liberia','western_africa',true,'liberia',3,'Africa/Monrovia','{}'),
('LY','LBY','Libya','northern_africa',true,'libya',3,'Africa/Tripoli','{}'),
('MG','MDG','Madagascar','eastern_africa',true,'madagascar',3,'Indian/Antananarivo','{}'),
('ML','MLI','Mali','western_africa',true,'mali',3,'Africa/Bamako','{}'),
('MR','MRT','Mauritania','western_africa',true,'mauritania',3,'Africa/Nouakchott','{}'),
('MU','MUS','Mauritius','eastern_africa',true,'mauritius',3,'Indian/Mauritius','{}'),
('MA','MAR','Morocco','northern_africa',true,'morocco',3,'Africa/Casablanca','{}'),
('NE','NER','Niger','western_africa',true,'niger',3,'Africa/Niamey','{}'),
('ST','STP','São Tomé and Príncipe','central_africa',true,'sao-tome-and-principe',3,'Africa/Sao_Tome','{"Sao Tome and Principe"}'),
('SN','SEN','Senegal','western_africa',true,'senegal',3,'Africa/Dakar','{}'),
('SC','SYC','Seychelles','eastern_africa',true,'seychelles',3,'Indian/Mahe','{}'),
('SL','SLE','Sierra Leone','western_africa',true,'sierra-leone',3,'Africa/Freetown','{}'),
('SO','SOM','Somalia','eastern_africa',true,'somalia',3,'Africa/Mogadishu','{}'),
('SS','SSD','South Sudan','eastern_africa',true,'south-sudan',3,'Africa/Juba','{}'),
('SD','SDN','Sudan','northern_africa',true,'sudan',3,'Africa/Khartoum','{}'),
('TG','TGO','Togo','western_africa',true,'togo',3,'Africa/Lome','{}'),
('TN','TUN','Tunisia','northern_africa',true,'tunisia',3,'Africa/Tunis','{}'),
-- Non-African rows. Needed because eligibility scope can be `global`, and
-- because diaspora applicants hold non-African residency or nationality
-- (PRODUCT_SPEC.md §4.2). Not an exhaustive world list; extended by row insert
-- as real records require it.
('GB','GBR','United Kingdom','non_africa',false,'united-kingdom',3,'Europe/London','{"UK","Britain"}'),
('US','USA','United States','non_africa',false,'united-states',3,'America/New_York','{"USA","US"}'),
('CA','CAN','Canada','non_africa',false,'canada',3,'America/Toronto','{}'),
('FR','FRA','France','non_africa',false,'france',3,'Europe/Paris','{}'),
('DE','DEU','Germany','non_africa',false,'germany',3,'Europe/Berlin','{}'),
('IN','IND','India','non_africa',false,'india',3,'Asia/Kolkata','{}'),
('AE','ARE','United Arab Emirates','non_africa',false,'united-arab-emirates',3,'Asia/Dubai','{"UAE"}')
ON CONFLICT (iso2) DO NOTHING;
