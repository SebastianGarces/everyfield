CREATE TABLE "private_calendar" (
	"author_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"zone" text NOT NULL,
	"next_at" timestamp with time zone NOT NULL,
	"preview_id" uuid,
	"preview_revision" bigint,
	CONSTRAINT "private_calendar_pkey" PRIMARY KEY("author_id","plant_id"),
	CONSTRAINT "private_calendar_ck_0" CHECK ((revision >= 1)),
	CONSTRAINT "private_calendar_zone_iana" CHECK ((zone = ANY (ARRAY['Africa/Abidjan'::text, 'Africa/Accra'::text, 'Africa/Addis_Ababa'::text, 'Africa/Algiers'::text, 'Africa/Asmera'::text, 'Africa/Bamako'::text, 'Africa/Bangui'::text, 'Africa/Banjul'::text, 'Africa/Bissau'::text, 'Africa/Blantyre'::text, 'Africa/Brazzaville'::text, 'Africa/Bujumbura'::text, 'Africa/Cairo'::text, 'Africa/Casablanca'::text, 'Africa/Ceuta'::text, 'Africa/Conakry'::text, 'Africa/Dakar'::text, 'Africa/Dar_es_Salaam'::text, 'Africa/Djibouti'::text, 'Africa/Douala'::text, 'Africa/El_Aaiun'::text, 'Africa/Freetown'::text, 'Africa/Gaborone'::text, 'Africa/Harare'::text, 'Africa/Johannesburg'::text, 'Africa/Juba'::text, 'Africa/Kampala'::text, 'Africa/Khartoum'::text, 'Africa/Kigali'::text, 'Africa/Kinshasa'::text, 'Africa/Lagos'::text, 'Africa/Libreville'::text, 'Africa/Lome'::text, 'Africa/Luanda'::text, 'Africa/Lubumbashi'::text, 'Africa/Lusaka'::text, 'Africa/Malabo'::text, 'Africa/Maputo'::text, 'Africa/Maseru'::text, 'Africa/Mbabane'::text, 'Africa/Mogadishu'::text, 'Africa/Monrovia'::text, 'Africa/Nairobi'::text, 'Africa/Ndjamena'::text, 'Africa/Niamey'::text, 'Africa/Nouakchott'::text, 'Africa/Ouagadougou'::text, 'Africa/Porto-Novo'::text, 'Africa/Sao_Tome'::text, 'Africa/Tripoli'::text, 'Africa/Tunis'::text, 'Africa/Windhoek'::text, 'America/Adak'::text, 'America/Anchorage'::text, 'America/Anguilla'::text, 'America/Antigua'::text, 'America/Araguaina'::text, 'America/Argentina/La_Rioja'::text, 'America/Argentina/Rio_Gallegos'::text, 'America/Argentina/Salta'::text, 'America/Argentina/San_Juan'::text, 'America/Argentina/San_Luis'::text, 'America/Argentina/Tucuman'::text, 'America/Argentina/Ushuaia'::text, 'America/Aruba'::text, 'America/Asuncion'::text, 'America/Bahia'::text, 'America/Bahia_Banderas'::text, 'America/Barbados'::text, 'America/Belem'::text, 'America/Belize'::text, 'America/Blanc-Sablon'::text, 'America/Boa_Vista'::text, 'America/Bogota'::text, 'America/Boise'::text, 'America/Buenos_Aires'::text, 'America/Cambridge_Bay'::text, 'America/Campo_Grande'::text, 'America/Cancun'::text, 'America/Caracas'::text, 'America/Catamarca'::text, 'America/Cayenne'::text, 'America/Cayman'::text, 'America/Chicago'::text, 'America/Chihuahua'::text, 'America/Ciudad_Juarez'::text, 'America/Coral_Harbour'::text, 'America/Cordoba'::text, 'America/Costa_Rica'::text, 'America/Coyhaique'::text, 'America/Creston'::text, 'America/Cuiaba'::text, 'America/Curacao'::text, 'America/Danmarkshavn'::text, 'America/Dawson'::text, 'America/Dawson_Creek'::text, 'America/Denver'::text, 'America/Detroit'::text, 'America/Dominica'::text, 'America/Edmonton'::text, 'America/Eirunepe'::text, 'America/El_Salvador'::text, 'America/Fort_Nelson'::text, 'America/Fortaleza'::text, 'America/Glace_Bay'::text, 'America/Godthab'::text, 'America/Goose_Bay'::text, 'America/Grand_Turk'::text, 'America/Grenada'::text, 'America/Guadeloupe'::text, 'America/Guatemala'::text, 'America/Guayaquil'::text, 'America/Guyana'::text, 'America/Halifax'::text, 'America/Havana'::text, 'America/Hermosillo'::text, 'America/Indiana/Knox'::text, 'America/Indiana/Marengo'::text, 'America/Indiana/Petersburg'::text, 'America/Indiana/Tell_City'::text, 'America/Indiana/Vevay'::text, 'America/Indiana/Vincennes'::text, 'America/Indiana/Winamac'::text, 'America/Indianapolis'::text, 'America/Inuvik'::text, 'America/Iqaluit'::text, 'America/Jamaica'::text, 'America/Jujuy'::text, 'America/Juneau'::text, 'America/Kentucky/Monticello'::text, 'America/Kralendijk'::text, 'America/La_Paz'::text, 'America/Lima'::text, 'America/Los_Angeles'::text, 'America/Louisville'::text, 'America/Lower_Princes'::text, 'America/Maceio'::text, 'America/Managua'::text, 'America/Manaus'::text, 'America/Marigot'::text, 'America/Martinique'::text, 'America/Matamoros'::text, 'America/Mazatlan'::text, 'America/Mendoza'::text, 'America/Menominee'::text, 'America/Merida'::text, 'America/Metlakatla'::text, 'America/Mexico_City'::text, 'America/Miquelon'::text, 'America/Moncton'::text, 'America/Monterrey'::text, 'America/Montevideo'::text, 'America/Montserrat'::text, 'America/Nassau'::text, 'America/New_York'::text, 'America/Nome'::text, 'America/Noronha'::text, 'America/North_Dakota/Beulah'::text, 'America/North_Dakota/Center'::text, 'America/North_Dakota/New_Salem'::text, 'America/Ojinaga'::text, 'America/Panama'::text, 'America/Paramaribo'::text, 'America/Phoenix'::text, 'America/Port-au-Prince'::text, 'America/Port_of_Spain'::text, 'America/Porto_Velho'::text, 'America/Puerto_Rico'::text, 'America/Punta_Arenas'::text, 'America/Rankin_Inlet'::text, 'America/Recife'::text, 'America/Regina'::text, 'America/Resolute'::text, 'America/Rio_Branco'::text, 'America/Santarem'::text, 'America/Santiago'::text, 'America/Santo_Domingo'::text, 'America/Sao_Paulo'::text, 'America/Scoresbysund'::text, 'America/Sitka'::text, 'America/St_Barthelemy'::text, 'America/St_Johns'::text, 'America/St_Kitts'::text, 'America/St_Lucia'::text, 'America/St_Thomas'::text, 'America/St_Vincent'::text, 'America/Swift_Current'::text, 'America/Tegucigalpa'::text, 'America/Thule'::text, 'America/Tijuana'::text, 'America/Toronto'::text, 'America/Tortola'::text, 'America/Vancouver'::text, 'America/Whitehorse'::text, 'America/Winnipeg'::text, 'America/Yakutat'::text, 'Antarctica/Casey'::text, 'Antarctica/Davis'::text, 'Antarctica/DumontDUrville'::text, 'Antarctica/Macquarie'::text, 'Antarctica/Mawson'::text, 'Antarctica/McMurdo'::text, 'Antarctica/Palmer'::text, 'Antarctica/Rothera'::text, 'Antarctica/Syowa'::text, 'Antarctica/Troll'::text, 'Antarctica/Vostok'::text, 'Arctic/Longyearbyen'::text, 'Asia/Aden'::text, 'Asia/Almaty'::text, 'Asia/Amman'::text, 'Asia/Anadyr'::text, 'Asia/Aqtau'::text, 'Asia/Aqtobe'::text, 'Asia/Ashgabat'::text, 'Asia/Atyrau'::text, 'Asia/Baghdad'::text, 'Asia/Bahrain'::text, 'Asia/Baku'::text, 'Asia/Bangkok'::text, 'Asia/Barnaul'::text, 'Asia/Beirut'::text, 'Asia/Bishkek'::text, 'Asia/Brunei'::text, 'Asia/Calcutta'::text, 'Asia/Chita'::text, 'Asia/Colombo'::text, 'Asia/Damascus'::text, 'Asia/Dhaka'::text, 'Asia/Dili'::text, 'Asia/Dubai'::text, 'Asia/Dushanbe'::text, 'Asia/Famagusta'::text, 'Asia/Gaza'::text, 'Asia/Hebron'::text, 'Asia/Hong_Kong'::text, 'Asia/Hovd'::text, 'Asia/Irkutsk'::text, 'Asia/Jakarta'::text, 'Asia/Jayapura'::text, 'Asia/Jerusalem'::text, 'Asia/Kabul'::text, 'Asia/Kamchatka'::text, 'Asia/Karachi'::text, 'Asia/Katmandu'::text, 'Asia/Khandyga'::text, 'Asia/Krasnoyarsk'::text, 'Asia/Kuala_Lumpur'::text, 'Asia/Kuching'::text, 'Asia/Kuwait'::text, 'Asia/Macau'::text, 'Asia/Magadan'::text, 'Asia/Makassar'::text, 'Asia/Manila'::text, 'Asia/Muscat'::text, 'Asia/Nicosia'::text, 'Asia/Novokuznetsk'::text, 'Asia/Novosibirsk'::text, 'Asia/Omsk'::text, 'Asia/Oral'::text, 'Asia/Phnom_Penh'::text, 'Asia/Pontianak'::text, 'Asia/Pyongyang'::text, 'Asia/Qatar'::text, 'Asia/Qostanay'::text, 'Asia/Qyzylorda'::text, 'Asia/Rangoon'::text, 'Asia/Riyadh'::text, 'Asia/Saigon'::text, 'Asia/Sakhalin'::text, 'Asia/Samarkand'::text, 'Asia/Seoul'::text, 'Asia/Shanghai'::text, 'Asia/Singapore'::text, 'Asia/Srednekolymsk'::text, 'Asia/Taipei'::text, 'Asia/Tashkent'::text, 'Asia/Tbilisi'::text, 'Asia/Tehran'::text, 'Asia/Thimphu'::text, 'Asia/Tokyo'::text, 'Asia/Tomsk'::text, 'Asia/Ulaanbaatar'::text, 'Asia/Urumqi'::text, 'Asia/Ust-Nera'::text, 'Asia/Vientiane'::text, 'Asia/Vladivostok'::text, 'Asia/Yakutsk'::text, 'Asia/Yekaterinburg'::text, 'Asia/Yerevan'::text, 'Atlantic/Azores'::text, 'Atlantic/Bermuda'::text, 'Atlantic/Canary'::text, 'Atlantic/Cape_Verde'::text, 'Atlantic/Faeroe'::text, 'Atlantic/Madeira'::text, 'Atlantic/Reykjavik'::text, 'Atlantic/South_Georgia'::text, 'Atlantic/St_Helena'::text, 'Atlantic/Stanley'::text, 'Australia/Adelaide'::text, 'Australia/Brisbane'::text, 'Australia/Broken_Hill'::text, 'Australia/Darwin'::text, 'Australia/Eucla'::text, 'Australia/Hobart'::text, 'Australia/Lindeman'::text, 'Australia/Lord_Howe'::text, 'Australia/Melbourne'::text, 'Australia/Perth'::text, 'Australia/Sydney'::text, 'Europe/Amsterdam'::text, 'Europe/Andorra'::text, 'Europe/Astrakhan'::text, 'Europe/Athens'::text, 'Europe/Belgrade'::text, 'Europe/Berlin'::text, 'Europe/Bratislava'::text, 'Europe/Brussels'::text, 'Europe/Bucharest'::text, 'Europe/Budapest'::text, 'Europe/Busingen'::text, 'Europe/Chisinau'::text, 'Europe/Copenhagen'::text, 'Europe/Dublin'::text, 'Europe/Gibraltar'::text, 'Europe/Guernsey'::text, 'Europe/Helsinki'::text, 'Europe/Isle_of_Man'::text, 'Europe/Istanbul'::text, 'Europe/Jersey'::text, 'Europe/Kaliningrad'::text, 'Europe/Kiev'::text, 'Europe/Kirov'::text, 'Europe/Lisbon'::text, 'Europe/Ljubljana'::text, 'Europe/London'::text, 'Europe/Luxembourg'::text, 'Europe/Madrid'::text, 'Europe/Malta'::text, 'Europe/Mariehamn'::text, 'Europe/Minsk'::text, 'Europe/Monaco'::text, 'Europe/Moscow'::text, 'Europe/Oslo'::text, 'Europe/Paris'::text, 'Europe/Podgorica'::text, 'Europe/Prague'::text, 'Europe/Riga'::text, 'Europe/Rome'::text, 'Europe/Samara'::text, 'Europe/San_Marino'::text, 'Europe/Sarajevo'::text, 'Europe/Saratov'::text, 'Europe/Simferopol'::text, 'Europe/Skopje'::text, 'Europe/Sofia'::text, 'Europe/Stockholm'::text, 'Europe/Tallinn'::text, 'Europe/Tirane'::text, 'Europe/Ulyanovsk'::text, 'Europe/Vaduz'::text, 'Europe/Vatican'::text, 'Europe/Vienna'::text, 'Europe/Vilnius'::text, 'Europe/Volgograd'::text, 'Europe/Warsaw'::text, 'Europe/Zagreb'::text, 'Europe/Zurich'::text, 'Indian/Antananarivo'::text, 'Indian/Chagos'::text, 'Indian/Christmas'::text, 'Indian/Cocos'::text, 'Indian/Comoro'::text, 'Indian/Kerguelen'::text, 'Indian/Mahe'::text, 'Indian/Maldives'::text, 'Indian/Mauritius'::text, 'Indian/Mayotte'::text, 'Indian/Reunion'::text, 'Pacific/Apia'::text, 'Pacific/Auckland'::text, 'Pacific/Bougainville'::text, 'Pacific/Chatham'::text, 'Pacific/Easter'::text, 'Pacific/Efate'::text, 'Pacific/Enderbury'::text, 'Pacific/Fakaofo'::text, 'Pacific/Fiji'::text, 'Pacific/Funafuti'::text, 'Pacific/Galapagos'::text, 'Pacific/Gambier'::text, 'Pacific/Guadalcanal'::text, 'Pacific/Guam'::text, 'Pacific/Honolulu'::text, 'Pacific/Kiritimati'::text, 'Pacific/Kosrae'::text, 'Pacific/Kwajalein'::text, 'Pacific/Majuro'::text, 'Pacific/Marquesas'::text, 'Pacific/Midway'::text, 'Pacific/Nauru'::text, 'Pacific/Niue'::text, 'Pacific/Norfolk'::text, 'Pacific/Noumea'::text, 'Pacific/Pago_Pago'::text, 'Pacific/Palau'::text, 'Pacific/Pitcairn'::text, 'Pacific/Ponape'::text, 'Pacific/Port_Moresby'::text, 'Pacific/Rarotonga'::text, 'Pacific/Saipan'::text, 'Pacific/Tahiti'::text, 'Pacific/Tarawa'::text, 'Pacific/Tongatapu'::text, 'Pacific/Truk'::text, 'Pacific/Wake'::text, 'Pacific/Wallis'::text, 'UTC'::text]))),
	CONSTRAINT "private_calendar_preview" CHECK (((preview_id IS NULL) = (preview_revision IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "private_week" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"plant_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"zone" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"spiritual" text,
	"family" text,
	"financial" text,
	"pace" text,
	"note" text,
	"answer_revision" integer DEFAULT 0 NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "private_week_pkey" PRIMARY KEY("id"),
	CONSTRAINT "private_week_uq_0" UNIQUE("author_id","plant_id","ordinal"),
	CONSTRAINT "private_week_uq_1" UNIQUE("id","author_id"),
	CONSTRAINT "private_week_ck_0" CHECK ((ordinal >= 1)),
	CONSTRAINT "private_week_ck_1" CHECK ((ends_on = (starts_on + 6))),
	CONSTRAINT "private_week_ck_2" CHECK ((EXTRACT(isodow FROM starts_on) = (1)::numeric)),
	CONSTRAINT "private_week_answer" CHECK (((answer_revision = 0) = (spiritual IS NULL)) AND (num_nulls(spiritual, family, financial, pace) = ANY (ARRAY[0, 4])) AND ((answer_revision = 0) = (answered_at IS NULL)) AND ((note IS NULL) OR (spiritual IS NOT NULL))),
	CONSTRAINT "private_week_levels" CHECK (((spiritual IS NULL) OR ((spiritual = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text])) AND (family = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text])) AND (financial = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text])) AND (pace = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text]))))),
	CONSTRAINT "private_week_note" CHECK (((note IS NULL) OR ((char_length(note) >= 1) AND (char_length(note) <= 2000)))),
	CONSTRAINT "private_week_ck_3" CHECK ((answer_revision >= 0))
);
--> statement-breakpoint
CREATE TABLE "private_week_revision" (
	"week_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"spiritual" text NOT NULL,
	"family" text NOT NULL,
	"financial" text NOT NULL,
	"pace" text NOT NULL,
	"note" text,
	"calendar_revision" bigint NOT NULL,
	"request_key" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "private_week_revision_pkey" PRIMARY KEY("week_id","revision"),
	CONSTRAINT "private_week_revision_uq_0" UNIQUE("author_id","request_key"),
	CONSTRAINT "private_week_revision_ck_0" CHECK ((revision >= 1)),
	CONSTRAINT "private_week_revision_ck_1" CHECK ((kind = ANY (ARRAY['save'::text, 'correction'::text]))),
	CONSTRAINT "private_week_revision_levels" CHECK (((spiritual = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text])) AND (family = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text])) AND (financial = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text])) AND (pace = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text])))),
	CONSTRAINT "private_week_revision_note" CHECK (((note IS NULL) OR ((char_length(note) >= 1) AND (char_length(note) <= 2000)))),
	CONSTRAINT "private_week_revision_ck_2" CHECK (((char_length(request_key) >= 1) AND (char_length(request_key) <= 200)))
);
--> statement-breakpoint
ALTER TABLE "private_calendar" ADD CONSTRAINT "private_calendar_fk_0" FOREIGN KEY ("author_id") REFERENCES "account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_calendar" ADD CONSTRAINT "private_calendar_fk_1" FOREIGN KEY ("plant_id") REFERENCES "plant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_week" ADD CONSTRAINT "private_week_fk_0" FOREIGN KEY ("author_id","plant_id") REFERENCES "private_calendar"("author_id","plant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_week_revision" ADD CONSTRAINT "private_week_revision_fk_0" FOREIGN KEY ("week_id","author_id") REFERENCES "private_week"("id","author_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "private_calendar_ref_1" ON "private_calendar" USING btree ("plant_id");--> statement-breakpoint
CREATE INDEX "private_week_revision_ref_0" ON "private_week_revision" USING btree ("week_id","author_id");--> statement-breakpoint
-- A check-in keeps its author, church, ordinal, zone and dates, and a revision never changes (SCHEMA-007).
CREATE TRIGGER immutable_calendar BEFORE UPDATE ON "private_calendar" FOR EACH ROW EXECUTE FUNCTION freeze_fields('author_id,plant_id');
--> statement-breakpoint
CREATE TRIGGER immutable_week BEFORE UPDATE ON "private_week" FOR EACH ROW EXECUTE FUNCTION freeze_fields('id,author_id,plant_id,ordinal,zone,starts_on,ends_on,starts_at');
--> statement-breakpoint
CREATE TRIGGER immutable_revision BEFORE UPDATE ON "private_week_revision" FOR EACH ROW EXECUTE FUNCTION freeze_fields('week_id,author_id,revision,kind,spiritual,family,financial,pace,note,calendar_revision,request_key,recorded_at');
--> statement-breakpoint
-- The Monday weeks in `zone` that start from `next_at` up to `at`, numbered from 1: none while next_at is ahead.
CREATE FUNCTION private_due_weeks(zone text, next_at timestamptz, at timestamptz)
RETURNS TABLE(n integer, starts_on date, starts_at timestamptz)
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
 SELECT k+1, w.d, (w.d::timestamp AT TIME ZONE zone)
 FROM (SELECT (next_at AT TIME ZONE zone)::date AS first) f
 CROSS JOIN LATERAL generate_series(0, ((at AT TIME ZONE zone)::date - f.first) / 7) k
 CROSS JOIN LATERAL (SELECT f.first + 7*k AS d) w
 WHERE next_at <= at
$$;
--> statement-breakpoint
-- The runtime appends and edits check-ins but never deletes one: deletion is only the account or church purge.
GRANT SELECT,INSERT,UPDATE ON "private_calendar","private_week" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,INSERT ON "private_week_revision" TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,DELETE ON "private_calendar","private_week","private_week_revision" TO everyfield_cleanup;
--> statement-breakpoint
-- Account purge removes the author's private care in every church, and church purge removes every author's private
-- care there. The weeks and revisions cascade. Nothing counts or names them.
DO $patch$
DECLARE def text; patched text;
BEGIN
 def := pg_get_functiondef('settings_purge_content(uuid,uuid,bigint)'::regprocedure);
 patched := replace(def, E' DELETE FROM conversation WHERE tenant_id=s OR (w.kind=\'account\' AND account_id=s);\n', E' DELETE FROM conversation WHERE tenant_id=s OR (w.kind=\'account\' AND account_id=s);\n DELETE FROM private_calendar WHERE plant_id=s OR (w.kind=\'account\' AND author_id=s);\n');
 IF patched = def THEN
  RAISE EXCEPTION 'settings_purge_content patch did not apply';
 END IF;
 EXECUTE patched;
END
$patch$;
