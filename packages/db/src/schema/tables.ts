// Explicit schema authority. The frozen SQL is the baseline; evolve these declarations with Kit.
import {
	pgTable,
	text,
	uuid,
	integer,
	boolean,
	jsonb,
	inet,
	timestamp,
	date,
	time,
	numeric,
	customType,
	primaryKey,
	unique,
	foreignKey,
	index,
	uniqueIndex,
	check,
	type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
const int64 = customType<{ data: string; driverData: string }>({ dataType: () => "bigint" });
const vector = customType<{ data: string; driverData: string }>({ dataType: () => "vector" });
const canonicalZones7 = sql`ARRAY['Africa/Abidjan'::text, 'Africa/Accra'::text, 'Africa/Addis_Ababa'::text, 'Africa/Algiers'::text, 'Africa/Asmera'::text, 'Africa/Bamako'::text, 'Africa/Bangui'::text, 'Africa/Banjul'::text, 'Africa/Bissau'::text, 'Africa/Blantyre'::text, 'Africa/Brazzaville'::text, 'Africa/Bujumbura'::text, 'Africa/Cairo'::text, 'Africa/Casablanca'::text, 'Africa/Ceuta'::text, 'Africa/Conakry'::text, 'Africa/Dakar'::text, 'Africa/Dar_es_Salaam'::text, 'Africa/Djibouti'::text, 'Africa/Douala'::text, 'Africa/El_Aaiun'::text, 'Africa/Freetown'::text, 'Africa/Gaborone'::text, 'Africa/Harare'::text, 'Africa/Johannesburg'::text, 'Africa/Juba'::text, 'Africa/Kampala'::text, 'Africa/Khartoum'::text, 'Africa/Kigali'::text, 'Africa/Kinshasa'::text, 'Africa/Lagos'::text, 'Africa/Libreville'::text, 'Africa/Lome'::text, 'Africa/Luanda'::text, 'Africa/Lubumbashi'::text, 'Africa/Lusaka'::text, 'Africa/Malabo'::text, 'Africa/Maputo'::text, 'Africa/Maseru'::text, 'Africa/Mbabane'::text, 'Africa/Mogadishu'::text, 'Africa/Monrovia'::text, 'Africa/Nairobi'::text, 'Africa/Ndjamena'::text, 'Africa/Niamey'::text, 'Africa/Nouakchott'::text, 'Africa/Ouagadougou'::text, 'Africa/Porto-Novo'::text, 'Africa/Sao_Tome'::text, 'Africa/Tripoli'::text, 'Africa/Tunis'::text, 'Africa/Windhoek'::text, 'America/Adak'::text, 'America/Anchorage'::text, 'America/Anguilla'::text, 'America/Antigua'::text, 'America/Araguaina'::text, 'America/Argentina/La_Rioja'::text, 'America/Argentina/Rio_Gallegos'::text, 'America/Argentina/Salta'::text, 'America/Argentina/San_Juan'::text, 'America/Argentina/San_Luis'::text, 'America/Argentina/Tucuman'::text, 'America/Argentina/Ushuaia'::text, 'America/Aruba'::text, 'America/Asuncion'::text, 'America/Bahia'::text, 'America/Bahia_Banderas'::text, 'America/Barbados'::text, 'America/Belem'::text, 'America/Belize'::text, 'America/Blanc-Sablon'::text, 'America/Boa_Vista'::text, 'America/Bogota'::text, 'America/Boise'::text, 'America/Buenos_Aires'::text, 'America/Cambridge_Bay'::text, 'America/Campo_Grande'::text, 'America/Cancun'::text, 'America/Caracas'::text, 'America/Catamarca'::text, 'America/Cayenne'::text, 'America/Cayman'::text, 'America/Chicago'::text, 'America/Chihuahua'::text, 'America/Ciudad_Juarez'::text, 'America/Coral_Harbour'::text, 'America/Cordoba'::text, 'America/Costa_Rica'::text, 'America/Coyhaique'::text, 'America/Creston'::text, 'America/Cuiaba'::text, 'America/Curacao'::text, 'America/Danmarkshavn'::text, 'America/Dawson'::text, 'America/Dawson_Creek'::text, 'America/Denver'::text, 'America/Detroit'::text, 'America/Dominica'::text, 'America/Edmonton'::text, 'America/Eirunepe'::text, 'America/El_Salvador'::text, 'America/Fort_Nelson'::text, 'America/Fortaleza'::text, 'America/Glace_Bay'::text, 'America/Godthab'::text, 'America/Goose_Bay'::text, 'America/Grand_Turk'::text, 'America/Grenada'::text, 'America/Guadeloupe'::text, 'America/Guatemala'::text, 'America/Guayaquil'::text, 'America/Guyana'::text, 'America/Halifax'::text, 'America/Havana'::text, 'America/Hermosillo'::text, 'America/Indiana/Knox'::text, 'America/Indiana/Marengo'::text, 'America/Indiana/Petersburg'::text, 'America/Indiana/Tell_City'::text, 'America/Indiana/Vevay'::text, 'America/Indiana/Vincennes'::text, 'America/Indiana/Winamac'::text, 'America/Indianapolis'::text, 'America/Inuvik'::text, 'America/Iqaluit'::text, 'America/Jamaica'::text, 'America/Jujuy'::text, 'America/Juneau'::text, 'America/Kentucky/Monticello'::text, 'America/Kralendijk'::text, 'America/La_Paz'::text, 'America/Lima'::text, 'America/Los_Angeles'::text, 'America/Louisville'::text, 'America/Lower_Princes'::text, 'America/Maceio'::text, 'America/Managua'::text, 'America/Manaus'::text, 'America/Marigot'::text, 'America/Martinique'::text, 'America/Matamoros'::text, 'America/Mazatlan'::text, 'America/Mendoza'::text, 'America/Menominee'::text, 'America/Merida'::text, 'America/Metlakatla'::text, 'America/Mexico_City'::text, 'America/Miquelon'::text, 'America/Moncton'::text, 'America/Monterrey'::text, 'America/Montevideo'::text, 'America/Montserrat'::text, 'America/Nassau'::text, 'America/New_York'::text, 'America/Nome'::text, 'America/Noronha'::text, 'America/North_Dakota/Beulah'::text, 'America/North_Dakota/Center'::text, 'America/North_Dakota/New_Salem'::text, 'America/Ojinaga'::text, 'America/Panama'::text, 'America/Paramaribo'::text, 'America/Phoenix'::text, 'America/Port-au-Prince'::text, 'America/Port_of_Spain'::text, 'America/Porto_Velho'::text, 'America/Puerto_Rico'::text, 'America/Punta_Arenas'::text, 'America/Rankin_Inlet'::text, 'America/Recife'::text, 'America/Regina'::text, 'America/Resolute'::text, 'America/Rio_Branco'::text, 'America/Santarem'::text, 'America/Santiago'::text, 'America/Santo_Domingo'::text, 'America/Sao_Paulo'::text, 'America/Scoresbysund'::text, 'America/Sitka'::text, 'America/St_Barthelemy'::text, 'America/St_Johns'::text, 'America/St_Kitts'::text, 'America/St_Lucia'::text, 'America/St_Thomas'::text, 'America/St_Vincent'::text, 'America/Swift_Current'::text, 'America/Tegucigalpa'::text, 'America/Thule'::text, 'America/Tijuana'::text, 'America/Toronto'::text, 'America/Tortola'::text, 'America/Vancouver'::text, 'America/Whitehorse'::text, 'America/Winnipeg'::text, 'America/Yakutat'::text, 'Antarctica/Casey'::text, 'Antarctica/Davis'::text, 'Antarctica/DumontDUrville'::text, 'Antarctica/Macquarie'::text, 'Antarctica/Mawson'::text, 'Antarctica/McMurdo'::text, 'Antarctica/Palmer'::text, 'Antarctica/Rothera'::text, 'Antarctica/Syowa'::text, 'Antarctica/Troll'::text, 'Antarctica/Vostok'::text, 'Arctic/Longyearbyen'::text, 'Asia/Aden'::text, 'Asia/Almaty'::text, 'Asia/Amman'::text, 'Asia/Anadyr'::text, 'Asia/Aqtau'::text, 'Asia/Aqtobe'::text, 'Asia/Ashgabat'::text, 'Asia/Atyrau'::text, 'Asia/Baghdad'::text, 'Asia/Bahrain'::text, 'Asia/Baku'::text, 'Asia/Bangkok'::text, 'Asia/Barnaul'::text, 'Asia/Beirut'::text, 'Asia/Bishkek'::text, 'Asia/Brunei'::text, 'Asia/Calcutta'::text, 'Asia/Chita'::text, 'Asia/Colombo'::text, 'Asia/Damascus'::text, 'Asia/Dhaka'::text, 'Asia/Dili'::text, 'Asia/Dubai'::text, 'Asia/Dushanbe'::text, 'Asia/Famagusta'::text, 'Asia/Gaza'::text, 'Asia/Hebron'::text, 'Asia/Hong_Kong'::text, 'Asia/Hovd'::text, 'Asia/Irkutsk'::text, 'Asia/Jakarta'::text, 'Asia/Jayapura'::text, 'Asia/Jerusalem'::text, 'Asia/Kabul'::text, 'Asia/Kamchatka'::text, 'Asia/Karachi'::text, 'Asia/Katmandu'::text, 'Asia/Khandyga'::text, 'Asia/Krasnoyarsk'::text, 'Asia/Kuala_Lumpur'::text, 'Asia/Kuching'::text, 'Asia/Kuwait'::text, 'Asia/Macau'::text, 'Asia/Magadan'::text, 'Asia/Makassar'::text, 'Asia/Manila'::text, 'Asia/Muscat'::text, 'Asia/Nicosia'::text, 'Asia/Novokuznetsk'::text, 'Asia/Novosibirsk'::text, 'Asia/Omsk'::text, 'Asia/Oral'::text, 'Asia/Phnom_Penh'::text, 'Asia/Pontianak'::text, 'Asia/Pyongyang'::text, 'Asia/Qatar'::text, 'Asia/Qostanay'::text, 'Asia/Qyzylorda'::text, 'Asia/Rangoon'::text, 'Asia/Riyadh'::text, 'Asia/Saigon'::text, 'Asia/Sakhalin'::text, 'Asia/Samarkand'::text, 'Asia/Seoul'::text, 'Asia/Shanghai'::text, 'Asia/Singapore'::text, 'Asia/Srednekolymsk'::text, 'Asia/Taipei'::text, 'Asia/Tashkent'::text, 'Asia/Tbilisi'::text, 'Asia/Tehran'::text, 'Asia/Thimphu'::text, 'Asia/Tokyo'::text, 'Asia/Tomsk'::text, 'Asia/Ulaanbaatar'::text, 'Asia/Urumqi'::text, 'Asia/Ust-Nera'::text, 'Asia/Vientiane'::text, 'Asia/Vladivostok'::text, 'Asia/Yakutsk'::text, 'Asia/Yekaterinburg'::text, 'Asia/Yerevan'::text, 'Atlantic/Azores'::text, 'Atlantic/Bermuda'::text, 'Atlantic/Canary'::text, 'Atlantic/Cape_Verde'::text, 'Atlantic/Faeroe'::text, 'Atlantic/Madeira'::text, 'Atlantic/Reykjavik'::text, 'Atlantic/South_Georgia'::text, 'Atlantic/St_Helena'::text, 'Atlantic/Stanley'::text, 'Australia/Adelaide'::text, 'Australia/Brisbane'::text, 'Australia/Broken_Hill'::text, 'Australia/Darwin'::text, 'Australia/Eucla'::text, 'Australia/Hobart'::text, 'Australia/Lindeman'::text, 'Australia/Lord_Howe'::text, 'Australia/Melbourne'::text, 'Australia/Perth'::text, 'Australia/Sydney'::text, 'Europe/Amsterdam'::text, 'Europe/Andorra'::text, 'Europe/Astrakhan'::text, 'Europe/Athens'::text, 'Europe/Belgrade'::text, 'Europe/Berlin'::text, 'Europe/Bratislava'::text, 'Europe/Brussels'::text, 'Europe/Bucharest'::text, 'Europe/Budapest'::text, 'Europe/Busingen'::text, 'Europe/Chisinau'::text, 'Europe/Copenhagen'::text, 'Europe/Dublin'::text, 'Europe/Gibraltar'::text, 'Europe/Guernsey'::text, 'Europe/Helsinki'::text, 'Europe/Isle_of_Man'::text, 'Europe/Istanbul'::text, 'Europe/Jersey'::text, 'Europe/Kaliningrad'::text, 'Europe/Kiev'::text, 'Europe/Kirov'::text, 'Europe/Lisbon'::text, 'Europe/Ljubljana'::text, 'Europe/London'::text, 'Europe/Luxembourg'::text, 'Europe/Madrid'::text, 'Europe/Malta'::text, 'Europe/Mariehamn'::text, 'Europe/Minsk'::text, 'Europe/Monaco'::text, 'Europe/Moscow'::text, 'Europe/Oslo'::text, 'Europe/Paris'::text, 'Europe/Podgorica'::text, 'Europe/Prague'::text, 'Europe/Riga'::text, 'Europe/Rome'::text, 'Europe/Samara'::text, 'Europe/San_Marino'::text, 'Europe/Sarajevo'::text, 'Europe/Saratov'::text, 'Europe/Simferopol'::text, 'Europe/Skopje'::text, 'Europe/Sofia'::text, 'Europe/Stockholm'::text, 'Europe/Tallinn'::text, 'Europe/Tirane'::text, 'Europe/Ulyanovsk'::text, 'Europe/Vaduz'::text, 'Europe/Vatican'::text, 'Europe/Vienna'::text, 'Europe/Vilnius'::text, 'Europe/Volgograd'::text, 'Europe/Warsaw'::text, 'Europe/Zagreb'::text, 'Europe/Zurich'::text, 'Indian/Antananarivo'::text, 'Indian/Chagos'::text, 'Indian/Christmas'::text, 'Indian/Cocos'::text, 'Indian/Comoro'::text, 'Indian/Kerguelen'::text, 'Indian/Mahe'::text, 'Indian/Maldives'::text, 'Indian/Mauritius'::text, 'Indian/Mayotte'::text, 'Indian/Reunion'::text, 'Pacific/Apia'::text, 'Pacific/Auckland'::text, 'Pacific/Bougainville'::text, 'Pacific/Chatham'::text, 'Pacific/Easter'::text, 'Pacific/Efate'::text, 'Pacific/Enderbury'::text, 'Pacific/Fakaofo'::text, 'Pacific/Fiji'::text, 'Pacific/Funafuti'::text, 'Pacific/Galapagos'::text, 'Pacific/Gambier'::text, 'Pacific/Guadalcanal'::text, 'Pacific/Guam'::text, 'Pacific/Honolulu'::text, 'Pacific/Kiritimati'::text, 'Pacific/Kosrae'::text, 'Pacific/Kwajalein'::text, 'Pacific/Majuro'::text, 'Pacific/Marquesas'::text, 'Pacific/Midway'::text, 'Pacific/Nauru'::text, 'Pacific/Niue'::text, 'Pacific/Norfolk'::text, 'Pacific/Noumea'::text, 'Pacific/Pago_Pago'::text, 'Pacific/Palau'::text, 'Pacific/Pitcairn'::text, 'Pacific/Ponape'::text, 'Pacific/Port_Moresby'::text, 'Pacific/Rarotonga'::text, 'Pacific/Saipan'::text, 'Pacific/Tahiti'::text, 'Pacific/Tarawa'::text, 'Pacific/Tongatapu'::text, 'Pacific/Truk'::text, 'Pacific/Wake'::text, 'Pacific/Wallis'::text, 'UTC'::text]`;
export const account = pgTable(
	"account",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		auth_user_id: uuid("auth_user_id").notNull(),
		registration_state: text("registration_state", { enum: ["pending_domain", "active"] }).notNull(),
		registration_kind: text("registration_kind", {
			enum: ["planter", "sending_church", "network", "discovery"],
		}).notNull(),
		registration_digest: text("registration_digest"),
		personal_timezone: text("personal_timezone"),
		avatar_object_id: uuid("avatar_object_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
		personal_timezone_revision: int64("personal_timezone_revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "account_fk_0", columns: [table.auth_user_id], foreignColumns: [auth_user.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "account_fk_1",
			columns: [table.avatar_object_id, table.id],
			foreignColumns: [file_object.id, file_object.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "account_fk_2", columns: [table.id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "account_fk_3", columns: [table.id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "account_pkey", columns: [table.id] }),
		unique("account_uq_0").on(table.auth_user_id),
		check("account_ck_0", sql`(revision >= 1)`),
		check("account_ck_1", sql`(registration_state = ANY (ARRAY['pending_domain'::text, 'active'::text]))`),
		check(
			"account_ck_2",
			sql`(registration_kind = ANY (ARRAY['planter'::text, 'sending_church'::text, 'network'::text, 'discovery'::text]))`,
		),
		check("account_ck_3", sql`(id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		check("account_personal_timezone_iana", sql`(personal_timezone = ANY (${canonicalZones7}))`),
		index("account_ref_1").using("btree", table.avatar_object_id.asc().nullsLast(), table.id.asc().nullsLast()),
	],
);
export const admission_attempt = pgTable(
	"admission_attempt",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		kind: text("kind", {
			enum: ["login", "password_change", "registration", "reset", "email_change", "seat_invite", "relationship_invite"],
		}).notNull(),
		identifier_hash: text("identifier_hash"),
		trusted_ip_hash: text("trusted_ip_hash"),
		workspace_key: text("workspace_key"),
		reserved_at: timestamp("reserved_at", { withTimezone: true, mode: "date" }).notNull(),
		state: text("state", { enum: ["reserved", "failed", "counted", "cleared"] }).notNull(),
		expires_at: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		primaryKey({ name: "admission_attempt_pkey", columns: [table.id] }),
		check(
			"admission_attempt_ck_0",
			sql`(kind = ANY (ARRAY['login'::text, 'password_change'::text, 'registration'::text, 'reset'::text, 'email_change'::text, 'seat_invite'::text, 'relationship_invite'::text]))`,
		),
		check(
			"admission_attempt_ck_1",
			sql`(state = ANY (ARRAY['reserved'::text, 'failed'::text, 'counted'::text, 'cleared'::text]))`,
		),
		check("admission_attempt_ck_2", sql`(num_nonnulls(identifier_hash, trusted_ip_hash, workspace_key) >= 1)`),
		check("admission_attempt_ck_3", sql`(expires_at > reserved_at)`),
	],
);
export const affiliation = pgTable(
	"affiliation",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id"),
		account_id: uuid("account_id"),
		sending_church_id: uuid("sending_church_id"),
		organization_id: uuid("organization_id").notNull(),
		accepted_at: timestamp("accepted_at", { withTimezone: true, mode: "date" }).notNull(),
		ended_at: timestamp("ended_at", { withTimezone: true, mode: "date" }),
		invitation_id: uuid("invitation_id"),
		recognition_operation_id: uuid("recognition_operation_id"),
		share_people: boolean("share_people").notNull(),
		share_meetings: boolean("share_meetings").notNull(),
		share_tasks: boolean("share_tasks").notNull(),
		share_ministry_teams: boolean("share_ministry_teams").notNull(),
		share_wiki: boolean("share_wiki").notNull(),
		share_activity: boolean("share_activity").notNull(),
		shared_findings: boolean("shared_findings").notNull(),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
		consent_revision: int64("consent_revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "affiliation_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "affiliation_fk_1", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "affiliation_fk_2", columns: [table.sending_church_id], foreignColumns: [organization.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "affiliation_fk_3", columns: [table.organization_id], foreignColumns: [organization.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "affiliation_fk_4", columns: [table.invitation_id], foreignColumns: [invitation.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "affiliation_fk_5",
			columns: [table.recognition_operation_id],
			foreignColumns: [audit_event.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "affiliation_fk_6", columns: [table.id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "affiliation_pkey", columns: [table.id] }),
		unique("affiliation_uq_0").on(table.plant_id, table.organization_id),
		unique("affiliation_uq_1").on(table.account_id, table.organization_id),
		unique("affiliation_uq_2").on(table.sending_church_id, table.organization_id),
		check("affiliation_ck_0", sql`(revision >= 1)`),
		check("affiliation_ck_1", sql`(num_nonnulls(plant_id, account_id, sending_church_id) = 1)`),
		check(
			"affiliation_ck_2",
			sql`((plant_id IS NOT NULL) OR (NOT (share_people OR share_meetings OR share_tasks OR share_ministry_teams OR share_wiki OR share_activity OR shared_findings)))`,
		),
		check("affiliation_consent_revision_check", sql`(consent_revision >= 1)`),
		index("affiliation_ref_3").using("btree", table.organization_id.asc().nullsLast()),
		index("affiliation_ref_4").using("btree", table.invitation_id.asc().nullsLast()),
		index("affiliation_ref_5").using("btree", table.recognition_operation_id.asc().nullsLast()),
	],
);
export const article_editor_state = pgTable(
	"article_editor_state",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		organization_id: uuid("organization_id").notNull(),
		article_id: uuid("article_id").notNull(),
		state: text("state", { enum: ["inherited", "published", "hide", "draft"] }).notNull(),
		current_revision_id: uuid("current_revision_id"),
		draft_revision_id: uuid("draft_revision_id"),
		based_on_upstream_id: uuid("based_on_upstream_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "article_editor_state_fk_0",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "article_editor_state_fk_1", columns: [table.article_id], foreignColumns: [reference_item.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "article_editor_state_fk_2",
			columns: [table.current_revision_id, table.organization_id],
			foreignColumns: [article_revision.id, article_revision.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "article_editor_state_fk_3",
			columns: [table.draft_revision_id, table.organization_id],
			foreignColumns: [article_revision.id, article_revision.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "article_editor_state_fk_4",
			columns: [table.based_on_upstream_id],
			foreignColumns: [article_revision.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "article_editor_state_fk_5",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "article_editor_state_pkey", columns: [table.id] }),
		unique("article_editor_state_uq_0").on(table.id, table.organization_id),
		unique("article_editor_state_uq_1").on(table.organization_id, table.article_id),
		check("article_editor_state_ck_0", sql`(revision >= 1)`),
		check(
			"article_editor_state_ck_1",
			sql`(state = ANY (ARRAY['inherited'::text, 'published'::text, 'hide'::text, 'draft'::text]))`,
		),
		index("article_editor_state_ref_1").using("btree", table.article_id.asc().nullsLast()),
		index("article_editor_state_ref_2").using(
			"btree",
			table.current_revision_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("article_editor_state_ref_3").using(
			"btree",
			table.draft_revision_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("article_editor_state_ref_4").using("btree", table.based_on_upstream_id.asc().nullsLast()),
	],
);
export const article_link = pgTable(
	"article_link",
	{
		revision_id: uuid("revision_id").notNull(),
		target_article_id: uuid("target_article_id").notNull(),
		route_pattern: text("route_pattern"),
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		kind: text("kind", { enum: ["related", "guide"] }).notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "article_link_fk_0", columns: [table.revision_id], foreignColumns: [article_revision.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "article_link_fk_1", columns: [table.target_article_id], foreignColumns: [reference_item.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "article_link_pkey", columns: [table.id] }),
		check("article_link_ck_0", sql`(kind = ANY (ARRAY['related'::text, 'guide'::text]))`),
		check("article_link_ck_1", sql`((kind = 'guide'::text) = (route_pattern IS NOT NULL))`),
		index("article_link_ref_1").using("btree", table.target_article_id.asc().nullsLast()),
		uniqueIndex("article_link_uq_0")
			.using("btree", table.revision_id.asc().nullsLast(), table.target_article_id.asc().nullsLast())
			.where(sql`(kind = 'related'::text)`),
		uniqueIndex("article_link_uq_1")
			.using("btree", table.revision_id.asc().nullsLast(), table.route_pattern.asc().nullsLast())
			.where(sql`(kind = 'guide'::text)`),
	],
);
export const article_revision = pgTable(
	"article_revision",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		article_id: uuid("article_id").notNull(),
		tenant_id: uuid("tenant_id").notNull(),
		release_id: uuid("release_id"),
		revision_number: integer("revision_number").notNull(),
		upstream_revision_id: uuid("upstream_revision_id"),
		title: text("title").notNull(),
		slug: text("slug").notNull(),
		excerpt: text("excerpt"),
		body: text("body").notNull(),
		content_type: text("content_type", { enum: ["safe_mdx", "safe_nodes"] }).notNull(),
		phase: integer("phase"),
		parent_article_id: uuid("parent_article_id"),
		position: integer("position").notNull(),
		content_hash: text("content_hash").notNull(),
		published_at: timestamp("published_at", { withTimezone: true, mode: "date" }),
		meaningful: boolean("meaningful").notNull(),
		meaningful_sequence: int64("meaningful_sequence").notNull(),
		author_id: uuid("author_id"),
		section_id: uuid("section_id").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "article_revision_fk_0", columns: [table.article_id], foreignColumns: [reference_item.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "article_revision_fk_1", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "article_revision_fk_2",
			columns: [table.release_id, table.tenant_id],
			foreignColumns: [reference_release.id, reference_release.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "article_revision_fk_3",
			columns: [table.upstream_revision_id],
			foreignColumns: [article_revision.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "article_revision_fk_4",
			columns: [table.parent_article_id],
			foreignColumns: [reference_item.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "article_revision_fk_5", columns: [table.author_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "article_revision_fk_6", columns: [table.section_id], foreignColumns: [reference_item.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "article_revision_fk_7",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "article_revision_pkey", columns: [table.id] }),
		unique("article_revision_uq_0").on(table.article_id, table.tenant_id, table.revision_number),
		unique("article_revision_uq_1").on(table.id, table.tenant_id),
		check("article_revision_ck_0", sql`(content_type = ANY (ARRAY['safe_mdx'::text, 'safe_nodes'::text]))`),
		check("article_revision_ck_1", sql`((phase IS NULL) OR ((phase >= 0) AND (phase <= 6)))`),
		check(
			"article_revision_ck_2",
			sql`((tenant_id = '00000000-0000-0000-0000-000000000000'::uuid) OR (content_type = 'safe_nodes'::text))`,
		),
		check(
			"article_revision_ck_3",
			sql`((tenant_id = '00000000-0000-0000-0000-000000000000'::uuid) = (release_id IS NOT NULL))`,
		),
		index("article_revision_ref_1").using("btree", table.tenant_id.asc().nullsLast()),
		index("article_revision_ref_2").using(
			"btree",
			table.release_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
		index("article_revision_ref_3").using("btree", table.upstream_revision_id.asc().nullsLast()),
		index("article_revision_ref_4").using("btree", table.parent_article_id.asc().nullsLast()),
		index("article_revision_ref_5").using("btree", table.author_id.asc().nullsLast()),
		index("article_revision_ref_6").using("btree", table.section_id.asc().nullsLast()),
	],
);
export const assessment = pgTable(
	"assessment",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		demand_kind: text("demand_kind", { enum: ["material", "daily", "manual", "operator"] }).notNull(),
		request_key: text("request_key").notNull(),
		request_digest: text("request_digest").notNull(),
		refresh_window: date("refresh_window", { mode: "string" }),
		source_revision: int64("source_revision").notNull(),
		reference_activation_id: uuid("reference_activation_id").notNull(),
		rubric_version_id: uuid("rubric_version_id").notNull(),
		policy_version: text("policy_version").notNull(),
		formula_version: text("formula_version").notNull(),
		schema_version: text("schema_version").notNull(),
		as_of: timestamp("as_of", { withTimezone: true, mode: "date" }).notNull(),
		captured_phase: integer("captured_phase"),
		timezone: text("timezone").notNull(),
		snapshot_hash: text("snapshot_hash"),
		model_id: text("model_id").notNull(),
		model_parameters: jsonb("model_parameters").notNull(),
		state: text("state", {
			enum: ["owed", "captured", "drafting", "validated", "complete", "deferred", "failed", "superseded"],
		}).notNull(),
		job_id: uuid("job_id"),
		draft_count: integer("draft_count").notNull(),
		reserved_input: integer("reserved_input").notNull(),
		reserved_output: integer("reserved_output").notNull(),
		used_input: integer("used_input").notNull(),
		used_output: integer("used_output").notNull(),
		deadline_at: timestamp("deadline_at", { withTimezone: true, mode: "date" }),
		failure_code: text("failure_code"),
		last_violation_code: text("last_violation_code"),
		available_at: timestamp("available_at", { withTimezone: true, mode: "date" }),
		human_seen_at: timestamp("human_seen_at", { withTimezone: true, mode: "date" }),
		released_at: timestamp("released_at", { withTimezone: true, mode: "date" }),
		summary: text("summary"),
		input_manifest_hash: text("input_manifest_hash"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "assessment_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assessment_fk_1",
			columns: [table.reference_activation_id],
			foreignColumns: [reference_activation.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "assessment_fk_2", columns: [table.rubric_version_id], foreignColumns: [reference_version.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assessment_fk_3",
			columns: [table.job_id, table.tenant_id],
			foreignColumns: [job.id, job.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assessment_fk_4",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "assessment_pkey", columns: [table.id] }),
		unique("assessment_uq_0").on(table.tenant_id, table.request_key),
		unique("assessment_uq_1").on(table.id, table.tenant_id),
		check("assessment_ck_0", sql`(revision >= 1)`),
		check(
			"assessment_ck_1",
			sql`(demand_kind = ANY (ARRAY['material'::text, 'daily'::text, 'manual'::text, 'operator'::text]))`,
		),
		check(
			"assessment_ck_2",
			sql`(state = ANY (ARRAY['owed'::text, 'captured'::text, 'drafting'::text, 'validated'::text, 'complete'::text, 'deferred'::text, 'failed'::text, 'superseded'::text]))`,
		),
		check("assessment_ck_3", sql`((draft_count >= 0) AND (draft_count <= 3))`),
		check("assessment_ck_4", sql`((reserved_input >= 0) AND (reserved_input <= 60000))`),
		check("assessment_ck_5", sql`((reserved_output >= 0) AND (reserved_output <= 12000))`),
		check("assessment_ck_6", sql`((captured_phase IS NULL) OR ((captured_phase >= 0) AND (captured_phase <= 6)))`),
		check(
			"assessment_ck_7",
			sql`((state <> 'complete'::text) OR ((snapshot_hash IS NOT NULL) AND (available_at IS NOT NULL) AND (summary IS NOT NULL)))`,
		),
		check("assessment_ck_8", sql`((summary IS NULL) OR ((length(summary) >= 10) AND (length(summary) <= 600)))`),
		check("assessment_ck_9", sql`(tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		check("assessment_timezone_iana", sql`(timezone = ANY (${canonicalZones7}))`),
		index("assessment_ref_1").using("btree", table.reference_activation_id.asc().nullsLast()),
		index("assessment_ref_2").using("btree", table.rubric_version_id.asc().nullsLast()),
		index("assessment_ref_3").using("btree", table.job_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
	],
);
export const assessment_contributor = pgTable(
	"assessment_contributor",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		organization_id: uuid("organization_id").notNull(),
		assessment_id: uuid("assessment_id").notNull(),
		plant_id: uuid("plant_id").notNull(),
		recognition_operation_id: uuid("recognition_operation_id").notNull(),
		sharing_revision: int64("sharing_revision").notNull(),
		plant_source_revision: int64("plant_source_revision").notNull(),
		plant_assessment_id: uuid("plant_assessment_id").notNull(),
		geography_id: uuid("geography_id"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "assessment_contributor_fk_0",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assessment_contributor_fk_1",
			columns: [table.assessment_id, table.organization_id],
			foreignColumns: [assessment.id, assessment.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "assessment_contributor_fk_2", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assessment_contributor_fk_3",
			columns: [table.recognition_operation_id],
			foreignColumns: [audit_event.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assessment_contributor_fk_4",
			columns: [table.plant_assessment_id, table.plant_id],
			foreignColumns: [assessment.id, assessment.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assessment_contributor_fk_5",
			columns: [table.geography_id, table.plant_id],
			foreignColumns: [plant_geography.id, plant_geography.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assessment_contributor_fk_6",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assessment_contributor_fk_7",
			columns: [table.plant_id, table.organization_id],
			foreignColumns: [affiliation.plant_id, affiliation.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "assessment_contributor_pkey", columns: [table.id] }),
		unique("assessment_contributor_uq_0").on(table.id, table.organization_id),
		unique("assessment_contributor_uq_1").on(table.assessment_id, table.plant_id),
		index("assessment_contributor_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("assessment_contributor_ref_1").using(
			"btree",
			table.assessment_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("assessment_contributor_ref_2").using("btree", table.plant_id.asc().nullsLast()),
		index("assessment_contributor_ref_3").using("btree", table.recognition_operation_id.asc().nullsLast()),
		index("assessment_contributor_ref_4").using(
			"btree",
			table.plant_assessment_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("assessment_contributor_ref_5").using(
			"btree",
			table.geography_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("assessment_contributor_ref_7").using(
			"btree",
			table.plant_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
	],
);
export const assessment_fact = pgTable(
	"assessment_fact",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		assessment_id: uuid("assessment_id").notNull(),
		path: text("path").notNull(),
		value_state: text("value_state", {
			enum: ["known", "unknown", "unanswered", "retracted", "partial", "unavailable"],
		}).notNull(),
		provenance: text("provenance", { enum: ["measured", "calculated", "human_attested"] }).notNull(),
		number_value: numeric("number_value"),
		boolean_value: boolean("boolean_value"),
		text_value: text("text_value"),
		date_value: date("date_value", { mode: "string" }),
		unit: text("unit"),
		occurred_at: timestamp("occurred_at", { withTimezone: true, mode: "date" }),
		source_revision: int64("source_revision"),
		formula_version: text("formula_version").notNull(),
		kind: text("kind", { enum: ["fact", "lens", "criterion", "regional"] }).notNull(),
		standing: text("standing", {
			enum: [
				"met",
				"not_met",
				"unknown",
				"not_tracked",
				"on_track",
				"attention",
				"watch",
				"strength",
				"limited_visibility",
				"not_shared",
			],
		}),
		judgment: text("judgment", { enum: ["attention", "watch", "noted", "strength", "not_addressed"] }),
		evidence_quality: text("evidence_quality", { enum: ["attested", "measured", "unknown"] }),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "assessment_fact_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assessment_fact_fk_1",
			columns: [table.assessment_id, table.tenant_id],
			foreignColumns: [assessment.id, assessment.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assessment_fact_fk_2",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "assessment_fact_pkey", columns: [table.id] }),
		unique("assessment_fact_uq_0").on(table.assessment_id, table.path),
		unique("assessment_fact_uq_1").on(table.id, table.tenant_id),
		check(
			"assessment_fact_ck_0",
			sql`(value_state = ANY (ARRAY['known'::text, 'unknown'::text, 'unanswered'::text, 'retracted'::text, 'partial'::text, 'unavailable'::text]))`,
		),
		check(
			"assessment_fact_ck_1",
			sql`(provenance = ANY (ARRAY['measured'::text, 'calculated'::text, 'human_attested'::text]))`,
		),
		check("assessment_fact_ck_10", sql`(tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		check(
			"assessment_fact_ck_2",
			sql`((value_state <> 'known'::text) OR (kind <> 'fact'::text) OR (num_nonnulls(number_value, boolean_value, text_value, date_value) = 1))`,
		),
		check("assessment_fact_ck_3", sql`(num_nonnulls(number_value, boolean_value, text_value, date_value) <= 1)`),
		check(
			"assessment_fact_ck_4",
			sql`(kind = ANY (ARRAY['fact'::text, 'lens'::text, 'criterion'::text, 'regional'::text]))`,
		),
		check(
			"assessment_fact_ck_5",
			sql`(standing = ANY (ARRAY['met'::text, 'not_met'::text, 'unknown'::text, 'not_tracked'::text, 'on_track'::text, 'attention'::text, 'watch'::text, 'strength'::text, 'limited_visibility'::text, 'not_shared'::text]))`,
		),
		check(
			"assessment_fact_ck_6",
			sql`(judgment = ANY (ARRAY['attention'::text, 'watch'::text, 'noted'::text, 'strength'::text, 'not_addressed'::text]))`,
		),
		check(
			"assessment_fact_ck_7",
			sql`(((kind = 'fact'::text) AND (standing IS NULL)) OR ((kind <> 'fact'::text) AND (standing IS NOT NULL)))`,
		),
		check(
			"assessment_fact_ck_8",
			sql`((kind = 'fact'::text) OR (num_nonnulls(number_value, boolean_value, text_value, date_value) = 0))`,
		),
		check(
			"assessment_fact_ck_9",
			sql`(evidence_quality = ANY (ARRAY['attested'::text, 'measured'::text, 'unknown'::text]))`,
		),
		index("assessment_fact_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
		index("assessment_fact_ref_1").using(
			"btree",
			table.assessment_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
	],
);
export const assignment_feedback = pgTable(
	"assignment_feedback",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		enrollment_milestone_id: uuid("enrollment_milestone_id").notNull(),
		author_id: uuid("author_id"),
		recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
		body: text("body").notNull(),
		revision: int64("revision").notNull(),
		supersedes_id: uuid("supersedes_id"),
		withdrawn_at: timestamp("withdrawn_at", { withTimezone: true, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "assignment_feedback_fk_0",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assignment_feedback_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assignment_feedback_fk_2",
			columns: [table.enrollment_milestone_id, table.organization_id],
			foreignColumns: [enrollment_milestone.id, enrollment_milestone.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "assignment_feedback_fk_3", columns: [table.author_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "assignment_feedback_fk_4",
			columns: [table.supersedes_id, table.organization_id],
			foreignColumns: [assignment_feedback.id, assignment_feedback.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "assignment_feedback_pkey", columns: [table.id] }),
		unique("assignment_feedback_uq_0").on(table.id, table.organization_id),
		check("assignment_feedback_ck_0", sql`(revision >= 1)`),
		check("assignment_feedback_ck_1", sql`((supersedes_id IS NULL) OR (supersedes_id <> id))`),
		index("assignment_feedback_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("assignment_feedback_ref_2").using(
			"btree",
			table.enrollment_milestone_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("assignment_feedback_ref_3").using("btree", table.author_id.asc().nullsLast()),
		index("assignment_feedback_ref_4").using(
			"btree",
			table.supersedes_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
	],
);
export const attestation = pgTable(
	"attestation",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		key: text("key", {
			enum: [
				"values_documented",
				"financial_base_established",
				"core_group_giving",
				"prayer_leader_assigned",
				"prayer_rhythm_established",
				"prayer_in_gatherings",
				"systems_tested",
				"worship_agreement",
				"community",
				"promotion_plan",
				"relationship",
				"leadership_candidate",
			],
		}).notNull(),
		reference_version_id: uuid("reference_version_id").notNull(),
		person_id: uuid("person_id"),
		state: text("state", { enum: ["answered", "unanswered", "retracted"] }).notNull(),
		answer: boolean("answer"),
		as_of: date("as_of", { mode: "string" }).notNull(),
		attested_at: timestamp("attested_at", { withTimezone: true, mode: "date" }).notNull(),
		period_start: date("period_start", { mode: "string" }),
		period_end: date("period_end", { mode: "string" }),
		attendance_continuous: boolean("attendance_continuous"),
		volunteering_continuous: boolean("volunteering_continuous"),
		statement: text("statement"),
		source_description: text("source_description"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "attestation_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "attestation_fk_1",
			columns: [table.reference_version_id],
			foreignColumns: [reference_version.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "attestation_fk_2",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "attestation_fk_3",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "attestation_pkey", columns: [table.id] }),
		unique("attestation_uq_0").on(table.id, table.plant_id),
		check("attestation_ck_0", sql`(revision >= 1)`),
		check(
			"attestation_ck_1",
			sql`(key = ANY (ARRAY['values_documented'::text, 'financial_base_established'::text, 'core_group_giving'::text, 'prayer_leader_assigned'::text, 'prayer_rhythm_established'::text, 'prayer_in_gatherings'::text, 'systems_tested'::text, 'worship_agreement'::text, 'community'::text, 'promotion_plan'::text, 'relationship'::text, 'leadership_candidate'::text]))`,
		),
		check("attestation_ck_2", sql`(state = ANY (ARRAY['answered'::text, 'unanswered'::text, 'retracted'::text]))`),
		check(
			"attestation_ck_3",
			sql`((key <> 'leadership_candidate'::text) OR ((person_id IS NOT NULL) AND (period_start IS NOT NULL) AND (period_end IS NOT NULL) AND (attendance_continuous IS NOT NULL) AND (volunteering_continuous IS NOT NULL)))`,
		),
		check("attestation_ck_4", sql`((period_end IS NULL) OR (period_start <= period_end))`),
		check(
			"attestation_ck_5",
			sql`((key <> ALL (ARRAY['values_documented'::text, 'financial_base_established'::text, 'core_group_giving'::text, 'prayer_leader_assigned'::text, 'prayer_rhythm_established'::text, 'prayer_in_gatherings'::text, 'systems_tested'::text])) OR (((state = 'answered'::text) AND (answer IS NOT NULL)) OR ((state = ANY (ARRAY['unanswered'::text, 'retracted'::text])) AND (answer IS NULL))))`,
		),
		index("attestation_ref_1").using("btree", table.reference_version_id.asc().nullsLast()),
		index("attestation_ref_2").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		uniqueIndex("attestation_uq_1")
			.using("btree", table.plant_id.asc().nullsLast(), table.key.asc().nullsLast())
			.where(sql`(person_id IS NULL)`),
		uniqueIndex("attestation_uq_2")
			.using("btree", table.plant_id.asc().nullsLast(), table.key.asc().nullsLast(), table.person_id.asc().nullsLast())
			.where(sql`(person_id IS NOT NULL)`),
	],
);
export const auth_account = pgTable(
	"auth_account",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`now()`),
		updated_at: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`now()`),
		user_id: uuid("user_id").notNull(),
		provider_id: text("provider_id").notNull(),
		provider_account_id: text("provider_account_id").notNull(),
		password_hash: text("password_hash"),
		access_token: text("access_token"),
		refresh_token: text("refresh_token"),
		id_token: text("id_token"),
		access_token_expires_at: timestamp("access_token_expires_at", { withTimezone: true, mode: "date" }),
		refresh_token_expires_at: timestamp("refresh_token_expires_at", { withTimezone: true, mode: "date" }),
		provider_scope: text("provider_scope"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "auth_account_fk_0", columns: [table.user_id], foreignColumns: [auth_user.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "auth_account_pkey", columns: [table.id] }),
		unique("auth_account_uq_1").on(table.provider_id, table.provider_account_id),
		index("auth_account_ref_0").using("btree", table.user_id.asc().nullsLast()),
	],
);
export const auth_session = pgTable(
	"auth_session",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`now()`),
		updated_at: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`now()`),
		user_id: uuid("user_id").notNull(),
		token: text("token").notNull(),
		expires_at: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
		ip_address: text("ip_address"),
		user_agent: text("user_agent"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "auth_session_fk_0", columns: [table.user_id], foreignColumns: [auth_user.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "auth_session_pkey", columns: [table.id] }),
		unique("auth_session_uq_1").on(table.token),
		index("auth_session_ref_0").using("btree", table.user_id.asc().nullsLast()),
	],
);
export const auth_user = pgTable(
	"auth_user",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`now()`),
		updated_at: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`now()`),
		email: text("email").notNull(),
		email_verified: boolean("email_verified").notNull(),
		name: text("name").notNull(),
		image: text("image"),
	},
	(table): PgTableExtraConfigValue[] => [
		primaryKey({ name: "auth_user_pkey", columns: [table.id] }),
		unique("auth_user_uq_1").on(table.email),
		check("auth_user_email_check", sql`(email = lower(btrim(email)))`),
	],
);
export const auth_verification = pgTable(
	"auth_verification",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`now()`),
		updated_at: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`now()`),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		purpose: text("purpose"),
		expires_at: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
		consumed_at: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		primaryKey({ name: "auth_verification_pkey", columns: [table.id] }),
		unique("auth_verification_uq_1").on(table.identifier, table.purpose, table.value),
	],
);
export const commitment = pgTable(
	"commitment",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		person_id: uuid("person_id").notNull(),
		kind: text("kind", { enum: ["core_group", "launch_team"] }).notNull(),
		signed_on: date("signed_on", { mode: "string" }).notNull(),
		recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
		witness_person_id: uuid("witness_person_id"),
		external_witness: text("external_witness"),
		object_id: uuid("object_id"),
		notes: text("notes"),
		voided_at: timestamp("voided_at", { withTimezone: true, mode: "date" }),
		corrected_commitment_id: uuid("corrected_commitment_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "commitment_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "commitment_fk_1",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "commitment_fk_2",
			columns: [table.witness_person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "commitment_fk_3",
			columns: [table.object_id, table.plant_id],
			foreignColumns: [file_object.id, file_object.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "commitment_fk_4",
			columns: [table.corrected_commitment_id, table.plant_id],
			foreignColumns: [commitment.id, commitment.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "commitment_fk_5",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "commitment_pkey", columns: [table.id] }),
		unique("commitment_uq_0").on(table.id, table.plant_id),
		check("commitment_ck_0", sql`(revision >= 1)`),
		check("commitment_ck_1", sql`(kind = ANY (ARRAY['core_group'::text, 'launch_team'::text]))`),
		check("commitment_ck_2", sql`(num_nonnulls(witness_person_id, external_witness) <= 1)`),
		index("commitment_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("commitment_ref_1").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("commitment_ref_2").using(
			"btree",
			table.witness_person_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("commitment_ref_3").using("btree", table.object_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("commitment_ref_4").using(
			"btree",
			table.corrected_commitment_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
	],
);
export const communication = pgTable(
	"communication",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		author_id: uuid("author_id"),
		subject: text("subject").notNull(),
		body_html: text("body_html").notNull(),
		template_id: uuid("template_id"),
		meeting_id: uuid("meeting_id"),
		state: text("state", {
			enum: [
				"draft",
				"reviewed",
				"dispatching",
				"sent",
				"scheduled",
				"cancelling",
				"cancelled",
				"partial",
				"unknown",
				"failed",
			],
		}).notNull(),
		scheduled_local_date: date("scheduled_local_date", { mode: "string" }),
		scheduled_local_time: time("scheduled_local_time"),
		timezone: text("timezone"),
		scheduled_at: timestamp("scheduled_at", { withTimezone: true, mode: "date" }),
		resolver_version: text("resolver_version"),
		review_digest: text("review_digest"),
		original_communication_id: uuid("original_communication_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "communication_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "communication_fk_1", columns: [table.author_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "communication_fk_2",
			columns: [table.template_id, table.plant_id],
			foreignColumns: [message_template.id, message_template.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "communication_fk_3",
			columns: [table.meeting_id, table.plant_id],
			foreignColumns: [meeting.id, meeting.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "communication_fk_5",
			columns: [table.original_communication_id, table.plant_id],
			foreignColumns: [communication.id, communication.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "communication_fk_6",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "communication_pkey", columns: [table.id] }),
		unique("communication_uq_0").on(table.id, table.plant_id),
		check("communication_ck_0", sql`(revision >= 1)`),
		check(
			"communication_ck_1",
			sql`(state = ANY (ARRAY['draft'::text, 'reviewed'::text, 'dispatching'::text, 'sent'::text, 'scheduled'::text, 'cancelling'::text, 'cancelled'::text, 'partial'::text, 'unknown'::text, 'failed'::text]))`,
		),
		check("communication_timezone_iana", sql`(timezone = ANY (${canonicalZones7}))`),
		index("communication_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("communication_ref_1").using("btree", table.author_id.asc().nullsLast()),
		index("communication_ref_2").using("btree", table.template_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("communication_ref_3").using("btree", table.meeting_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("communication_ref_5").using(
			"btree",
			table.original_communication_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
	],
);
export const communication_recipient = pgTable(
	"communication_recipient",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		communication_id: uuid("communication_id").notNull(),
		person_id: uuid("person_id").notNull(),
		selection_state: text("selection_state", {
			enum: ["reachable", "missing_email", "suppressed", "excluded"],
		}).notNull(),
		mail_id: uuid("mail_id"),
		original_recipient_id: uuid("original_recipient_id"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "communication_recipient_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "communication_recipient_fk_1",
			columns: [table.communication_id, table.plant_id],
			foreignColumns: [communication.id, communication.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "communication_recipient_fk_2",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "communication_recipient_fk_3",
			columns: [table.mail_id, table.plant_id],
			foreignColumns: [mail.id, mail.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "communication_recipient_fk_4",
			columns: [table.original_recipient_id, table.plant_id],
			foreignColumns: [communication_recipient.id, communication_recipient.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "communication_recipient_fk_5",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "communication_recipient_pkey", columns: [table.id] }),
		unique("communication_recipient_uq_0").on(table.id, table.plant_id),
		unique("communication_recipient_uq_1").on(table.communication_id, table.person_id),
		check(
			"communication_recipient_ck_0",
			sql`(selection_state = ANY (ARRAY['reachable'::text, 'missing_email'::text, 'suppressed'::text, 'excluded'::text]))`,
		),
		index("communication_recipient_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("communication_recipient_ref_1").using(
			"btree",
			table.communication_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("communication_recipient_ref_2").using(
			"btree",
			table.person_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("communication_recipient_ref_3").using(
			"btree",
			table.mail_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("communication_recipient_ref_4").using(
			"btree",
			table.original_recipient_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
	],
);
export const contact_outcome = pgTable(
	"contact_outcome",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		person_id: uuid("person_id").notNull(),
		task_id: uuid("task_id"),
		obligation_id: uuid("obligation_id"),
		meeting_id: uuid("meeting_id"),
		outcome: text("outcome", {
			enum: ["contacted", "attempted_no_contact", "administrative_completion", "no_longer_needed"],
		}).notNull(),
		occurred_at: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
		recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
		contact_channel: text("contact_channel", { enum: ["email", "in_person", "other", "phone", "text", "video"] }),
		notes: text("notes"),
		supersedes_id: uuid("supersedes_id"),
		voided_at: timestamp("voided_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "contact_outcome_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "contact_outcome_fk_1",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "contact_outcome_fk_2",
			columns: [table.task_id, table.plant_id],
			foreignColumns: [task.id, task.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "contact_outcome_fk_3",
			columns: [table.obligation_id, table.plant_id],
			foreignColumns: [obligation.id, obligation.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "contact_outcome_fk_4",
			columns: [table.meeting_id, table.plant_id],
			foreignColumns: [meeting.id, meeting.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "contact_outcome_fk_5",
			columns: [table.supersedes_id, table.plant_id],
			foreignColumns: [contact_outcome.id, contact_outcome.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "contact_outcome_fk_6",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "contact_outcome_pkey", columns: [table.id] }),
		unique("contact_outcome_uq_0").on(table.id, table.plant_id),
		check("contact_outcome_ck_0", sql`(revision >= 1)`),
		check(
			"contact_outcome_ck_1",
			sql`(outcome = ANY (ARRAY['contacted'::text, 'attempted_no_contact'::text, 'administrative_completion'::text, 'no_longer_needed'::text]))`,
		),
		check("contact_outcome_ck_2", sql`(occurred_at <= recorded_at)`),
		check(
			"contact_outcome_ck_3",
			sql`(contact_channel = ANY (ARRAY['email'::text, 'in_person'::text, 'other'::text, 'phone'::text, 'text'::text, 'video'::text]))`,
		),
		index("contact_outcome_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("contact_outcome_ref_1").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("contact_outcome_ref_2").using("btree", table.task_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("contact_outcome_ref_3").using(
			"btree",
			table.obligation_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("contact_outcome_ref_4").using("btree", table.meeting_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("contact_outcome_ref_5").using(
			"btree",
			table.supersedes_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
	],
);
export const development_enrollment = pgTable(
	"development_enrollment",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		person_id: uuid("person_id").notNull(),
		program_id: uuid("program_id").notNull(),
		version_id: uuid("version_id").notNull(),
		cohort_label: text("cohort_label").notNull(),
		started_on: date("started_on", { mode: "string" }).notNull(),
		expected_end_on: date("expected_end_on", { mode: "string" }).notNull(),
		status: text("status", { enum: ["active", "completed", "withdrawn"] }).notNull(),
		current_stage_id: uuid("current_stage_id").notNull(),
		next_meeting_at: timestamp("next_meeting_at", { withTimezone: true, mode: "date" }),
		meeting_timezone: text("meeting_timezone").notNull(),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "development_enrollment_fk_0",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_enrollment_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_enrollment_fk_2",
			columns: [table.person_id, table.organization_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_enrollment_fk_3",
			columns: [table.program_id, table.organization_id],
			foreignColumns: [development_program.id, development_program.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_enrollment_fk_4",
			columns: [table.version_id, table.program_id, table.organization_id],
			foreignColumns: [
				development_program_version.id,
				development_program_version.program_id,
				development_program_version.organization_id,
			],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_enrollment_fk_5",
			columns: [table.current_stage_id, table.version_id, table.organization_id],
			foreignColumns: [development_stage.id, development_stage.version_id, development_stage.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "development_enrollment_pkey", columns: [table.id] }),
		unique("development_enrollment_uq_0").on(table.id, table.organization_id),
		unique("development_enrollment_uq_1").on(table.id, table.version_id, table.organization_id),
		unique("development_enrollment_uq_3").on(table.id, table.program_id, table.organization_id),
		check("development_enrollment_ck_0", sql`(revision >= 1)`),
		check(
			"development_enrollment_ck_1",
			sql`(status = ANY (ARRAY['active'::text, 'completed'::text, 'withdrawn'::text]))`,
		),
		check("development_enrollment_ck_2", sql`(expected_end_on >= started_on)`),
		check("development_enrollment_meeting_timezone_iana", sql`(meeting_timezone = ANY (${canonicalZones7}))`),
		index("development_enrollment_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("development_enrollment_ref_2").using(
			"btree",
			table.person_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("development_enrollment_ref_3").using(
			"btree",
			table.program_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("development_enrollment_ref_4").using(
			"btree",
			table.version_id.asc().nullsLast(),
			table.program_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("development_enrollment_ref_5").using(
			"btree",
			table.current_stage_id.asc().nullsLast(),
			table.version_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		uniqueIndex("development_enrollment_uq_2")
			.using(
				"btree",
				table.person_id.asc().nullsLast(),
				table.program_id.asc().nullsLast(),
				table.organization_id.asc().nullsLast(),
			)
			.where(sql`(status = 'active'::text)`),
	],
);
export const development_milestone = pgTable(
	"development_milestone",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		version_id: uuid("version_id").notNull(),
		stage_id: uuid("stage_id").notNull(),
		description: text("description").notNull(),
		position: integer("position").notNull(),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "development_milestone_fk_0",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_milestone_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_milestone_fk_2",
			columns: [table.version_id, table.organization_id],
			foreignColumns: [development_program_version.id, development_program_version.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_milestone_fk_3",
			columns: [table.stage_id, table.version_id, table.organization_id],
			foreignColumns: [development_stage.id, development_stage.version_id, development_stage.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "development_milestone_pkey", columns: [table.id] }),
		unique("development_milestone_uq_0").on(table.id, table.organization_id),
		unique("development_milestone_uq_1").on(table.id, table.version_id, table.organization_id),
		check("development_milestone_ck_0", sql`(revision >= 1)`),
		check("development_milestone_ck_1", sql`("position" >= 0)`),
		index("development_milestone_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("development_milestone_ref_2").using(
			"btree",
			table.version_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("development_milestone_ref_3").using(
			"btree",
			table.stage_id.asc().nullsLast(),
			table.version_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
	],
);
export const development_program = pgTable(
	"development_program",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		kind: text("kind", { enum: ["apprenticeship", "residency"] }).notNull(),
		name: text("name").notNull(),
		director_seat_id: uuid("director_seat_id").notNull(),
		current_version_id: uuid("current_version_id"),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "development_program_fk_0",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_program_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "development_program_fk_2", columns: [table.director_seat_id], foreignColumns: [seat.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_program_fk_3",
			columns: [table.current_version_id, table.id, table.organization_id],
			foreignColumns: [
				development_program_version.id,
				development_program_version.program_id,
				development_program_version.organization_id,
			],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "development_program_pkey", columns: [table.id] }),
		unique("development_program_uq_0").on(table.id, table.organization_id),
		check("development_program_ck_0", sql`(revision >= 1)`),
		check("development_program_ck_1", sql`(kind = ANY (ARRAY['apprenticeship'::text, 'residency'::text]))`),
		index("development_program_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("development_program_ref_2").using("btree", table.director_seat_id.asc().nullsLast()),
		index("development_program_ref_3").using(
			"btree",
			table.current_version_id.asc().nullsLast(),
			table.id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
	],
);
export const development_program_version = pgTable(
	"development_program_version",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		program_id: uuid("program_id").notNull(),
		version_number: integer("version_number").notNull(),
		rhythm: text("rhythm").notNull(),
		expected_months: integer("expected_months").notNull(),
		published_at: timestamp("published_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "development_program_version_fk_0",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_program_version_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_program_version_fk_2",
			columns: [table.program_id, table.organization_id],
			foreignColumns: [development_program.id, development_program.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "development_program_version_pkey", columns: [table.id] }),
		unique("development_program_version_uq_0").on(table.id, table.organization_id),
		unique("development_program_version_uq_1").on(table.program_id, table.version_number),
		unique("development_program_version_uq_2").on(table.id, table.program_id, table.organization_id),
		check("development_program_version_ck_0", sql`(revision >= 1)`),
		check("development_program_version_ck_1", sql`(version_number >= 1)`),
		check("development_program_version_ck_2", sql`(expected_months > 0)`),
		index("development_program_version_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("development_program_version_ref_2").using(
			"btree",
			table.program_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
	],
);
export const development_reading = pgTable(
	"development_reading",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		version_id: uuid("version_id").notNull(),
		article_id: uuid("article_id").notNull(),
		source_revision_id: uuid("source_revision_id").notNull(),
		position: integer("position").notNull(),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "development_reading_fk_0",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_reading_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_reading_fk_2",
			columns: [table.version_id, table.organization_id],
			foreignColumns: [development_program_version.id, development_program_version.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "development_reading_fk_3", columns: [table.article_id], foreignColumns: [reference_item.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_reading_fk_4",
			columns: [table.source_revision_id],
			foreignColumns: [article_revision.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "development_reading_pkey", columns: [table.id] }),
		unique("development_reading_uq_0").on(table.id, table.organization_id),
		check("development_reading_ck_0", sql`(revision >= 1)`),
		check("development_reading_ck_1", sql`("position" >= 0)`),
		index("development_reading_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("development_reading_ref_2").using(
			"btree",
			table.version_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("development_reading_ref_3").using("btree", table.article_id.asc().nullsLast()),
		index("development_reading_ref_4").using("btree", table.source_revision_id.asc().nullsLast()),
	],
);
export const development_stage = pgTable(
	"development_stage",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		version_id: uuid("version_id").notNull(),
		label: text("label").notNull(),
		position: integer("position").notNull(),
		min_months: integer("min_months").notNull(),
		max_months: integer("max_months").notNull(),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "development_stage_fk_0", columns: [table.organization_id], foreignColumns: [organization.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_stage_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "development_stage_fk_2",
			columns: [table.version_id, table.organization_id],
			foreignColumns: [development_program_version.id, development_program_version.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "development_stage_pkey", columns: [table.id] }),
		unique("development_stage_uq_0").on(table.id, table.organization_id),
		unique("development_stage_uq_1").on(table.id, table.version_id, table.organization_id),
		check("development_stage_ck_0", sql`(revision >= 1)`),
		check("development_stage_ck_1", sql`("position" >= 0)`),
		check("development_stage_ck_2", sql`(min_months >= 0)`),
		check("development_stage_ck_3", sql`(max_months >= min_months)`),
		index("development_stage_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("development_stage_ref_2").using(
			"btree",
			table.version_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
	],
);
export const digest_coverage = pgTable(
	"digest_coverage",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		recipient_id: uuid("recipient_id").notNull(),
		purpose: text("purpose", { enum: ["planter", "oversight"] }).notNull(),
		cadence: text("cadence", { enum: ["daily", "weekly"] }).notNull(),
		timezone: text("timezone").notNull(),
		covered_through: date("covered_through", { mode: "string" }),
		last_mail_id: uuid("last_mail_id"),
		last_operation_id: uuid("last_operation_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "digest_coverage_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "digest_coverage_fk_1", columns: [table.recipient_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "digest_coverage_fk_2",
			columns: [table.last_mail_id, table.tenant_id],
			foreignColumns: [mail.id, mail.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "digest_coverage_fk_3",
			columns: [table.last_operation_id, table.tenant_id],
			foreignColumns: [audit_event.id, audit_event.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "digest_coverage_fk_4",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "digest_coverage_pkey", columns: [table.id] }),
		unique("digest_coverage_uq_0").on(table.tenant_id, table.recipient_id, table.purpose),
		unique("digest_coverage_uq_1").on(table.id, table.tenant_id),
		check("digest_coverage_ck_0", sql`(revision >= 1)`),
		check("digest_coverage_ck_1", sql`(purpose = ANY (ARRAY['planter'::text, 'oversight'::text]))`),
		check("digest_coverage_ck_2", sql`(cadence = ANY (ARRAY['daily'::text, 'weekly'::text]))`),
		check("digest_coverage_ck_3", sql`(tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		check("digest_coverage_timezone_iana", sql`(timezone = ANY (${canonicalZones7}))`),
		index("digest_coverage_ref_1").using("btree", table.recipient_id.asc().nullsLast()),
		index("digest_coverage_ref_2").using(
			"btree",
			table.last_mail_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
		index("digest_coverage_ref_3").using(
			"btree",
			table.last_operation_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
	],
);
export const discovery = pgTable(
	"discovery",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		account_id: uuid("account_id").notNull(),
		lead_answer: text("lead_answer", { enum: ["yes", "no", "skip"] }),
		journey_answer: text("journey_answer", { enum: ["existing", "unsure", "discerning", "skip"] }),
		launch_answer: text("launch_answer", { enum: ["planned", "no_date", "skip"] }),
		converted_plant_id: uuid("converted_plant_id"),
		converted_at: timestamp("converted_at", { withTimezone: true, mode: "date" }),
		conversion_operation_id: uuid("conversion_operation_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "discovery_fk_0", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "discovery_fk_1", columns: [table.converted_plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "discovery_fk_2", columns: [table.conversion_operation_id], foreignColumns: [audit_event.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "discovery_fk_3",
			columns: [table.id, table.account_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "discovery_pkey", columns: [table.id] }),
		unique("discovery_uq_0").on(table.id, table.account_id),
		unique("discovery_uq_1").on(table.account_id),
		check("discovery_ck_0", sql`(revision >= 1)`),
		check("discovery_ck_1", sql`((converted_at IS NULL) = (converted_plant_id IS NULL))`),
		check("discovery_ck_2", sql`(lead_answer = ANY (ARRAY['yes'::text, 'no'::text, 'skip'::text]))`),
		check(
			"discovery_ck_3",
			sql`(journey_answer = ANY (ARRAY['existing'::text, 'unsure'::text, 'discerning'::text, 'skip'::text]))`,
		),
		check("discovery_ck_4", sql`(launch_answer = ANY (ARRAY['planned'::text, 'no_date'::text, 'skip'::text]))`),
		index("discovery_ref_1").using("btree", table.converted_plant_id.asc().nullsLast()),
		index("discovery_ref_2").using("btree", table.conversion_operation_id.asc().nullsLast()),
	],
);
export const document = pgTable(
	"document",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		kind: text("kind", { enum: ["native", "core_values", "launch_summary"] }).notNull(),
		title: text("title").notNull(),
		current_revision_id: uuid("current_revision_id"),
		archived_at: timestamp("archived_at", { withTimezone: true, mode: "date" }),
		copied_from_revision_id: uuid("copied_from_revision_id"),
		copied_from_hash: text("copied_from_hash"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "document_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "document_fk_1",
			columns: [table.current_revision_id, table.tenant_id],
			foreignColumns: [document_revision.id, document_revision.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "document_fk_2",
			columns: [table.copied_from_revision_id],
			foreignColumns: [document_revision.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "document_fk_3",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "document_pkey", columns: [table.id] }),
		unique("document_uq_0").on(table.id, table.tenant_id),
		check("document_ck_0", sql`(revision >= 1)`),
		check("document_ck_1", sql`(kind = ANY (ARRAY['native'::text, 'core_values'::text, 'launch_summary'::text]))`),
		check("document_ck_2", sql`(tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		index("document_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
		index("document_ref_1").using(
			"btree",
			table.current_revision_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
		index("document_ref_2").using("btree", table.copied_from_revision_id.asc().nullsLast()),
	],
);
export const document_revision = pgTable(
	"document_revision",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		document_id: uuid("document_id").notNull(),
		version_number: integer("version_number").notNull(),
		body: text("body").notNull(),
		content_hash: text("content_hash").notNull(),
		import_object_id: uuid("import_object_id"),
		import_format: text("import_format", { enum: ["text", "docx"] }),
		import_state: text("import_state", { enum: ["ready", "failed"] }),
		published_at: timestamp("published_at", { withTimezone: true, mode: "date" }),
		recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "document_revision_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "document_revision_fk_1",
			columns: [table.document_id, table.tenant_id],
			foreignColumns: [document.id, document.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "document_revision_fk_2",
			columns: [table.import_object_id, table.tenant_id],
			foreignColumns: [file_object.id, file_object.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "document_revision_fk_3",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "document_revision_pkey", columns: [table.id] }),
		unique("document_revision_uq_0").on(table.document_id, table.version_number),
		unique("document_revision_uq_1").on(table.id, table.tenant_id),
		check("document_revision_ck_0", sql`(import_format = ANY (ARRAY['text'::text, 'docx'::text]))`),
		check("document_revision_ck_1", sql`(import_state = ANY (ARRAY['ready'::text, 'failed'::text]))`),
		check("document_revision_ck_2", sql`(tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		index("document_revision_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
		index("document_revision_ref_1").using(
			"btree",
			table.document_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
		index("document_revision_ref_2").using(
			"btree",
			table.import_object_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
	],
);
export const early_access_attempt = pgTable(
	"early_access_attempt",
	{
		created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`clock_timestamp()`),
		email: text("email").notNull(),
		ip_key: text("ip_key").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		index("early_access_attempt_email").using(
			"btree",
			table.email.asc().nullsLast(),
			table.created_at.asc().nullsLast(),
		),
		index("early_access_attempt_ip").using("btree", table.ip_key.asc().nullsLast(), table.created_at.asc().nullsLast()),
	],
);
export const early_access_request = pgTable(
	"early_access_request",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`clock_timestamp()`),
		kind: text("kind", { enum: ["planter", "network"] }).notNull(),
		email: text("email").notNull(),
		data: jsonb("data").notNull(),
		ip_address: inet("ip_address"),
		mail_payload: jsonb("mail_payload").notNull(),
		mail_id: text("mail_id"),
		mailed_at: timestamp("mailed_at", { withTimezone: true, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		primaryKey({ name: "early_access_request_pkey", columns: [table.id] }),
		check("early_access_request_check", sql`((mail_id IS NULL) = (mailed_at IS NULL))`),
		check("early_access_request_email_check", sql`(email = lower(btrim(email)))`),
		check("early_access_request_kind_check", sql`(kind = ANY (ARRAY['planter'::text, 'network'::text]))`),
		index("early_access_request_duplicate").using(
			"btree",
			table.email.asc().nullsLast(),
			table.kind.asc().nullsLast(),
			table.created_at.desc().nullsFirst(),
		),
		index("early_access_request_retention").using("btree", table.created_at.asc().nullsLast()),
	],
);
export const enrollment_milestone = pgTable(
	"enrollment_milestone",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		enrollment_id: uuid("enrollment_id").notNull(),
		version_id: uuid("version_id").notNull(),
		milestone_id: uuid("milestone_id").notNull(),
		completed_by: uuid("completed_by"),
		completed_at: timestamp("completed_at", { withTimezone: true, mode: "date" }),
		confirmed_by: uuid("confirmed_by"),
		confirmed_at: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision").notNull(),
		completion_source: text("completion_source", { enum: ["resident_self", "program_leader_recorded"] }),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "enrollment_milestone_fk_0",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "enrollment_milestone_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "enrollment_milestone_fk_2",
			columns: [table.enrollment_id, table.version_id, table.organization_id],
			foreignColumns: [enrollment_plan.enrollment_id, enrollment_plan.version_id, enrollment_plan.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "enrollment_milestone_fk_3",
			columns: [table.milestone_id, table.version_id, table.organization_id],
			foreignColumns: [
				development_milestone.id,
				development_milestone.version_id,
				development_milestone.organization_id,
			],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "enrollment_milestone_fk_4", columns: [table.completed_by], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "enrollment_milestone_fk_5", columns: [table.confirmed_by], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "enrollment_milestone_pkey", columns: [table.id] }),
		unique("enrollment_milestone_uq_0").on(table.id, table.organization_id),
		unique("enrollment_milestone_uq_1").on(table.enrollment_id, table.milestone_id),
		check("enrollment_milestone_ck_0", sql`(revision >= 1)`),
		check("enrollment_milestone_ck_1", sql`((completed_by IS NULL) OR (completed_at IS NOT NULL))`),
		check("enrollment_milestone_ck_2", sql`((confirmed_by IS NULL) OR (confirmed_at IS NOT NULL))`),
		check("enrollment_milestone_ck_3", sql`((confirmed_at IS NULL) OR (completed_at IS NOT NULL))`),
		check(
			"enrollment_milestone_ck_4",
			sql`(completion_source = ANY (ARRAY['resident_self'::text, 'program_leader_recorded'::text]))`,
		),
		check("enrollment_milestone_ck_5", sql`((completed_at IS NULL) = (completion_source IS NULL))`),
		check(
			"enrollment_milestone_ck_6",
			sql`((completion_source <> 'program_leader_recorded'::text) OR ((completed_at IS NOT NULL) AND (confirmed_at IS NOT NULL)))`,
		),
		index("enrollment_milestone_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("enrollment_milestone_ref_2").using(
			"btree",
			table.enrollment_id.asc().nullsLast(),
			table.version_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("enrollment_milestone_ref_3").using(
			"btree",
			table.milestone_id.asc().nullsLast(),
			table.version_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("enrollment_milestone_ref_4").using("btree", table.completed_by.asc().nullsLast()),
		index("enrollment_milestone_ref_5").using("btree", table.confirmed_by.asc().nullsLast()),
	],
);
export const enrollment_plan = pgTable(
	"enrollment_plan",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		enrollment_id: uuid("enrollment_id").notNull(),
		program_id: uuid("program_id").notNull(),
		version_id: uuid("version_id").notNull(),
		adopted_at: timestamp("adopted_at", { withTimezone: true, mode: "date" }).notNull(),
		adopted_by: uuid("adopted_by"),
		superseded_at: timestamp("superseded_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "enrollment_plan_fk_0", columns: [table.organization_id], foreignColumns: [organization.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "enrollment_plan_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "enrollment_plan_fk_2",
			columns: [table.enrollment_id, table.program_id, table.organization_id],
			foreignColumns: [
				development_enrollment.id,
				development_enrollment.program_id,
				development_enrollment.organization_id,
			],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "enrollment_plan_fk_3",
			columns: [table.version_id, table.program_id, table.organization_id],
			foreignColumns: [
				development_program_version.id,
				development_program_version.program_id,
				development_program_version.organization_id,
			],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "enrollment_plan_fk_4", columns: [table.adopted_by], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "enrollment_plan_pkey", columns: [table.id] }),
		unique("enrollment_plan_uq_0").on(table.id, table.organization_id),
		unique("enrollment_plan_uq_1").on(table.enrollment_id, table.version_id, table.organization_id),
		check("enrollment_plan_ck_0", sql`(revision >= 1)`),
		check("enrollment_plan_ck_1", sql`((superseded_at IS NULL) OR (superseded_at >= adopted_at))`),
		index("enrollment_plan_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("enrollment_plan_ref_2").using(
			"btree",
			table.enrollment_id.asc().nullsLast(),
			table.program_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("enrollment_plan_ref_3").using(
			"btree",
			table.version_id.asc().nullsLast(),
			table.program_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("enrollment_plan_ref_4").using("btree", table.adopted_by.asc().nullsLast()),
		uniqueIndex("enrollment_plan_uq_2")
			.using("btree", table.enrollment_id.asc().nullsLast(), table.organization_id.asc().nullsLast())
			.where(sql`(superseded_at IS NULL)`),
	],
);
export const evidence_link = pgTable(
	"evidence_link",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		event_id: uuid("event_id"),
		target_record_id: uuid("target_record_id").notNull(),
		category: text("category", {
			enum: ["people", "meetings", "tasks", "ministry", "wiki", "activity", "shared_findings"],
		}),
		purpose: text("purpose", {
			enum: [
				"acknowledgment",
				"author",
				"citation",
				"debrief",
				"grant",
				"inverse_move",
				"launch_seed",
				"prior_output",
				"selection",
				"source",
			],
		}).notNull(),
		position: integer("position"),
		field_path: text("field_path"),
		expected_revision: int64("expected_revision"),
		resulting_revision: int64("resulting_revision"),
		content_hash: text("content_hash"),
		value_snapshot: text("value_snapshot"),
		occurrence_date: date("occurrence_date", { mode: "string" }),
		source_operation_id: uuid("source_operation_id"),
		projection: text("projection", {
			enum: [
				"AdvisoryReadiness",
				"AllowedCapabilityMetadata",
				"ApplicationPolicyDecision",
				"ApprovedDocumentTemplate",
				"ApprovedDocumentTemplatePage",
				"ApprovedMethodologyReference",
				"ApprovedPhaseCatalog",
				"ApprovedWikiBundle",
				"AssessmentCandidateBatch",
				"AssessmentDeltaDTO",
				"AssessmentTrendPage",
				"AssociationReceiptDeliveryStatus",
				"AttestationHistory",
				"AudienceTeamList",
				"AuthorizedArticleExport",
				"AuthorizedCommunicationDetail",
				"AuthorizedCsvExport",
				"AuthorizedDocumentContent",
				"AuthorizedDocumentDownload",
				"AuthorizedDuplicateHintPairs",
				"AuthorizedFeedbackTriagePage",
				"AuthorizedHouseholdPage",
				"AuthorizedMeetingList",
				"AuthorizedMessageTemplateResult",
				"AuthorizedOrgChart",
				"AuthorizedPeopleDirectory",
				"AuthorizedPersonHistoryPage",
				"AuthorizedPersonPage",
				"AuthorizedPersonRedirect",
				"AuthorizedPrivateFile",
				"AuthorizedPrivateRecordPage",
				"AuthorizedProjection",
				"AuthorizedReadResult",
				"AuthorizedSettingsSection",
				"AuthorizedTagPage",
				"AuthorizedTaskCounts",
				"AuthorizedTaskList",
				"AuthorizedTeamList",
				"AuthorizedVenuePage",
				"AuthorizedWikiArticle",
				"AuthorizedWikiArticlePage",
				"AuthorizedWikiExcerpt",
				"AuthorizedWikiGuide",
				"AuthorizedWikiSearchPage",
				"AuthorizedWorkflowHint",
				"BoundedHistoryContinuation",
				"BoundedJobLag",
				"BoundedOversightProjection",
				"BoundedParallelReadResults",
				"BoundedPlantHealthProjection",
				"BoundedPortfolioLaunchReadiness",
				"CalendarResolution",
				"ChildTaskPage",
				"ClarificationCard",
				"ColdStartGuidanceDTO",
				"CommittedAdultCohortDTO",
				"CommunicationExecutionResult",
				"CommunicationMergeFieldPreview",
				"CommunicationPage",
				"CommunicationPreview",
				"ConcernPairingValidation",
				"CoreValuesEvidence",
				"CriterionEvidenceDTO",
				"CsfScorecardDTO",
				"CsvTemplate",
				"CurrentAccountHome",
				"CurrentActorContext",
				"CurrentPlantDashboard",
				"DatedOversightDigestPreview",
				"DatedPlanterDigestPreview",
				"DocumentMergeContext",
				"DraftValidationResult",
				"DuplicateHintPage",
				"EightLensEvidence",
				"EligibleAssigneePage",
				"EmailOptOutView",
				"EvaluationCorrectionHistory",
				"ExactOrganizationAssessment",
				"ExitCriteriaDTO",
				"FactSectionResult",
				"FactSnapshot",
				"FeedbackOwnStatus",
				"FollowUpCoverage",
				"FollowUpObligationPage",
				"FormattedCitedFact",
				"GeneratedDocumentHistoryPage",
				"HandoffPreview",
				"HistoricalCitedFact",
				"HouseholdProjection",
				"HumanFourCsHistory",
				"HumanInterviewHistory",
				"HumanVisionEvaluation",
				"ImportReceipt",
				"InternalAccountPersonBinding",
				"InternalPipelineMetrics",
				"InvitationPage",
				"JourneyHistory",
				"LaunchDebriefNativeOrEvidence",
				"LocationHistoryPage",
				"LocationInsightsDTO",
				"ManualSignalCatalog",
				"MeasuredTeamHealthAggregate",
				"MeetingAgenda",
				"MeetingAnalytics",
				"MeetingDetails",
				"MeetingHistoryPresence",
				"MeetingRelatedPage",
				"MeetingRosterPreview",
				"MergeReview",
				"MigrationProvenance",
				"NetworkOrganizationDirectory",
				"NonpersistentDocumentPreview",
				"OnboardingResume",
				"OpenTaskOccurrence",
				"OrdinaryPersonActivityPage",
				"OrganizationAssessmentHistoryPage",
				"OwnAccountPerson",
				"OwnCandidateDraft",
				"OwnConversationPage",
				"OwnConversationState",
				"OwnCurrentMembership",
				"OwnDiscoveryProfile",
				"OwnExactReview",
				"OwnFeedbackStatusPage",
				"OwnGetmineResult",
				"OwnInsightFeedback",
				"OwnListResult",
				"OwnNotificationPage",
				"OwnNotificationPreferences",
				"OwnNotificationUnreadCount",
				"OwnOrganizationProfile",
				"OwnOrganizationWikiDraft",
				"OwnRecentResult",
				"OwnRegistrationStatus",
				"OwnResumeResult",
				"OwnRsvpOutcome",
				"OwnStatsResult",
				"OwnSuppressionState",
				"OwnUsageSummary",
				"OwnedDocumentPage",
				"PeopleImportPreview",
				"PeopleImportReceipt",
				"PerOrganizationSharing.organization_relationship_status",
				"PerOrganizationSharing.plant_relationship_status",
				"PerOrganizationSharing.plant_settings",
				"PermissionDecision",
				"PersonLinkedQueryPage",
				"PersonTeamCounts",
				"PersonalCalendarPreview",
				"PhaseChangeClassification",
				"PhaseHistory",
				"PhaseTaskOffer",
				"PipelineProjection",
				"PlantAssessmentView",
				"PlantCalendarPreview",
				"PlantFocusView",
				"PlatformPermissionDecision",
				"PracticeOccurrences",
				"PrerequisiteCandidatePage",
				"PrivateAvatarOutcome",
				"PrivateCorrectionHistory",
				"PrivilegedReadiness",
				"ProtectedAuthorizedDownload",
				"ProtectedAuthorizedObject",
				"ProtectedMeetingReminderAudience",
				"ProtectedRenderedEmail",
				"PublicContent",
				"PublicGlobalWikiPreview",
				"PublicLiveness",
				"PublicRouteDecision",
				"PublicRsvpProjection",
				"PublicSafeError",
				"PublicWikiMetadata",
				"QualifiedModelSelection",
				"ReadOnlySourceEvidence",
				"RecipientSearchPage",
				"RecordedMeetingMetric",
				"RecruitmentWarnings",
				"ReferenceComponentBundle",
				"ReferenceLanguageAudit",
				"ReferenceQueryVector",
				"ReferenceValidationReport",
				"RegionCandidates",
				"RelationshipHistoryPage",
				"RequestBoundaryDecision",
				"ResendCandidatePreview",
				"ResolvedAudiencePreview",
				"ResponsibilityOfferPreview",
				"RestrictedDeletionStatus",
				"RetrievedMethodology",
				"RoleSlotPage",
				"RubricManifest",
				"RunFailureDiagnostic",
				"SafeAssessmentRunStatus",
				"SafeErrorCorrelation",
				"SafeInvitationContext",
				"SafeRegistrationOptions",
				"SafeReturnPath",
				"SafeSessionResult",
				"SafeTaskDescription",
				"SavedRunObservation",
				"SavedTrainingApplicability",
				"SchemaValidationReport",
				"SeatRoster",
				"SharedPublishedLaunchSummary",
				"SnapshotDelta",
				"SourceBoundResultCard",
				"TaskDetails",
				"TaskRelatedPage",
				"TaskRelationCandidatePage",
				"TaskStatusHistoryPage",
				"TaskTemplatePreview",
				"TeamDetails",
				"TeamFacts",
				"TeamPersonRelations",
				"TeamRelatedPage",
				"TeamTemplatePreview",
				"TrainingApplicabilityPreview",
				"TrainingAssignmentMatrix",
				"TrustedCurrentCalendarContext",
				"TypedContactHistoryPage",
				"UnmergeReview",
				"VenueProjection",
				"VerifiedBoundedContext",
				"VisionKit",
				"articleNeighborsResult",
				"auditProofCoverageReport",
				"deliveryTotalsResult",
				"forMeetingResult",
				"forPersonResult",
				"inspectPreviewProvenanceReport",
				"inventoryToolsReport",
				"listRecipientsResult",
				"meetingRecipientTrackingResult",
				"navigationResult",
				"readCountdownResult",
				"readJournalResult",
				"readMilestoneHistoryResult",
				"readWorkspaceResult",
				"recommendForPhaseResult",
				"tableOfContentsResult",
				"validateRequirementsReport",
			],
		}),
		source_purpose: text("source_purpose", {
			enum: [
				"access.checkOperation",
				"access.currentActor",
				"access.projectRead",
				"account.getAvatar",
				"account.getDeletionStatus",
				"account.previewPersonalTimezoneChange",
				"accounts.getRegistrationOptions",
				"accounts.getRegistrationStatus",
				"associations.getHistory",
				"auth.classifyPublicPreview",
				"auth.getSession",
				"calendar.getContext",
				"calendar.resolve",
				"churches.getDeletionStatus",
				"communication.deliveryTotals",
				"communication.forMeeting",
				"communication.forPerson",
				"communication.get",
				"communication.getDraft",
				"communication.getExecutionResult",
				"communication.list",
				"communication.listAudienceTeams",
				"communication.listDrafts",
				"communication.listRecipients",
				"communication.meetingRecipientTracking",
				"communication.preview",
				"communication.resendCandidates",
				"communication.resolveAudience",
				"communication.resolveMergeFields",
				"communication.searchRecipients",
				"communication.templates.forMeeting",
				"communication.templates.get",
				"communication.templates.list",
				"dashboard.activity",
				"dashboard.availableActions",
				"dashboard.metrics",
				"dashboard.promptState",
				"dashboard.readSetupGaps",
				"dashboard.resolveHome",
				"dev.inspectPreviewProvenance",
				"development.draftPlan",
				"development.readFeedback",
				"development.readProgram",
				"discovery.getProfile",
				"documents.download",
				"documents.getAuthorized",
				"documents.history.get",
				"documents.history.list",
				"documents.listOwned",
				"documents.preview",
				"documents.read",
				"documents.readCoreValuesEvidence",
				"documents.resolveContext",
				"documents.templates.contextual",
				"documents.templates.get",
				"documents.templates.list",
				"engineering.auditProofCoverage",
				"engineering.inventoryTools",
				"engineering.validateRequirements",
				"evry.askClarification",
				"evry.classifyRequest",
				"evry.collectHistory",
				"evry.compileContext",
				"evry.composeReads",
				"evry.invokeRead",
				"evry.listConversations",
				"evry.observeRun",
				"evry.projectArtifact",
				"evry.projectError",
				"evry.readCatalog",
				"evry.readConversation",
				"evry.readDraft",
				"evry.readReview",
				"evry.readUsage",
				"evry.readWorkflowHint",
				"evry.resolveReferences",
				"evry.selectQualifiedModel",
				"evry.selectReturnedRows",
				"feedback.admin.list",
				"feedback.getOwnStatus",
				"feedback.listOwn",
				"followups.listContactHistory",
				"followups.readObligations",
				"geography.listReportingRegionCandidates",
				"intelligence.buildFactSnapshot",
				"intelligence.computeSnapshotDelta",
				"intelligence.deriveLensEvidence",
				"intelligence.describeRunFailure",
				"intelligence.formatCitedFact",
				"intelligence.readAssessment",
				"intelligence.readAssessmentDelta",
				"intelligence.readAssessmentHistory",
				"intelligence.readAssessmentRun",
				"intelligence.readColdStartGuidance",
				"intelligence.readCommittedAdultCohort",
				"intelligence.readCriterionEvidence",
				"intelligence.readExitCriteria",
				"intelligence.readFacts",
				"intelligence.readFocus",
				"intelligence.readJourney",
				"intelligence.readOwnFeedback",
				"intelligence.readRubric",
				"intelligence.readScorecard",
				"intelligence.resolveCitation",
				"intelligence.retrieveMethodology",
				"intelligence.selectAssessmentCandidates",
				"intelligence.validateConcernPairing",
				"intelligence.validateDraft",
				"invitations.describeRegistrationContext",
				"jobs.inspectLag",
				"launch.readCountdown",
				"launch.readDebrief",
				"launch.readJournal",
				"launch.readMilestoneHistory",
				"launch.readWorkspace",
				"mail.renderTransactional",
				"mail.suppression.listForSelf",
				"marketing.exportAccessRequests",
				"marketing.privacyPolicy",
				"marketing.readProductExamples",
				"marketing.sitemap",
				"marketing.terms",
				"meeting.describeRsvpToken",
				"meeting.rsvpStatus",
				"meetings.attendanceSummary",
				"meetings.attendanceTrend",
				"meetings.cardBreakdown",
				"meetings.communicationContext",
				"meetings.compareEvaluation",
				"meetings.evaluationHistory",
				"meetings.evaluationTrend",
				"meetings.get",
				"meetings.getEvaluation",
				"meetings.getOwnRsvp",
				"meetings.hasHistory",
				"meetings.invitationAttribution",
				"meetings.linkedTaskProgress",
				"meetings.list",
				"meetings.listAttendance",
				"meetings.listCards",
				"meetings.listCompletedPreLaunchPractices",
				"meetings.listGuests",
				"meetings.listKit",
				"meetings.previewRosterImport",
				"meetings.readAgenda",
				"meetings.readAnalytics",
				"meetings.readTokenRsvp",
				"meetings.summaryStats",
				"notifications.describeEmailOptOut",
				"notifications.feed",
				"notifications.inspectAssociationReceipt",
				"notifications.meetingAudience",
				"notifications.preferences.get",
				"notifications.previewOversightDigest",
				"notifications.previewPlanterDigest",
				"notifications.unreadCount",
				"onboarding.getResume",
				"ops.errorCorrelation",
				"ops.inspectLegacyEvidence",
				"ops.inspectMigrationProvenance",
				"ops.liveness",
				"ops.readiness",
				"ops.schemaValidate",
				"orgPeople.export",
				"orgPeople.findDuplicates",
				"orgPeople.read",
				"orgPeople.readNotes",
				"organizationIntelligence.read",
				"organizationIntelligence.readHistory",
				"organizationIntelligence.readLocationHistory",
				"organizationIntelligence.readLocations",
				"organizationLaunchSummary.readPublished",
				"organizations.getProfile",
				"oversight.getHealth",
				"oversight.getPlant",
				"oversight.getSendingChurch",
				"oversight.listPlants",
				"oversight.listSendingChurches",
				"oversight.readLaunchReadiness",
				"people.checkForDuplicates",
				"people.exportPeople",
				"people.generateCsvTemplate",
				"people.getAccountLink",
				"people.getActivities",
				"people.getAssessments",
				"people.getCommitmentDownload",
				"people.getCommitments",
				"people.getHousehold",
				"people.getHouseholdMembers",
				"people.getImportReceipt",
				"people.getInterviews",
				"people.getMergeReview",
				"people.getOwnAccountPerson",
				"people.getPerson",
				"people.getPersonCommunications",
				"people.getPersonPhoto",
				"people.getPersonSkills",
				"people.getPersonTags",
				"people.getPersonTeams",
				"people.getPersonTraining",
				"people.getPipelineData",
				"people.getStatusWarnings",
				"people.listDuplicatePairs",
				"people.listHouseholds",
				"people.listPeople",
				"people.listRecordCorrections",
				"people.listTags",
				"people.mergedPersonDestination",
				"people.previewImport",
				"people.previewUnmerge",
				"people.readPipelineMetrics",
				"phases.classifyChange",
				"phases.readCatalog",
				"phases.readHistory",
				"phases.readReadiness",
				"pipeline.listPeople",
				"pipeline.proposeStageMove",
				"pipeline.readConversationCounts",
				"pipeline.readConversationNote",
				"pipeline.readGoals",
				"pipelineAccess.readPerson",
				"pipelineSharing.checkAggregateAccess",
				"pipelineSharing.readConsent",
				"plant.previewTimezoneChange",
				"platformAdmin.authorize",
				"privacy.getSharing",
				"reference.auditLanguage",
				"reference.embedQuery",
				"reference.exportApprovedWiki",
				"reference.packageDocumentTemplates",
				"reference.packagePlaybook",
				"reference.packageTaskTemplates",
				"reference.packageTeamTemplates",
				"reference.readRubricManifest",
				"reference.validateBundle",
				"residency.readMine",
				"residency.readProgress",
				"residency.readSharing",
				"residency.resolveReading",
				"seats.list",
				"seats.listInvitations",
				"seats.readCurrentMembership",
				"security.checkRequestOrigin",
				"security.safeReturn",
				"settings.getSection",
				"signals.getHistory",
				"signals.listDefinitions",
				"storage.createAuthorizedDownload",
				"storage.readAuthorizedObject",
				"tasks.count",
				"tasks.eligibleAssignees",
				"tasks.findOpenOccurrence",
				"tasks.followUpCoverage",
				"tasks.get",
				"tasks.importReceipt",
				"tasks.list",
				"tasks.listFollowUpOwners",
				"tasks.listPrerequisites",
				"tasks.listSubtasks",
				"tasks.listTemplates",
				"tasks.normalizeDescription",
				"tasks.planHandoff",
				"tasks.prerequisiteCandidates",
				"tasks.previewDescription",
				"tasks.previewTemplate",
				"tasks.readPhaseOffer",
				"tasks.relationOptions",
				"tasks.statusHistory",
				"teams.aggregateHealth",
				"teams.exportOrgChart",
				"teams.get",
				"teams.health",
				"teams.history",
				"teams.leaderCandidates",
				"teams.list",
				"teams.listImportTemplates",
				"teams.listMeetings",
				"teams.listResponsibilities",
				"teams.listRoles",
				"teams.listTraining",
				"teams.membershipHistory",
				"teams.orgChart",
				"teams.personAssignments",
				"teams.personTeamCounts",
				"teams.personTraining",
				"teams.previewRequiredTrainingParticipants",
				"teams.previewResponsibilities",
				"teams.previewTemplateImport",
				"teams.readRequiredTrainingParticipants",
				"teams.searchMembers",
				"teams.staffingFacts",
				"teams.staffingSummary",
				"teams.trainingHistory",
				"teams.trainingMatrix",
				"venues.get",
				"venues.history",
				"venues.list",
				"wiki.article.exportPdf",
				"wiki.article.print",
				"wiki.articleNeighbors",
				"wiki.articles.get",
				"wiki.articles.list",
				"wiki.bookmarks.list",
				"wiki.contextGuide",
				"wiki.feedback.getMine",
				"wiki.navigation",
				"wiki.organizationArticles.getDraft",
				"wiki.publicPreviewMetadata",
				"wiki.reading.recent",
				"wiki.reading.resume",
				"wiki.reading.stats",
				"wiki.recommendForPhase",
				"wiki.referenceExcerpt",
				"wiki.renderGlobalPreview",
				"wiki.search",
				"wiki.tableOfContents",
			],
		}),
		completeness: text("completeness", { enum: ["complete", "partial", "unavailable"] }),
		source_cursor: text("source_cursor"),
		prior_record_id: uuid("prior_record_id"),
		resulting_record_id: uuid("resulting_record_id"),
		consumer_record_id: uuid("consumer_record_id"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "evidence_link_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "evidence_link_fk_1",
			columns: [table.event_id, table.tenant_id],
			foreignColumns: [audit_event.id, audit_event.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "evidence_link_fk_2", columns: [table.target_record_id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "evidence_link_fk_3",
			columns: [table.source_operation_id, table.tenant_id],
			foreignColumns: [audit_event.id, audit_event.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "evidence_link_fk_4", columns: [table.prior_record_id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "evidence_link_fk_5", columns: [table.resulting_record_id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "evidence_link_fk_6",
			columns: [table.consumer_record_id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "evidence_link_pkey", columns: [table.id] }),
		unique("evidence_link_uq_0").on(table.id, table.tenant_id),
		check(
			"evidence_link_ck_0",
			sql`(category = ANY (ARRAY['people'::text, 'meetings'::text, 'tasks'::text, 'ministry'::text, 'wiki'::text, 'activity'::text, 'shared_findings'::text]))`,
		),
		check(
			"evidence_link_ck_1",
			sql`(completeness = ANY (ARRAY['complete'::text, 'partial'::text, 'unavailable'::text]))`,
		),
		check(
			"evidence_link_ck_10",
			sql`((purpose <> 'prior_output'::text) OR ((field_path IS NOT NULL) AND (source_operation_id IS NOT NULL) AND (expected_revision IS NOT NULL)))`,
		),
		check("evidence_link_ck_11", sql`((purpose <> 'author'::text) OR (occurrence_date IS NOT NULL))`),
		check(
			"evidence_link_ck_12",
			sql`((purpose <> 'acknowledgment'::text) OR ((content_hash IS NOT NULL) AND (occurrence_date IS NOT NULL)))`,
		),
		check(
			"evidence_link_ck_13",
			sql`((purpose <> 'debrief'::text) OR ((expected_revision IS NOT NULL) AND (content_hash IS NOT NULL)))`,
		),
		check(
			"evidence_link_ck_14",
			sql`((purpose <> 'launch_seed'::text) OR ((field_path IS NOT NULL) AND ("position" IS NOT NULL)))`,
		),
		check("evidence_link_ck_15", sql`((completeness <> 'partial'::text) OR (source_cursor IS NOT NULL))`),
		check("evidence_link_ck_16", sql`((expected_revision IS NULL) OR (expected_revision >= 1))`),
		check("evidence_link_ck_17", sql`((resulting_revision IS NULL) OR (resulting_revision >= expected_revision))`),
		check("evidence_link_ck_18", sql`(("position" IS NULL) OR ("position" >= 0))`),
		check(
			"evidence_link_ck_19",
			sql`(source_purpose = ANY (ARRAY['access.checkOperation'::text, 'access.currentActor'::text, 'access.projectRead'::text, 'account.getAvatar'::text, 'account.getDeletionStatus'::text, 'account.previewPersonalTimezoneChange'::text, 'accounts.getRegistrationOptions'::text, 'accounts.getRegistrationStatus'::text, 'associations.getHistory'::text, 'auth.classifyPublicPreview'::text, 'auth.getSession'::text, 'calendar.getContext'::text, 'calendar.resolve'::text, 'churches.getDeletionStatus'::text, 'communication.deliveryTotals'::text, 'communication.forMeeting'::text, 'communication.forPerson'::text, 'communication.get'::text, 'communication.getDraft'::text, 'communication.getExecutionResult'::text, 'communication.list'::text, 'communication.listAudienceTeams'::text, 'communication.listDrafts'::text, 'communication.listRecipients'::text, 'communication.meetingRecipientTracking'::text, 'communication.preview'::text, 'communication.resendCandidates'::text, 'communication.resolveAudience'::text, 'communication.resolveMergeFields'::text, 'communication.searchRecipients'::text, 'communication.templates.forMeeting'::text, 'communication.templates.get'::text, 'communication.templates.list'::text, 'dashboard.activity'::text, 'dashboard.availableActions'::text, 'dashboard.metrics'::text, 'dashboard.promptState'::text, 'dashboard.readSetupGaps'::text, 'dashboard.resolveHome'::text, 'dev.inspectPreviewProvenance'::text, 'development.draftPlan'::text, 'development.readFeedback'::text, 'development.readProgram'::text, 'discovery.getProfile'::text, 'documents.download'::text, 'documents.getAuthorized'::text, 'documents.history.get'::text, 'documents.history.list'::text, 'documents.listOwned'::text, 'documents.preview'::text, 'documents.read'::text, 'documents.readCoreValuesEvidence'::text, 'documents.resolveContext'::text, 'documents.templates.contextual'::text, 'documents.templates.get'::text, 'documents.templates.list'::text, 'engineering.auditProofCoverage'::text, 'engineering.inventoryTools'::text, 'engineering.validateRequirements'::text, 'evry.askClarification'::text, 'evry.classifyRequest'::text, 'evry.collectHistory'::text, 'evry.compileContext'::text, 'evry.composeReads'::text, 'evry.invokeRead'::text, 'evry.listConversations'::text, 'evry.observeRun'::text, 'evry.projectArtifact'::text, 'evry.projectError'::text, 'evry.readCatalog'::text, 'evry.readConversation'::text, 'evry.readDraft'::text, 'evry.readReview'::text, 'evry.readUsage'::text, 'evry.readWorkflowHint'::text, 'evry.resolveReferences'::text, 'evry.selectQualifiedModel'::text, 'evry.selectReturnedRows'::text, 'feedback.admin.list'::text, 'feedback.getOwnStatus'::text, 'feedback.listOwn'::text, 'followups.listContactHistory'::text, 'followups.readObligations'::text, 'geography.listReportingRegionCandidates'::text, 'intelligence.buildFactSnapshot'::text, 'intelligence.computeSnapshotDelta'::text, 'intelligence.deriveLensEvidence'::text, 'intelligence.describeRunFailure'::text, 'intelligence.formatCitedFact'::text, 'intelligence.readAssessment'::text, 'intelligence.readAssessmentDelta'::text, 'intelligence.readAssessmentHistory'::text, 'intelligence.readAssessmentRun'::text, 'intelligence.readColdStartGuidance'::text, 'intelligence.readCommittedAdultCohort'::text, 'intelligence.readCriterionEvidence'::text, 'intelligence.readExitCriteria'::text, 'intelligence.readFacts'::text, 'intelligence.readFocus'::text, 'intelligence.readJourney'::text, 'intelligence.readOwnFeedback'::text, 'intelligence.readRubric'::text, 'intelligence.readScorecard'::text, 'intelligence.resolveCitation'::text, 'intelligence.retrieveMethodology'::text, 'intelligence.selectAssessmentCandidates'::text, 'intelligence.validateConcernPairing'::text, 'intelligence.validateDraft'::text, 'invitations.describeRegistrationContext'::text, 'jobs.inspectLag'::text, 'launch.readCountdown'::text, 'launch.readDebrief'::text, 'launch.readJournal'::text, 'launch.readMilestoneHistory'::text, 'launch.readWorkspace'::text, 'mail.renderTransactional'::text, 'mail.suppression.listForSelf'::text, 'marketing.exportAccessRequests'::text, 'marketing.privacyPolicy'::text, 'marketing.readProductExamples'::text, 'marketing.sitemap'::text, 'marketing.terms'::text, 'meeting.describeRsvpToken'::text, 'meeting.rsvpStatus'::text, 'meetings.attendanceSummary'::text, 'meetings.attendanceTrend'::text, 'meetings.cardBreakdown'::text, 'meetings.communicationContext'::text, 'meetings.compareEvaluation'::text, 'meetings.evaluationHistory'::text, 'meetings.evaluationTrend'::text, 'meetings.get'::text, 'meetings.getEvaluation'::text, 'meetings.getOwnRsvp'::text, 'meetings.hasHistory'::text, 'meetings.invitationAttribution'::text, 'meetings.linkedTaskProgress'::text, 'meetings.list'::text, 'meetings.listAttendance'::text, 'meetings.listCards'::text, 'meetings.listCompletedPreLaunchPractices'::text, 'meetings.listGuests'::text, 'meetings.listKit'::text, 'meetings.previewRosterImport'::text, 'meetings.readAgenda'::text, 'meetings.readAnalytics'::text, 'meetings.readTokenRsvp'::text, 'meetings.summaryStats'::text, 'notifications.describeEmailOptOut'::text, 'notifications.feed'::text, 'notifications.inspectAssociationReceipt'::text, 'notifications.meetingAudience'::text, 'notifications.preferences.get'::text, 'notifications.previewOversightDigest'::text, 'notifications.previewPlanterDigest'::text, 'notifications.unreadCount'::text, 'onboarding.getResume'::text, 'ops.errorCorrelation'::text, 'ops.inspectLegacyEvidence'::text, 'ops.inspectMigrationProvenance'::text, 'ops.liveness'::text, 'ops.readiness'::text, 'ops.schemaValidate'::text, 'orgPeople.export'::text, 'orgPeople.findDuplicates'::text, 'orgPeople.read'::text, 'orgPeople.readNotes'::text, 'organizationIntelligence.read'::text, 'organizationIntelligence.readHistory'::text, 'organizationIntelligence.readLocationHistory'::text, 'organizationIntelligence.readLocations'::text, 'organizationLaunchSummary.readPublished'::text, 'organizations.getProfile'::text, 'oversight.getHealth'::text, 'oversight.getPlant'::text, 'oversight.getSendingChurch'::text, 'oversight.listPlants'::text, 'oversight.listSendingChurches'::text, 'oversight.readLaunchReadiness'::text, 'people.checkForDuplicates'::text, 'people.exportPeople'::text, 'people.generateCsvTemplate'::text, 'people.getAccountLink'::text, 'people.getActivities'::text, 'people.getAssessments'::text, 'people.getCommitmentDownload'::text, 'people.getCommitments'::text, 'people.getHousehold'::text, 'people.getHouseholdMembers'::text, 'people.getImportReceipt'::text, 'people.getInterviews'::text, 'people.getMergeReview'::text, 'people.getOwnAccountPerson'::text, 'people.getPerson'::text, 'people.getPersonCommunications'::text, 'people.getPersonPhoto'::text, 'people.getPersonSkills'::text, 'people.getPersonTags'::text, 'people.getPersonTeams'::text, 'people.getPersonTraining'::text, 'people.getPipelineData'::text, 'people.getStatusWarnings'::text, 'people.listDuplicatePairs'::text, 'people.listHouseholds'::text, 'people.listPeople'::text, 'people.listRecordCorrections'::text, 'people.listTags'::text, 'people.mergedPersonDestination'::text, 'people.previewImport'::text, 'people.previewUnmerge'::text, 'people.readPipelineMetrics'::text, 'phases.classifyChange'::text, 'phases.readCatalog'::text, 'phases.readHistory'::text, 'phases.readReadiness'::text, 'pipeline.listPeople'::text, 'pipeline.proposeStageMove'::text, 'pipeline.readConversationCounts'::text, 'pipeline.readConversationNote'::text, 'pipeline.readGoals'::text, 'pipelineAccess.readPerson'::text, 'pipelineSharing.checkAggregateAccess'::text, 'pipelineSharing.readConsent'::text, 'plant.previewTimezoneChange'::text, 'platformAdmin.authorize'::text, 'privacy.getSharing'::text, 'reference.auditLanguage'::text, 'reference.embedQuery'::text, 'reference.exportApprovedWiki'::text, 'reference.packageDocumentTemplates'::text, 'reference.packagePlaybook'::text, 'reference.packageTaskTemplates'::text, 'reference.packageTeamTemplates'::text, 'reference.readRubricManifest'::text, 'reference.validateBundle'::text, 'residency.readMine'::text, 'residency.readProgress'::text, 'residency.readSharing'::text, 'residency.resolveReading'::text, 'seats.list'::text, 'seats.listInvitations'::text, 'seats.readCurrentMembership'::text, 'security.checkRequestOrigin'::text, 'security.safeReturn'::text, 'settings.getSection'::text, 'signals.getHistory'::text, 'signals.listDefinitions'::text, 'storage.createAuthorizedDownload'::text, 'storage.readAuthorizedObject'::text, 'tasks.count'::text, 'tasks.eligibleAssignees'::text, 'tasks.findOpenOccurrence'::text, 'tasks.followUpCoverage'::text, 'tasks.get'::text, 'tasks.importReceipt'::text, 'tasks.list'::text, 'tasks.listFollowUpOwners'::text, 'tasks.listPrerequisites'::text, 'tasks.listSubtasks'::text, 'tasks.listTemplates'::text, 'tasks.normalizeDescription'::text, 'tasks.planHandoff'::text, 'tasks.prerequisiteCandidates'::text, 'tasks.previewDescription'::text, 'tasks.previewTemplate'::text, 'tasks.readPhaseOffer'::text, 'tasks.relationOptions'::text, 'tasks.statusHistory'::text, 'teams.aggregateHealth'::text, 'teams.exportOrgChart'::text, 'teams.get'::text, 'teams.health'::text, 'teams.history'::text, 'teams.leaderCandidates'::text, 'teams.list'::text, 'teams.listImportTemplates'::text, 'teams.listMeetings'::text, 'teams.listResponsibilities'::text, 'teams.listRoles'::text, 'teams.listTraining'::text, 'teams.membershipHistory'::text, 'teams.orgChart'::text, 'teams.personAssignments'::text, 'teams.personTeamCounts'::text, 'teams.personTraining'::text, 'teams.previewRequiredTrainingParticipants'::text, 'teams.previewResponsibilities'::text, 'teams.previewTemplateImport'::text, 'teams.readRequiredTrainingParticipants'::text, 'teams.searchMembers'::text, 'teams.staffingFacts'::text, 'teams.staffingSummary'::text, 'teams.trainingHistory'::text, 'teams.trainingMatrix'::text, 'venues.get'::text, 'venues.history'::text, 'venues.list'::text, 'wiki.article.exportPdf'::text, 'wiki.article.print'::text, 'wiki.articleNeighbors'::text, 'wiki.articles.get'::text, 'wiki.articles.list'::text, 'wiki.bookmarks.list'::text, 'wiki.contextGuide'::text, 'wiki.feedback.getMine'::text, 'wiki.navigation'::text, 'wiki.organizationArticles.getDraft'::text, 'wiki.publicPreviewMetadata'::text, 'wiki.reading.recent'::text, 'wiki.reading.resume'::text, 'wiki.reading.stats'::text, 'wiki.recommendForPhase'::text, 'wiki.referenceExcerpt'::text, 'wiki.renderGlobalPreview'::text, 'wiki.search'::text, 'wiki.tableOfContents'::text]))`,
		),
		check("evidence_link_ck_2", sql`(num_nonnulls(event_id, consumer_record_id) = 1)`),
		check(
			"evidence_link_ck_3",
			sql`(projection = ANY (ARRAY['AdvisoryReadiness'::text, 'AllowedCapabilityMetadata'::text, 'ApplicationPolicyDecision'::text, 'ApprovedDocumentTemplate'::text, 'ApprovedDocumentTemplatePage'::text, 'ApprovedMethodologyReference'::text, 'ApprovedPhaseCatalog'::text, 'ApprovedWikiBundle'::text, 'AssessmentCandidateBatch'::text, 'AssessmentDeltaDTO'::text, 'AssessmentTrendPage'::text, 'AssociationReceiptDeliveryStatus'::text, 'AttestationHistory'::text, 'AudienceTeamList'::text, 'AuthorizedArticleExport'::text, 'AuthorizedCommunicationDetail'::text, 'AuthorizedCsvExport'::text, 'AuthorizedDocumentContent'::text, 'AuthorizedDocumentDownload'::text, 'AuthorizedDuplicateHintPairs'::text, 'AuthorizedFeedbackTriagePage'::text, 'AuthorizedHouseholdPage'::text, 'AuthorizedMeetingList'::text, 'AuthorizedMessageTemplateResult'::text, 'AuthorizedOrgChart'::text, 'AuthorizedPeopleDirectory'::text, 'AuthorizedPersonHistoryPage'::text, 'AuthorizedPersonPage'::text, 'AuthorizedPersonRedirect'::text, 'AuthorizedPrivateFile'::text, 'AuthorizedPrivateRecordPage'::text, 'AuthorizedProjection'::text, 'AuthorizedReadResult'::text, 'AuthorizedSettingsSection'::text, 'AuthorizedTagPage'::text, 'AuthorizedTaskCounts'::text, 'AuthorizedTaskList'::text, 'AuthorizedTeamList'::text, 'AuthorizedVenuePage'::text, 'AuthorizedWikiArticle'::text, 'AuthorizedWikiArticlePage'::text, 'AuthorizedWikiExcerpt'::text, 'AuthorizedWikiGuide'::text, 'AuthorizedWikiSearchPage'::text, 'AuthorizedWorkflowHint'::text, 'BoundedHistoryContinuation'::text, 'BoundedJobLag'::text, 'BoundedOversightProjection'::text, 'BoundedParallelReadResults'::text, 'BoundedPlantHealthProjection'::text, 'BoundedPortfolioLaunchReadiness'::text, 'CalendarResolution'::text, 'ChildTaskPage'::text, 'ClarificationCard'::text, 'ColdStartGuidanceDTO'::text, 'CommittedAdultCohortDTO'::text, 'CommunicationExecutionResult'::text, 'CommunicationMergeFieldPreview'::text, 'CommunicationPage'::text, 'CommunicationPreview'::text, 'ConcernPairingValidation'::text, 'CoreValuesEvidence'::text, 'CriterionEvidenceDTO'::text, 'CsfScorecardDTO'::text, 'CsvTemplate'::text, 'CurrentAccountHome'::text, 'CurrentActorContext'::text, 'CurrentPlantDashboard'::text, 'DatedOversightDigestPreview'::text, 'DatedPlanterDigestPreview'::text, 'DocumentMergeContext'::text, 'DraftValidationResult'::text, 'DuplicateHintPage'::text, 'EightLensEvidence'::text, 'EligibleAssigneePage'::text, 'EmailOptOutView'::text, 'EvaluationCorrectionHistory'::text, 'ExactOrganizationAssessment'::text, 'ExitCriteriaDTO'::text, 'FactSectionResult'::text, 'FactSnapshot'::text, 'FeedbackOwnStatus'::text, 'FollowUpCoverage'::text, 'FollowUpObligationPage'::text, 'FormattedCitedFact'::text, 'GeneratedDocumentHistoryPage'::text, 'HandoffPreview'::text, 'HistoricalCitedFact'::text, 'HouseholdProjection'::text, 'HumanFourCsHistory'::text, 'HumanInterviewHistory'::text, 'HumanVisionEvaluation'::text, 'ImportReceipt'::text, 'InternalAccountPersonBinding'::text, 'InternalPipelineMetrics'::text, 'InvitationPage'::text, 'JourneyHistory'::text, 'LaunchDebriefNativeOrEvidence'::text, 'LocationHistoryPage'::text, 'LocationInsightsDTO'::text, 'ManualSignalCatalog'::text, 'MeasuredTeamHealthAggregate'::text, 'MeetingAgenda'::text, 'MeetingAnalytics'::text, 'MeetingDetails'::text, 'MeetingHistoryPresence'::text, 'MeetingRelatedPage'::text, 'MeetingRosterPreview'::text, 'MergeReview'::text, 'MigrationProvenance'::text, 'NetworkOrganizationDirectory'::text, 'NonpersistentDocumentPreview'::text, 'OnboardingResume'::text, 'OpenTaskOccurrence'::text, 'OrdinaryPersonActivityPage'::text, 'OrganizationAssessmentHistoryPage'::text, 'OwnAccountPerson'::text, 'OwnCandidateDraft'::text, 'OwnConversationPage'::text, 'OwnConversationState'::text, 'OwnCurrentMembership'::text, 'OwnDiscoveryProfile'::text, 'OwnExactReview'::text, 'OwnFeedbackStatusPage'::text, 'OwnGetmineResult'::text, 'OwnInsightFeedback'::text, 'OwnListResult'::text, 'OwnNotificationPage'::text, 'OwnNotificationPreferences'::text, 'OwnNotificationUnreadCount'::text, 'OwnOrganizationProfile'::text, 'OwnOrganizationWikiDraft'::text, 'OwnRecentResult'::text, 'OwnRegistrationStatus'::text, 'OwnResumeResult'::text, 'OwnRsvpOutcome'::text, 'OwnStatsResult'::text, 'OwnSuppressionState'::text, 'OwnUsageSummary'::text, 'OwnedDocumentPage'::text, 'PeopleImportPreview'::text, 'PeopleImportReceipt'::text, 'PerOrganizationSharing.organization_relationship_status'::text, 'PerOrganizationSharing.plant_relationship_status'::text, 'PerOrganizationSharing.plant_settings'::text, 'PermissionDecision'::text, 'PersonLinkedQueryPage'::text, 'PersonTeamCounts'::text, 'PersonalCalendarPreview'::text, 'PhaseChangeClassification'::text, 'PhaseHistory'::text, 'PhaseTaskOffer'::text, 'PipelineProjection'::text, 'PlantAssessmentView'::text, 'PlantCalendarPreview'::text, 'PlantFocusView'::text, 'PlatformPermissionDecision'::text, 'PracticeOccurrences'::text, 'PrerequisiteCandidatePage'::text, 'PrivateAvatarOutcome'::text, 'PrivateCorrectionHistory'::text, 'PrivilegedReadiness'::text, 'ProtectedAuthorizedDownload'::text, 'ProtectedAuthorizedObject'::text, 'ProtectedMeetingReminderAudience'::text, 'ProtectedRenderedEmail'::text, 'PublicContent'::text, 'PublicGlobalWikiPreview'::text, 'PublicLiveness'::text, 'PublicRouteDecision'::text, 'PublicRsvpProjection'::text, 'PublicSafeError'::text, 'PublicWikiMetadata'::text, 'QualifiedModelSelection'::text, 'ReadOnlySourceEvidence'::text, 'RecipientSearchPage'::text, 'RecordedMeetingMetric'::text, 'RecruitmentWarnings'::text, 'ReferenceComponentBundle'::text, 'ReferenceLanguageAudit'::text, 'ReferenceQueryVector'::text, 'ReferenceValidationReport'::text, 'RegionCandidates'::text, 'RelationshipHistoryPage'::text, 'RequestBoundaryDecision'::text, 'ResendCandidatePreview'::text, 'ResolvedAudiencePreview'::text, 'ResponsibilityOfferPreview'::text, 'RestrictedDeletionStatus'::text, 'RetrievedMethodology'::text, 'RoleSlotPage'::text, 'RubricManifest'::text, 'RunFailureDiagnostic'::text, 'SafeAssessmentRunStatus'::text, 'SafeErrorCorrelation'::text, 'SafeInvitationContext'::text, 'SafeRegistrationOptions'::text, 'SafeReturnPath'::text, 'SafeSessionResult'::text, 'SafeTaskDescription'::text, 'SavedRunObservation'::text, 'SavedTrainingApplicability'::text, 'SchemaValidationReport'::text, 'SeatRoster'::text, 'SharedPublishedLaunchSummary'::text, 'SnapshotDelta'::text, 'SourceBoundResultCard'::text, 'TaskDetails'::text, 'TaskRelatedPage'::text, 'TaskRelationCandidatePage'::text, 'TaskStatusHistoryPage'::text, 'TaskTemplatePreview'::text, 'TeamDetails'::text, 'TeamFacts'::text, 'TeamPersonRelations'::text, 'TeamRelatedPage'::text, 'TeamTemplatePreview'::text, 'TrainingApplicabilityPreview'::text, 'TrainingAssignmentMatrix'::text, 'TrustedCurrentCalendarContext'::text, 'TypedContactHistoryPage'::text, 'UnmergeReview'::text, 'VenueProjection'::text, 'VerifiedBoundedContext'::text, 'VisionKit'::text, 'articleNeighborsResult'::text, 'auditProofCoverageReport'::text, 'deliveryTotalsResult'::text, 'forMeetingResult'::text, 'forPersonResult'::text, 'inspectPreviewProvenanceReport'::text, 'inventoryToolsReport'::text, 'listRecipientsResult'::text, 'meetingRecipientTrackingResult'::text, 'navigationResult'::text, 'readCountdownResult'::text, 'readJournalResult'::text, 'readMilestoneHistoryResult'::text, 'readWorkspaceResult'::text, 'recommendForPhaseResult'::text, 'tableOfContentsResult'::text, 'validateRequirementsReport'::text]))`,
		),
		check(
			"evidence_link_ck_4",
			sql`(purpose = ANY (ARRAY['acknowledgment'::text, 'author'::text, 'citation'::text, 'debrief'::text, 'grant'::text, 'inverse_move'::text, 'launch_seed'::text, 'prior_output'::text, 'selection'::text, 'source'::text]))`,
		),
		check("evidence_link_ck_5", sql`((purpose <> 'source'::text) OR (category IS NOT NULL))`),
		check(
			"evidence_link_ck_6",
			sql`((purpose <> 'citation'::text) OR ((projection IS NOT NULL) AND (source_purpose IS NOT NULL) AND (completeness IS NOT NULL)))`,
		),
		check(
			"evidence_link_ck_7",
			sql`((purpose <> 'selection'::text) OR (("position" IS NOT NULL) AND (expected_revision IS NOT NULL)))`,
		),
		check(
			"evidence_link_ck_8",
			sql`((purpose <> 'grant'::text) OR ((category IS NOT NULL) AND (expected_revision IS NOT NULL)))`,
		),
		check(
			"evidence_link_ck_9",
			sql`((purpose <> 'inverse_move'::text) OR ((field_path IS NOT NULL) AND (expected_revision IS NOT NULL) AND (resulting_revision IS NOT NULL)))`,
		),
		index("evidence_link_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
		index("evidence_link_ref_1").using("btree", table.event_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
		index("evidence_link_ref_2").using("btree", table.target_record_id.asc().nullsLast()),
		index("evidence_link_ref_3").using(
			"btree",
			table.source_operation_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
		index("evidence_link_ref_4").using("btree", table.prior_record_id.asc().nullsLast()),
		index("evidence_link_ref_5").using("btree", table.resulting_record_id.asc().nullsLast()),
		index("evidence_link_ref_6").using(
			"btree",
			table.consumer_record_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
	],
);
export const feedback = pgTable(
	"feedback",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		account_id: uuid("account_id").notNull(),
		plant_context_id: uuid("plant_context_id"),
		category: text("category", { enum: ["bug", "suggestion", "question", "other"] }).notNull(),
		description: text("description").notNull(),
		route_label: text("route_label"),
		submitted_at: timestamp("submitted_at", { withTimezone: true, mode: "date" }).notNull(),
		request_key: text("request_key").notNull(),
		triage_state: text("triage_state", { enum: ["new", "reviewed", "resolved", "dismissed"] }).notNull(),
		revision_number: int64("revision_number").notNull(),
		page_label: text("page_label"),
		page_address: text("page_address"),
		church_label: text("church_label"),
		role_label: text("role_label"),
		browser: text("browser"),
		screen_width: integer("screen_width"),
		screen_height: integer("screen_height"),
		theme: text("theme", { enum: ["light", "dark"] }),
		app_version: text("app_version"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "feedback_fk_0", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "feedback_fk_1", columns: [table.plant_context_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "feedback_fk_2",
			columns: [table.id, table.account_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "feedback_pkey", columns: [table.id] }),
		unique("feedback_uq_0").on(table.id, table.account_id),
		unique("feedback_uq_1").on(table.account_id, table.request_key),
		check(
			"feedback_ck_0",
			sql`(category = ANY (ARRAY['bug'::text, 'suggestion'::text, 'question'::text, 'other'::text]))`,
		),
		check(
			"feedback_ck_1",
			sql`(triage_state = ANY (ARRAY['new'::text, 'reviewed'::text, 'resolved'::text, 'dismissed'::text]))`,
		),
		check(
			"feedback_ck_10",
			sql`((page_address IS NULL) OR ((page_address ~~ '/%'::text) AND (POSITION(('?'::text) IN (page_address)) = 0) AND (POSITION(('#'::text) IN (page_address)) = 0)))`,
		),
		check("feedback_ck_11", sql`((theme IS NULL) OR (theme = ANY (ARRAY['light'::text, 'dark'::text])))`),
		check("feedback_ck_12", sql`((screen_width IS NULL) OR ((screen_width >= 1) AND (screen_width <= 100000)))`),
		check("feedback_ck_13", sql`((screen_height IS NULL) OR ((screen_height >= 1) AND (screen_height <= 100000)))`),
		check("feedback_ck_2", sql`((length(btrim(description)) >= 1) AND (length(btrim(description)) <= 5000))`),
		check("feedback_ck_3", sql`((route_label IS NULL) OR (length(route_label) <= 500))`),
		check("feedback_ck_4", sql`((page_label IS NULL) OR (length(page_label) <= 500))`),
		check("feedback_ck_5", sql`((page_address IS NULL) OR (length(page_address) <= 500))`),
		check("feedback_ck_6", sql`((church_label IS NULL) OR (length(church_label) <= 200))`),
		check("feedback_ck_7", sql`((role_label IS NULL) OR (length(role_label) <= 200))`),
		check("feedback_ck_8", sql`((browser IS NULL) OR (length(browser) <= 500))`),
		check("feedback_ck_9", sql`((app_version IS NULL) OR (length(app_version) <= 100))`),
		index("feedback_ref_1").using("btree", table.plant_context_id.asc().nullsLast()),
	],
);
export const feedback_publication = pgTable(
	"feedback_publication",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		account_id: uuid("account_id"),
		feedback_id: uuid("feedback_id"),
		marker: uuid("marker").notNull(),
		category: text("category"),
		public_area: text("public_area"),
		sanitized_title: text("sanitized_title"),
		sanitized_body: text("sanitized_body"),
		payload_hash: text("payload_hash").notNull(),
		repository_numeric_id: int64("repository_numeric_id").notNull(),
		repository_node_id: text("repository_node_id").notNull(),
		repository_owner: text("repository_owner").notNull(),
		repository_name: text("repository_name").notNull(),
		state: text("state", { enum: ["pending", "held", "publishing", "published", "rejected", "unknown"] }).notNull(),
		issue_number: integer("issue_number"),
		issue_node_id: text("issue_node_id"),
		issue_url: text("issue_url"),
		published_at: timestamp("published_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "feedback_publication_fk_0", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "feedback_publication_fk_1",
			columns: [table.feedback_id, table.account_id],
			foreignColumns: [feedback.id, feedback.account_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "feedback_publication_fk_3", columns: [table.id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "feedback_publication_pkey", columns: [table.id] }),
		unique("feedback_publication_uq_0").on(table.id, table.account_id),
		unique("feedback_publication_uq_1").on(table.marker),
		unique("feedback_publication_uq_2").on(table.feedback_id),
		check("feedback_publication_ck_0", sql`(revision >= 1)`),
		check(
			"feedback_publication_ck_1",
			sql`(state = ANY (ARRAY['pending'::text, 'held'::text, 'publishing'::text, 'published'::text, 'rejected'::text, 'unknown'::text]))`,
		),
		check(
			"feedback_publication_ck_2",
			sql`(((account_id IS NOT NULL) AND (feedback_id IS NOT NULL) AND (category IS NOT NULL) AND (public_area IS NOT NULL) AND (sanitized_title IS NOT NULL) AND (sanitized_body IS NOT NULL)) OR ((account_id IS NULL) AND (feedback_id IS NULL) AND (category IS NULL) AND (public_area IS NULL) AND (sanitized_title IS NULL) AND (sanitized_body IS NULL)))`,
		),
		check(
			"feedback_publication_ck_3",
			sql`((account_id IS NOT NULL) OR (state = ANY (ARRAY['published'::text, 'unknown'::text])))`,
		),
		index("feedback_publication_ref_0").using("btree", table.account_id.asc().nullsLast()),
		index("feedback_publication_ref_1").using(
			"btree",
			table.feedback_id.asc().nullsLast(),
			table.account_id.asc().nullsLast(),
		),
	],
);
export const file_object = pgTable(
	"file_object",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		purpose: text("purpose", {
			enum: [
				"avatar",
				"person_photo",
				"commitment",
				"generated",
				"native_import",
				"assistant_staging",
				"communication_attachment",
			],
		}).notNull(),
		opaque_key: text("opaque_key").notNull(),
		media_type: text("media_type").notNull(),
		max_bytes: int64("max_bytes").notNull(),
		byte_count: int64("byte_count"),
		sha256: text("sha256"),
		state: text("state", { enum: ["pending", "ready", "failed", "cleanup", "purged"] }).notNull(),
		upload_key: text("upload_key").notNull(),
		expires_at: timestamp("expires_at", { withTimezone: true, mode: "date" }),
		claim_generation: int64("claim_generation").notNull(),
		retention_until: timestamp("retention_until", { withTimezone: true, mode: "date" }),
		purge_requested_at: timestamp("purge_requested_at", { withTimezone: true, mode: "date" }),
		purged_at: timestamp("purged_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "file_object_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "file_object_fk_1",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "file_object_pkey", columns: [table.id] }),
		unique("file_object_uq_0").on(table.opaque_key),
		unique("file_object_uq_1").on(table.upload_key),
		unique("file_object_uq_2").on(table.id, table.tenant_id),
		check(
			"file_limits",
			sql`((max_bytes > 0) AND (claim_generation >= 0) AND ((sha256 IS NULL) OR (sha256 ~ '^[0-9a-f]{64}$'::text)))`,
		),
		check("file_object_ck_0", sql`(revision >= 1)`),
		check(
			"file_object_ck_1",
			sql`(purpose = ANY (ARRAY['avatar'::text, 'person_photo'::text, 'commitment'::text, 'generated'::text, 'native_import'::text, 'assistant_staging'::text, 'communication_attachment'::text]))`,
		),
		check(
			"file_object_ck_2",
			sql`(state = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text, 'cleanup'::text, 'purged'::text]))`,
		),
		check("file_object_ck_3", sql`((byte_count IS NULL) OR ((byte_count >= 1) AND (byte_count <= max_bytes)))`),
		check("file_object_ck_4", sql`((state <> 'ready'::text) OR ((byte_count IS NOT NULL) AND (sha256 IS NOT NULL)))`),
		check("file_object_ck_5", sql`(tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		check("opaque_private_key", sql`(opaque_key ~ '^private/[0-9a-f-]{36}/[0-9a-f-]{36}$'::text)`),
		check("private_key_owner", sql`((split_part(opaque_key, '/'::text, 2))::uuid = tenant_id)`),
		index("file_object_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
	],
);
export const finding = pgTable(
	"finding",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		assessment_id: uuid("assessment_id").notNull(),
		concern_key: text("concern_key").notNull(),
		audience: text("audience", { enum: ["planter", "oversight"] }).notNull(),
		category: text("category", {
			enum: ["people", "meetings", "tasks", "ministry", "wiki", "shared_findings"],
		}).notNull(),
		urgency: text("urgency", { enum: ["positive", "info", "watch", "urgent"] }).notNull(),
		title: text("title").notNull(),
		body: text("body").notNull(),
		rank: integer("rank").notNull(),
		focus: text("focus", { enum: ["primary", "supplement", "positive"] }),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "finding_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "finding_fk_1",
			columns: [table.assessment_id, table.tenant_id],
			foreignColumns: [assessment.id, assessment.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "finding_fk_2",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "finding_pkey", columns: [table.id] }),
		unique("finding_uq_0").on(table.assessment_id, table.audience, table.concern_key),
		unique("finding_uq_1").on(table.id, table.tenant_id),
		check("finding_ck_0", sql`(audience = ANY (ARRAY['planter'::text, 'oversight'::text]))`),
		check(
			"finding_ck_1",
			sql`(category = ANY (ARRAY['people'::text, 'meetings'::text, 'tasks'::text, 'ministry'::text, 'wiki'::text, 'shared_findings'::text]))`,
		),
		check("finding_ck_2", sql`(urgency = ANY (ARRAY['positive'::text, 'info'::text, 'watch'::text, 'urgent'::text]))`),
		check("finding_ck_3", sql`(focus = ANY (ARRAY['primary'::text, 'supplement'::text, 'positive'::text]))`),
		check("finding_ck_4", sql`((length(title) >= 3) AND (length(title) <= 140))`),
		check("finding_ck_5", sql`((length(body) >= 10) AND (length(body) <= 1200))`),
		check("finding_ck_6", sql`(tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		index("finding_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
		index("finding_ref_1").using("btree", table.assessment_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
	],
);
export const four_cs = pgTable(
	"four_cs",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		person_id: uuid("person_id").notNull(),
		assessed_on: date("assessed_on", { mode: "string" }).notNull(),
		recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
		committed: integer("committed").notNull(),
		compelled: integer("compelled").notNull(),
		contagious: integer("contagious").notNull(),
		courageous: integer("courageous").notNull(),
		committed_notes: text("committed_notes"),
		compelled_notes: text("compelled_notes"),
		contagious_notes: text("contagious_notes"),
		courageous_notes: text("courageous_notes"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "four_cs_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "four_cs_fk_1",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "four_cs_fk_2",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "four_cs_pkey", columns: [table.id] }),
		unique("four_cs_uq_0").on(table.id, table.plant_id),
		check("four_cs_ck_0", sql`(revision >= 1)`),
		check("four_cs_ck_1", sql`((committed >= 1) AND (committed <= 5))`),
		check("four_cs_ck_2", sql`((compelled >= 1) AND (compelled <= 5))`),
		check("four_cs_ck_3", sql`((contagious >= 1) AND (contagious <= 5))`),
		check("four_cs_ck_4", sql`((courageous >= 1) AND (courageous <= 5))`),
		index("four_cs_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("four_cs_ref_1").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
	],
);
export const generated_document = pgTable(
	"generated_document",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		template_version_id: uuid("template_version_id").notNull(),
		saved_template_name: text("saved_template_name").notNull(),
		renderer_version: text("renderer_version").notNull(),
		format: text("format", { enum: ["pdf", "docx", "xlsx"] }).notNull(),
		object_id: uuid("object_id").notNull(),
		generated_at: timestamp("generated_at", { withTimezone: true, mode: "date" }).notNull(),
		download_name: text("download_name").notNull(),
		generation_operation_id: uuid("generation_operation_id").notNull(),
		inputs: jsonb("inputs").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "generated_document_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "generated_document_fk_1",
			columns: [table.template_version_id],
			foreignColumns: [reference_version.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "generated_document_fk_2",
			columns: [table.object_id, table.tenant_id],
			foreignColumns: [file_object.id, file_object.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "generated_document_fk_3",
			columns: [table.generation_operation_id],
			foreignColumns: [audit_event.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "generated_document_fk_4",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "generated_document_pkey", columns: [table.id] }),
		unique("generated_document_uq_0").on(table.generation_operation_id),
		unique("generated_document_uq_1").on(table.id, table.tenant_id),
		check("generated_document_ck_0", sql`(format = ANY (ARRAY['pdf'::text, 'docx'::text, 'xlsx'::text]))`),
		check("generated_document_ck_1", sql`(tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		index("generated_document_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
		index("generated_document_ref_1").using("btree", table.template_version_id.asc().nullsLast()),
		index("generated_document_ref_2").using(
			"btree",
			table.object_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
	],
);
export const household = pgTable(
	"household",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		name: text("name").notNull(),
		street: text("street"),
		city: text("city"),
		state_province: text("state_province"),
		postal_code: text("postal_code"),
		country: text("country"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "household_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "household_fk_1",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "household_pkey", columns: [table.id] }),
		unique("household_uq_0").on(table.id, table.plant_id),
		check("household_ck_0", sql`(revision >= 1)`),
		index("household_ref_0").using("btree", table.plant_id.asc().nullsLast()),
	],
);
export const identity_proof = pgTable(
	"identity_proof",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		account_id: uuid("account_id").notNull(),
		purpose: text("purpose", { enum: ["email_change", "deletion_cancel"] }).notNull(),
		token_hash: text("token_hash").notNull(),
		proposed_email: text("proposed_email"),
		deletion_subject_id: uuid("deletion_subject_id"),
		request_revision: integer("request_revision"),
		expires_at: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
		consumed_at: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
		superseded_at: timestamp("superseded_at", { withTimezone: true, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "identity_proof_fk_0", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "identity_proof_fk_1",
			columns: [table.deletion_subject_id],
			foreignColumns: [lifecycle_witness.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "identity_proof_pkey", columns: [table.id] }),
		unique("identity_proof_uq_0").on(table.id, table.account_id),
		unique("identity_proof_uq_1").on(table.token_hash),
		check("identity_proof_ck_0", sql`(purpose = ANY (ARRAY['email_change'::text, 'deletion_cancel'::text]))`),
		check("identity_proof_ck_1", sql`((purpose = 'email_change'::text) = (proposed_email IS NOT NULL))`),
		check("identity_proof_ck_2", sql`((purpose = 'deletion_cancel'::text) = (deletion_subject_id IS NOT NULL))`),
		index("identity_proof_ref_1").using("btree", table.deletion_subject_id.asc().nullsLast()),
		uniqueIndex("identity_proof_uq_2")
			.using("btree", table.account_id.asc().nullsLast(), table.purpose.asc().nullsLast())
			.where(sql`((consumed_at IS NULL) AND (superseded_at IS NULL))`),
	],
);
export const interview = pgTable(
	"interview",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		person_id: uuid("person_id").notNull(),
		interviewed_on: date("interviewed_on", { mode: "string" }).notNull(),
		recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
		maturity: text("maturity", { enum: ["pass", "fail", "concern"] }).notNull(),
		gifted: text("gifted", { enum: ["pass", "fail", "concern"] }).notNull(),
		chemistry: text("chemistry", { enum: ["pass", "fail", "concern"] }).notNull(),
		right_reasons: text("right_reasons", { enum: ["pass", "fail", "concern"] }).notNull(),
		season: text("season", { enum: ["pass", "fail", "concern"] }).notNull(),
		maturity_notes: text("maturity_notes"),
		gifted_notes: text("gifted_notes"),
		chemistry_notes: text("chemistry_notes"),
		right_reasons_notes: text("right_reasons_notes"),
		season_notes: text("season_notes"),
		result: text("result", { enum: ["qualified", "qualified_with_notes", "not_qualified", "follow_up"] }).notNull(),
		next_steps: text("next_steps"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "interview_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "interview_fk_1",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "interview_fk_2",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "interview_pkey", columns: [table.id] }),
		unique("interview_uq_0").on(table.id, table.plant_id),
		check("interview_ck_0", sql`(revision >= 1)`),
		check("interview_ck_1", sql`(maturity = ANY (ARRAY['pass'::text, 'fail'::text, 'concern'::text]))`),
		check("interview_ck_2", sql`(gifted = ANY (ARRAY['pass'::text, 'fail'::text, 'concern'::text]))`),
		check("interview_ck_3", sql`(chemistry = ANY (ARRAY['pass'::text, 'fail'::text, 'concern'::text]))`),
		check("interview_ck_4", sql`(right_reasons = ANY (ARRAY['pass'::text, 'fail'::text, 'concern'::text]))`),
		check("interview_ck_5", sql`(season = ANY (ARRAY['pass'::text, 'fail'::text, 'concern'::text]))`),
		check(
			"interview_ck_6",
			sql`(result = ANY (ARRAY['qualified'::text, 'qualified_with_notes'::text, 'not_qualified'::text, 'follow_up'::text]))`,
		),
		index("interview_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("interview_ref_1").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
	],
);
export const invitation = pgTable(
	"invitation",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		purpose: text("purpose", {
			enum: [
				"seat",
				"plant_church",
				"plant_network",
				"church_network",
				"discovery_church",
				"discovery_network",
				"residency_link",
			],
		}).notNull(),
		recipient_email: text("recipient_email").notNull(),
		inviter_id: uuid("inviter_id"),
		role: text("role", { enum: ["admin", "member"] }),
		token_hash: text("token_hash").notNull(),
		state: text("state", { enum: ["pending", "accepted", "declined", "expired", "revoked"] }).notNull(),
		created_at: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		resent_at: timestamp("resent_at", { withTimezone: true, mode: "date" }),
		acted_at: timestamp("acted_at", { withTimezone: true, mode: "date" }),
		accepted_account_id: uuid("accepted_account_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
		resident_person_id: uuid("resident_person_id"),
		inviter_description: text("inviter_description").notNull().default("EveryField invitation"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "invitation_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "invitation_fk_1", columns: [table.inviter_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "invitation_fk_2", columns: [table.accepted_account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "invitation_fk_3",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "invitation_fk_4",
			columns: [table.resident_person_id, table.tenant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "invitation_pkey", columns: [table.id] }),
		unique("invitation_uq_0").on(table.token_hash),
		unique("invitation_uq_2").on(table.id, table.tenant_id),
		check("invitation_ck_0", sql`(revision >= 1)`),
		check(
			"invitation_ck_1",
			sql`(purpose = ANY (ARRAY['seat'::text, 'plant_church'::text, 'plant_network'::text, 'church_network'::text, 'discovery_church'::text, 'discovery_network'::text, 'residency_link'::text]))`,
		),
		check(
			"invitation_ck_2",
			sql`(state = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'expired'::text, 'revoked'::text]))`,
		),
		check("invitation_ck_3", sql`(role = ANY (ARRAY['admin'::text, 'member'::text]))`),
		check("invitation_ck_4", sql`((purpose = 'seat'::text) = (role IS NOT NULL))`),
		check("invitation_ck_5", sql`(tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		check("invitation_ck_6", sql`((purpose = 'residency_link'::text) = (resident_person_id IS NOT NULL))`),
		index("invitation_ref_1").using("btree", table.inviter_id.asc().nullsLast()),
		index("invitation_ref_2").using("btree", table.accepted_account_id.asc().nullsLast()),
		index("invitation_ref_4").using(
			"btree",
			table.resident_person_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
		uniqueIndex("invitation_uq_1")
			.using("btree", table.tenant_id.asc().nullsLast(), table.recipient_email.asc().nullsLast())
			.where(sql`(state = 'pending'::text)`),
	],
);
export const job = pgTable(
	"job",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		kind: text("kind", {
			enum: [
				"mail",
				"notification",
				"digest",
				"assessment",
				"reference_generation",
				"feedback_publication",
				"object_cleanup",
				"lifecycle_purge",
				"assistant_turn",
				"document_render",
			],
		}).notNull(),
		subject_record_id: uuid("subject_record_id"),
		producer_key: text("producer_key").notNull(),
		source_revision: int64("source_revision"),
		state: text("state", {
			enum: ["ready", "claimed", "retry_wait", "reconcile", "succeeded", "failed", "cancelled", "superseded"],
		}).notNull(),
		eligible_at: timestamp("eligible_at", { withTimezone: true, mode: "date" }).notNull(),
		attempt_count: integer("attempt_count").notNull(),
		max_attempts: integer("max_attempts").notNull(),
		lease_owner: text("lease_owner"),
		lease_until: timestamp("lease_until", { withTimezone: true, mode: "date" }),
		claim_generation: int64("claim_generation").notNull(),
		checkpoint_key: text("checkpoint_key"),
		next_attempt_at: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
		error_code: text("error_code"),
		finished_at: timestamp("finished_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "job_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "job_fk_1", columns: [table.subject_record_id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "job_fk_2",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "job_pkey", columns: [table.id] }),
		unique("job_uq_0").on(table.kind, table.subject_record_id, table.producer_key),
		unique("job_uq_2").on(table.id, table.tenant_id),
		check("job_ck_0", sql`(revision >= 1)`),
		check(
			"job_ck_1",
			sql`(kind = ANY (ARRAY['mail'::text, 'notification'::text, 'digest'::text, 'assessment'::text, 'reference_generation'::text, 'feedback_publication'::text, 'object_cleanup'::text, 'lifecycle_purge'::text, 'assistant_turn'::text, 'document_render'::text]))`,
		),
		check(
			"job_ck_2",
			sql`(state = ANY (ARRAY['ready'::text, 'claimed'::text, 'retry_wait'::text, 'reconcile'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text]))`,
		),
		check("job_ck_3", sql`((attempt_count >= 0) AND (max_attempts >= 1))`),
		check("job_ck_4", sql`(claim_generation >= 0)`),
		check("job_ck_5", sql`((lease_owner IS NULL) = (lease_until IS NULL))`),
		check("job_ck_6", sql`((subject_record_id IS NOT NULL) OR (producer_key = 'sweep'::text))`),
		check(
			"job_ck_7",
			sql`((tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid) OR (kind = ANY (ARRAY['mail'::text, 'reference_generation'::text, 'feedback_publication'::text, 'object_cleanup'::text, 'lifecycle_purge'::text])))`,
		),
		index("job_ref_1").using("btree", table.subject_record_id.asc().nullsLast()),
		uniqueIndex("job_uq_1")
			.using("btree", table.tenant_id.asc().nullsLast(), table.kind.asc().nullsLast())
			.where(sql`(producer_key = 'sweep'::text)`),
	],
);
export const launch = pgTable(
	"launch",
	{
		plant_id: uuid("plant_id").notNull(),
		target_date: date("target_date", { mode: "string" }),
		actual_date: date("actual_date", { mode: "string" }),
		status: text("status", { enum: ["planning", "scheduled", "postponed", "completed"] }).notNull(),
		attendance: integer("attendance"),
		decisions: integer("decisions"),
		outcome_notes: text("outcome_notes"),
		outcome_recorded_at: timestamp("outcome_recorded_at", { withTimezone: true, mode: "date" }),
		reference_version_id: uuid("reference_version_id"),
		summary_document_id: uuid("summary_document_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "launch_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "launch_fk_1", columns: [table.reference_version_id], foreignColumns: [reference_version.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "launch_fk_2",
			columns: [table.summary_document_id, table.plant_id],
			foreignColumns: [document.id, document.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "launch_pkey", columns: [table.plant_id] }),
		check("launch_ck_0", sql`(revision >= 1)`),
		check(
			"launch_ck_1",
			sql`(status = ANY (ARRAY['planning'::text, 'scheduled'::text, 'postponed'::text, 'completed'::text]))`,
		),
		check("launch_ck_2", sql`((attendance IS NULL) OR ((attendance >= 0) AND (attendance <= 1000000)))`),
		check("launch_ck_3", sql`((decisions IS NULL) OR ((decisions >= 0) AND (decisions <= 1000000)))`),
		check("launch_ck_4", sql`((status <> 'postponed'::text) OR (target_date IS NULL))`),
		index("launch_ref_1").using("btree", table.reference_version_id.asc().nullsLast()),
		index("launch_ref_2").using("btree", table.summary_document_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
	],
);
export const launch_debrief = pgTable(
	"launch_debrief",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		form_version_id: uuid("form_version_id").notNull(),
		version_number: integer("version_number").notNull(),
		submitted_at: timestamp("submitted_at", { withTimezone: true, mode: "date" }),
		what_went_well: text("what_went_well"),
		what_to_change: text("what_to_change"),
		welcoming: text("welcoming"),
		children: text("children"),
		worship: text("worship"),
		logistics: text("logistics"),
		guest_follow_up: text("guest_follow_up"),
		operational_support: text("operational_support"),
		missing_names: text("missing_names", { enum: ["no", "yes"] }),
		missing_count: integer("missing_count"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "launch_debrief_fk_0",
			columns: [table.form_version_id],
			foreignColumns: [reference_version.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "launch_debrief_fk_1",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "launch_debrief_fk_2", columns: [table.plant_id], foreignColumns: [launch.plant_id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "launch_debrief_pkey", columns: [table.id] }),
		unique("launch_debrief_uq_0").on(table.id, table.plant_id),
		unique("launch_debrief_uq_1").on(table.plant_id, table.version_number),
		check("launch_debrief_ck_0", sql`(revision >= 1)`),
		check("launch_debrief_ck_1", sql`(missing_names = ANY (ARRAY['no'::text, 'yes'::text]))`),
		check(
			"launch_debrief_ck_2",
			sql`(((missing_names = 'yes'::text) AND (missing_count > 0)) OR ((missing_names IS DISTINCT FROM 'yes'::text) AND (missing_count IS NULL)))`,
		),
		index("launch_debrief_ref_0").using("btree", table.form_version_id.asc().nullsLast()),
		uniqueIndex("launch_debrief_uq_2")
			.using("btree", table.plant_id.asc().nullsLast())
			.where(sql`(submitted_at IS NULL)`),
	],
);
export const launch_guest = pgTable(
	"launch_guest",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		person_id: uuid("person_id").notNull(),
		kind: text("kind", { enum: ["first_time", "returning", "core_group", "launch_team", "other"] }).notNull(),
		recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
		notes: text("notes"),
		voided_at: timestamp("voided_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "launch_guest_fk_0",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "launch_guest_fk_1",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "launch_guest_fk_2", columns: [table.plant_id], foreignColumns: [launch.plant_id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "launch_guest_pkey", columns: [table.id] }),
		unique("launch_guest_uq_0").on(table.id, table.plant_id),
		check("launch_guest_ck_0", sql`(revision >= 1)`),
		check(
			"launch_guest_ck_1",
			sql`(kind = ANY (ARRAY['first_time'::text, 'returning'::text, 'core_group'::text, 'launch_team'::text, 'other'::text]))`,
		),
		index("launch_guest_ref_0").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		uniqueIndex("launch_guest_uq_1")
			.using("btree", table.plant_id.asc().nullsLast(), table.person_id.asc().nullsLast())
			.where(sql`(voided_at IS NULL)`),
	],
);
export const launch_milestone = pgTable(
	"launch_milestone",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		source_version_id: uuid("source_version_id").notNull(),
		seed_key: text("seed_key").notNull(),
		title: text("title").notNull(),
		description: text("description"),
		area: text("area").notNull(),
		position: integer("position").notNull(),
		completed_at: timestamp("completed_at", { withTimezone: true, mode: "date" }),
		removed_at: timestamp("removed_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "launch_milestone_fk_0",
			columns: [table.source_version_id],
			foreignColumns: [reference_version.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "launch_milestone_fk_1",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "launch_milestone_fk_2", columns: [table.plant_id], foreignColumns: [launch.plant_id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "launch_milestone_pkey", columns: [table.id] }),
		unique("launch_milestone_uq_0").on(table.id, table.plant_id),
		unique("launch_milestone_uq_1").on(table.plant_id, table.seed_key),
		check("launch_milestone_ck_0", sql`(revision >= 1)`),
		index("launch_milestone_ref_0").using("btree", table.source_version_id.asc().nullsLast()),
	],
);
export const leadership_conversation = pgTable(
	"leadership_conversation",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		person_id: uuid("person_id").notNull(),
		staff_account_id: uuid("staff_account_id"),
		occurred_at: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
		note: text("note"),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "leadership_conversation_fk_0",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "leadership_conversation_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "leadership_conversation_fk_2",
			columns: [table.person_id, table.organization_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "leadership_conversation_fk_3",
			columns: [table.staff_account_id],
			foreignColumns: [account.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "leadership_conversation_pkey", columns: [table.id] }),
		unique("leadership_conversation_uq_0").on(table.id, table.organization_id),
		check("leadership_conversation_ck_0", sql`(revision >= 1)`),
		index("leadership_conversation_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("leadership_conversation_ref_2").using(
			"btree",
			table.person_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("leadership_conversation_ref_3").using("btree", table.staff_account_id.asc().nullsLast()),
	],
);
export const lifecycle_witness = pgTable(
	"lifecycle_witness",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		kind: text("kind", { enum: ["account", "plant", "seat", "affiliation"] }).notNull(),
		opaque_subject_id: uuid("opaque_subject_id").notNull(),
		account_id: uuid("account_id"),
		plant_id: uuid("plant_id"),
		request_id: uuid("request_id"),
		requester_id: uuid("requester_id"),
		request_revision: int64("request_revision").notNull(),
		state: text("state", {
			enum: ["active", "pending_deletion", "purging", "purged", "cancelled", "revoked"],
		}).notNull(),
		requested_at: timestamp("requested_at", { withTimezone: true, mode: "date" }),
		live_purged_at: timestamp("live_purged_at", { withTimezone: true, mode: "date" }),
		copy_expires_at: timestamp("copy_expires_at", { withTimezone: true, mode: "date" }),
		witness_checkpoint: int64("witness_checkpoint").notNull(),
		byte_manifest_hash: text("byte_manifest_hash"),
		cancellation_manifest_hash: text("cancellation_manifest_hash"),
		cleanup_state: text("cleanup_state", {
			enum: ["not_started", "in_progress", "inaccessible", "confirmed"],
		}).notNull(),
		seat_id: uuid("seat_id"),
		affiliation_id: uuid("affiliation_id"),
		requester_opaque_id: uuid("requester_opaque_id"),
		counterparty_organization_id: uuid("counterparty_organization_id"),
		cancel_until: timestamp("cancel_until", { withTimezone: true, mode: "date" }),
		cancelled_at: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "lifecycle_witness_fk_0", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "lifecycle_witness_fk_1", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "lifecycle_witness_fk_2", columns: [table.requester_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "lifecycle_witness_fk_3", columns: [table.seat_id], foreignColumns: [seat.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "lifecycle_witness_fk_4", columns: [table.affiliation_id], foreignColumns: [affiliation.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "lifecycle_witness_fk_5",
			columns: [table.counterparty_organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "lifecycle_witness_fk_6", columns: [table.id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "lifecycle_witness_pkey", columns: [table.id] }),
		unique("lifecycle_witness_uq_0").on(table.kind, table.opaque_subject_id),
		check(
			"lifecycle_witness_ck_0",
			sql`(cleanup_state = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'inaccessible'::text, 'confirmed'::text]))`,
		),
		check("lifecycle_witness_ck_1", sql`((plant_id IS NULL) OR (kind = 'plant'::text))`),
		check(
			"lifecycle_witness_ck_10",
			sql`((kind = ANY (ARRAY['account'::text, 'plant'::text])) OR (state = ANY (ARRAY['active'::text, 'revoked'::text])))`,
		),
		check(
			"lifecycle_witness_ck_11",
			sql`((state <> ALL (ARRAY['pending_deletion'::text, 'purging'::text, 'purged'::text, 'cancelled'::text])) OR ((request_id IS NOT NULL) AND (requested_at IS NOT NULL) AND (cancel_until IS NOT NULL) AND (request_revision >= 1)))`,
		),
		check(
			"lifecycle_witness_ck_12",
			sql`((cancel_until IS NULL) OR ((requested_at IS NOT NULL) AND (cancel_until = (requested_at + '720:00:00'::interval))))`,
		),
		check("lifecycle_witness_ck_13", sql`((state = 'cancelled'::text) = (cancelled_at IS NOT NULL))`),
		check(
			"lifecycle_witness_ck_14",
			sql`((cancelled_at IS NULL) OR ((cancelled_at >= requested_at) AND (cancelled_at < cancel_until)))`,
		),
		check("lifecycle_witness_ck_15", sql`((state = 'purged'::text) = (live_purged_at IS NOT NULL))`),
		check(
			"lifecycle_witness_ck_16",
			sql`((state <> 'purged'::text) OR ((live_purged_at >= cancel_until) AND (copy_expires_at IS NOT NULL)))`,
		),
		check(
			"lifecycle_witness_ck_17",
			sql`((copy_expires_at IS NULL) OR ((live_purged_at IS NOT NULL) AND (copy_expires_at >= live_purged_at)))`,
		),
		check(
			"lifecycle_witness_ck_2",
			sql`((copy_expires_at IS NULL) OR (copy_expires_at <= (live_purged_at + '168:00:00'::interval)))`,
		),
		check(
			"lifecycle_witness_ck_3",
			sql`(kind = ANY (ARRAY['account'::text, 'plant'::text, 'seat'::text, 'affiliation'::text]))`,
		),
		check(
			"lifecycle_witness_ck_4",
			sql`(state = ANY (ARRAY['active'::text, 'pending_deletion'::text, 'purging'::text, 'purged'::text, 'cancelled'::text, 'revoked'::text]))`,
		),
		check("lifecycle_witness_ck_5", sql`(num_nonnulls(account_id, plant_id, seat_id, affiliation_id) <= 1)`),
		check("lifecycle_witness_ck_6", sql`((account_id IS NULL) OR (kind = 'account'::text))`),
		check("lifecycle_witness_ck_7", sql`((seat_id IS NULL) OR (kind = 'seat'::text))`),
		check("lifecycle_witness_ck_8", sql`((affiliation_id IS NULL) OR (kind = 'affiliation'::text))`),
		check(
			"lifecycle_witness_ck_9",
			sql`((kind <> ALL (ARRAY['account'::text, 'plant'::text])) OR (state = ANY (ARRAY['active'::text, 'pending_deletion'::text, 'purging'::text, 'purged'::text, 'cancelled'::text])))`,
		),
		index("lifecycle_witness_ref_0").using("btree", table.account_id.asc().nullsLast()),
		index("lifecycle_witness_ref_1").using("btree", table.plant_id.asc().nullsLast()),
		index("lifecycle_witness_ref_2").using("btree", table.requester_id.asc().nullsLast()),
		index("lifecycle_witness_ref_3").using("btree", table.seat_id.asc().nullsLast()),
		index("lifecycle_witness_ref_4").using("btree", table.affiliation_id.asc().nullsLast()),
		index("lifecycle_witness_ref_5").using("btree", table.counterparty_organization_id.asc().nullsLast()),
	],
);
export const mail = pgTable(
	"mail",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		recipient_account_id: uuid("recipient_account_id"),
		recipient_person_id: uuid("recipient_person_id"),
		recipient_address_encrypted: text("recipient_address_encrypted"),
		purpose: text("purpose", {
			enum: [
				"communication",
				"discovery_receipt",
				"email_change",
				"email_verification",
				"notification",
				"oversight_digest",
				"password_reset",
				"planter_digest",
				"relationship_invitation",
				"relationship_receipt",
				"seat_invitation",
			],
		}).notNull(),
		logical_key: text("logical_key").notNull(),
		operation_id: uuid("operation_id"),
		notice_id: uuid("notice_id"),
		payload_hash: text("payload_hash").notNull(),
		audience_hash: text("audience_hash").notNull(),
		frozen_payload: jsonb("frozen_payload"),
		scheduled_at: timestamp("scheduled_at", { withTimezone: true, mode: "date" }),
		state: text("state", {
			enum: ["pending", "dispatched", "unknown", "refused", "accepted", "scheduled", "sent", "cancelled", "failed"],
		}).notNull(),
		provider_message_id: text("provider_message_id"),
		accepted_at: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
		sent_at: timestamp("sent_at", { withTimezone: true, mode: "date" }),
		delivered_at: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
		bounced_at: timestamp("bounced_at", { withTimezone: true, mode: "date" }),
		complained_at: timestamp("complained_at", { withTimezone: true, mode: "date" }),
		opened_at: timestamp("opened_at", { withTimezone: true, mode: "date" }),
		clicked_at: timestamp("clicked_at", { withTimezone: true, mode: "date" }),
		cancel_requested_at: timestamp("cancel_requested_at", { withTimezone: true, mode: "date" }),
		cancel_confirmed_at: timestamp("cancel_confirmed_at", { withTimezone: true, mode: "date" }),
		job_id: uuid("job_id"),
		original_mail_id: uuid("original_mail_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
		created_at: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		address_hash: text("address_hash"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "mail_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "mail_fk_1", columns: [table.recipient_account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "mail_fk_2",
			columns: [table.recipient_person_id, table.tenant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "mail_fk_3",
			columns: [table.operation_id, table.tenant_id],
			foreignColumns: [audit_event.id, audit_event.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "mail_fk_4",
			columns: [table.notice_id, table.tenant_id],
			foreignColumns: [notice.id, notice.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "mail_fk_5", columns: [table.job_id, table.tenant_id], foreignColumns: [job.id, job.tenant_id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "mail_fk_6",
			columns: [table.original_mail_id, table.tenant_id],
			foreignColumns: [mail.id, mail.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "mail_fk_7",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "mail_pkey", columns: [table.id] }),
		unique("mail_uq_0").on(table.tenant_id, table.logical_key),
		unique("mail_uq_1").on(table.id, table.tenant_id),
		check("mail_ck_0", sql`(revision >= 1)`),
		check("mail_ck_1", sql`(num_nonnulls(recipient_account_id, recipient_person_id) <= 1)`),
		check(
			"mail_ck_2",
			sql`(state = ANY (ARRAY['pending'::text, 'dispatched'::text, 'unknown'::text, 'refused'::text, 'accepted'::text, 'scheduled'::text, 'sent'::text, 'cancelled'::text, 'failed'::text]))`,
		),
		check("mail_ck_3", sql`((frozen_payload IS NULL) = (recipient_address_encrypted IS NULL))`),
		check(
			"mail_ck_4",
			sql`((frozen_payload IS NOT NULL) OR (state = ANY (ARRAY['unknown'::text, 'refused'::text, 'accepted'::text, 'scheduled'::text, 'sent'::text, 'cancelled'::text, 'failed'::text])))`,
		),
		check("mail_ck_5", sql`((frozen_payload IS NULL) = (address_hash IS NULL))`),
		check(
			"mail_ck_6",
			sql`(purpose = ANY (ARRAY['communication'::text, 'discovery_receipt'::text, 'email_change'::text, 'email_verification'::text, 'notification'::text, 'oversight_digest'::text, 'password_reset'::text, 'planter_digest'::text, 'relationship_invitation'::text, 'relationship_receipt'::text, 'seat_invitation'::text]))`,
		),
		check("mail_ck_7", sql`((tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid) OR (frozen_payload IS NULL))`),
		index("mail_ref_1").using("btree", table.recipient_account_id.asc().nullsLast()),
		index("mail_ref_2").using("btree", table.recipient_person_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
		index("mail_ref_3").using("btree", table.operation_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
		index("mail_ref_4").using("btree", table.notice_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
		index("mail_ref_5").using("btree", table.job_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
		index("mail_ref_6").using("btree", table.original_mail_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
	],
);
export const mail_attempt = pgTable(
	"mail_attempt",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		request_id: uuid("request_id").notNull(),
		attempt_number: integer("attempt_number").notNull(),
		claim_generation: int64("claim_generation").notNull(),
		started_at: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull(),
		completed_at: timestamp("completed_at", { withTimezone: true, mode: "date" }),
		outcome: text("outcome", { enum: ["in_flight", "accepted", "refused", "partial", "unknown"] }).notNull(),
		safe_error: text("safe_error"),
		retry_at: timestamp("retry_at", { withTimezone: true, mode: "date" }),
		retryable: boolean("retryable"),
		provider_payload: jsonb("provider_payload"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "mail_attempt_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "mail_attempt_fk_1",
			columns: [table.request_id, table.tenant_id],
			foreignColumns: [mail_request.id, mail_request.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "mail_attempt_fk_2",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "mail_attempt_pkey", columns: [table.id] }),
		unique("mail_attempt_uq_0").on(table.request_id, table.attempt_number),
		unique("mail_attempt_uq_1").on(table.id, table.request_id),
		unique("mail_attempt_uq_2").on(table.id, table.tenant_id),
		unique("mail_attempt_uq_3").on(table.id, table.request_id, table.tenant_id),
		check(
			"mail_attempt_ck_0",
			sql`(outcome = ANY (ARRAY['in_flight'::text, 'accepted'::text, 'refused'::text, 'partial'::text, 'unknown'::text]))`,
		),
		index("mail_attempt_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
		index("mail_attempt_ref_1").using("btree", table.request_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
	],
);
export const mail_request = pgTable(
	"mail_request",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		provider_key: text("provider_key").notNull(),
		request_hash: text("request_hash").notNull(),
		first_dispatched_at: timestamp("first_dispatched_at", { withTimezone: true, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "mail_request_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "mail_request_fk_1",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "mail_request_pkey", columns: [table.id] }),
		unique("mail_request_uq_0").on(table.provider_key),
		unique("mail_request_uq_1").on(table.id, table.tenant_id),
		index("mail_request_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
	],
);
export const mail_request_member = pgTable(
	"mail_request_member",
	{
		request_id: uuid("request_id").notNull(),
		tenant_id: uuid("tenant_id").notNull(),
		mail_id: uuid("mail_id").notNull(),
		position: integer("position").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "mail_request_member_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "mail_request_member_fk_1",
			columns: [table.request_id, table.tenant_id],
			foreignColumns: [mail_request.id, mail_request.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "mail_request_member_fk_2",
			columns: [table.mail_id, table.tenant_id],
			foreignColumns: [mail.id, mail.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "mail_request_member_pkey", columns: [table.request_id, table.position] }),
		unique("mail_request_member_uq_0").on(table.request_id, table.mail_id),
		unique("mail_request_member_uq_1").on(table.request_id, table.position, table.tenant_id),
		check("mail_request_member_ck_0", sql`(("position" >= 0) AND ("position" <= 99))`),
		index("mail_request_member_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
		index("mail_request_member_ref_1").using(
			"btree",
			table.request_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
		index("mail_request_member_ref_2").using(
			"btree",
			table.mail_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
	],
);
export const meeting = pgTable(
	"meeting",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		type: text("type", { enum: ["vision_meeting", "orientation", "team_meeting", "prelaunch_practice"] }).notNull(),
		subtype: text("subtype", { enum: ["regular", "training", "planning", "special", "rehearsal"] }),
		title: text("title").notNull(),
		notes: text("notes"),
		creator_id: uuid("creator_id"),
		local_date: date("local_date", { mode: "string" }).notNull(),
		local_time: time("local_time").notNull(),
		timezone: text("timezone").notNull(),
		starts_at: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
		resolver_version: text("resolver_version").notNull(),
		actual_occurrence_at: timestamp("actual_occurrence_at", { withTimezone: true, mode: "date" }),
		occurrence_voided_at: timestamp("occurrence_voided_at", { withTimezone: true, mode: "date" }),
		team_id: uuid("team_id"),
		venue_id: uuid("venue_id"),
		venue_name: text("venue_name"),
		venue_address: text("venue_address"),
		vision_number: integer("vision_number"),
		reference_version_id: uuid("reference_version_id"),
		status: text("status", { enum: ["planning", "ready", "in_progress", "completed", "cancelled"] }).notNull(),
		attendance_revision: int64("attendance_revision").notNull(),
		finalized_revision: int64("finalized_revision"),
		finalized_at: timestamp("finalized_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "meeting_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "meeting_fk_1", columns: [table.creator_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "meeting_fk_2",
			columns: [table.team_id, table.plant_id],
			foreignColumns: [team.id, team.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "meeting_fk_3",
			columns: [table.venue_id, table.plant_id],
			foreignColumns: [venue.id, venue.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "meeting_fk_4", columns: [table.reference_version_id], foreignColumns: [reference_version.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "meeting_fk_5",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "meeting_pkey", columns: [table.id] }),
		unique("meeting_uq_0").on(table.id, table.plant_id),
		check("meeting_ck_0", sql`(revision >= 1)`),
		check(
			"meeting_ck_1",
			sql`(type = ANY (ARRAY['vision_meeting'::text, 'orientation'::text, 'team_meeting'::text, 'prelaunch_practice'::text]))`,
		),
		check(
			"meeting_ck_2",
			sql`(subtype = ANY (ARRAY['regular'::text, 'training'::text, 'planning'::text, 'special'::text, 'rehearsal'::text]))`,
		),
		check(
			"meeting_ck_3",
			sql`(status = ANY (ARRAY['planning'::text, 'ready'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text]))`,
		),
		check("meeting_ck_4", sql`((type = 'team_meeting'::text) = (team_id IS NOT NULL))`),
		check("meeting_ck_5", sql`((type = 'vision_meeting'::text) OR (vision_number IS NULL))`),
		check(
			"meeting_ck_6",
			sql`((type <> 'prelaunch_practice'::text) OR (status <> 'completed'::text) OR (actual_occurrence_at IS NOT NULL))`,
		),
		check("meeting_timezone_iana", sql`(timezone = ANY (${canonicalZones7}))`),
		index("meeting_ref_1").using("btree", table.creator_id.asc().nullsLast()),
		index("meeting_ref_2").using("btree", table.team_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("meeting_ref_3").using("btree", table.venue_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("meeting_ref_4").using("btree", table.reference_version_id.asc().nullsLast()),
		uniqueIndex("meeting_uq_1")
			.using("btree", table.plant_id.asc().nullsLast(), table.vision_number.asc().nullsLast())
			.where(sql`(vision_number IS NOT NULL)`),
	],
);
export const meeting_evaluation = pgTable(
	"meeting_evaluation",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		meeting_id: uuid("meeting_id").notNull(),
		evaluated_on: date("evaluated_on", { mode: "string" }).notNull(),
		recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
		reference_version_id: uuid("reference_version_id").notNull(),
		attendance: integer("attendance").notNull(),
		location: integer("location").notNull(),
		logistics: integer("logistics").notNull(),
		agenda: integer("agenda").notNull(),
		vibe: integer("vibe").notNull(),
		message: integer("message").notNull(),
		close: integer("close").notNull(),
		next_steps: integer("next_steps").notNull(),
		notes: text("notes"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "meeting_evaluation_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "meeting_evaluation_fk_1",
			columns: [table.meeting_id, table.plant_id],
			foreignColumns: [meeting.id, meeting.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "meeting_evaluation_fk_2",
			columns: [table.reference_version_id],
			foreignColumns: [reference_version.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "meeting_evaluation_fk_3",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "meeting_evaluation_pkey", columns: [table.id] }),
		unique("meeting_evaluation_uq_0").on(table.id, table.plant_id),
		unique("meeting_evaluation_uq_1").on(table.meeting_id),
		check("meeting_evaluation_ck_0", sql`(revision >= 1)`),
		check("meeting_evaluation_ck_1", sql`((attendance >= 1) AND (attendance <= 5))`),
		check("meeting_evaluation_ck_2", sql`((location >= 1) AND (location <= 5))`),
		check("meeting_evaluation_ck_3", sql`((logistics >= 1) AND (logistics <= 5))`),
		check("meeting_evaluation_ck_4", sql`((agenda >= 1) AND (agenda <= 5))`),
		check("meeting_evaluation_ck_5", sql`((vibe >= 1) AND (vibe <= 5))`),
		check("meeting_evaluation_ck_6", sql`((message >= 1) AND (message <= 5))`),
		check("meeting_evaluation_ck_7", sql`((close >= 1) AND (close <= 5))`),
		check("meeting_evaluation_ck_8", sql`((next_steps >= 1) AND (next_steps <= 5))`),
		index("meeting_evaluation_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("meeting_evaluation_ref_1").using(
			"btree",
			table.meeting_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("meeting_evaluation_ref_2").using("btree", table.reference_version_id.asc().nullsLast()),
	],
);
export const meeting_item = pgTable(
	"meeting_item",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		meeting_id: uuid("meeting_id").notNull(),
		kind: text("kind", { enum: ["agenda", "kit"] }).notNull(),
		source_key: text("source_key"),
		position: integer("position").notNull(),
		title: text("title").notNull(),
		duration_minutes: integer("duration_minutes"),
		category: text("category", { enum: ["essential", "materials", "setup", "av", "organization"] }),
		assigned_person_id: uuid("assigned_person_id"),
		checked: boolean("checked"),
		notes: text("notes"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "meeting_item_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "meeting_item_fk_1",
			columns: [table.meeting_id, table.plant_id],
			foreignColumns: [meeting.id, meeting.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "meeting_item_fk_2",
			columns: [table.assigned_person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "meeting_item_fk_3",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "meeting_item_pkey", columns: [table.id] }),
		unique("meeting_item_uq_0").on(table.id, table.plant_id),
		unique("meeting_item_uq_1").on(table.meeting_id, table.kind, table.position),
		check("meeting_item_ck_0", sql`(revision >= 1)`),
		check("meeting_item_ck_1", sql`(kind = ANY (ARRAY['agenda'::text, 'kit'::text]))`),
		check(
			"meeting_item_ck_2",
			sql`(category = ANY (ARRAY['essential'::text, 'materials'::text, 'setup'::text, 'av'::text, 'organization'::text]))`,
		),
		check(
			"meeting_item_ck_3",
			sql`(((kind = 'agenda'::text) AND ((duration_minutes >= 0) AND (duration_minutes <= 600)) AND (category IS NULL) AND (checked IS NULL) AND (assigned_person_id IS NULL)) OR ((kind = 'kit'::text) AND (duration_minutes IS NULL) AND (category IS NOT NULL) AND (checked IS NOT NULL)))`,
		),
		check("meeting_item_ck_4", sql`((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 120))`),
		index("meeting_item_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("meeting_item_ref_1").using("btree", table.meeting_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("meeting_item_ref_2").using(
			"btree",
			table.assigned_person_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		uniqueIndex("meeting_item_uq_2")
			.using("btree", table.meeting_id.asc().nullsLast(), table.source_key.asc().nullsLast())
			.where(sql`(source_key IS NOT NULL)`),
	],
);
export const message_template = pgTable(
	"message_template",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		source_version_id: uuid("source_version_id"),
		name: text("name").notNull(),
		description: text("description"),
		category: text("category", {
			enum: ["meeting_invitation", "meeting_reminder", "follow_up", "announcement"],
		}).notNull(),
		meeting_type: text("meeting_type", {
			enum: ["vision_meeting", "orientation", "team_meeting", "prelaunch_practice"],
		}),
		subject: text("subject").notNull(),
		body_html: text("body_html").notNull(),
		archived_at: timestamp("archived_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
		source_item_id: uuid("source_item_id"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "message_template_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "message_template_fk_1",
			columns: [table.source_version_id],
			foreignColumns: [reference_version.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "message_template_fk_2", columns: [table.source_item_id], foreignColumns: [reference_item.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "message_template_fk_3",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "message_template_pkey", columns: [table.id] }),
		unique("message_template_uq_0").on(table.id, table.plant_id),
		check("message_template_ck_0", sql`(revision >= 1)`),
		check("message_template_ck_1", sql`((length(name) >= 1) AND (length(name) <= 255))`),
		check("message_template_ck_2", sql`((length(subject) >= 1) AND (length(subject) <= 500))`),
		check(
			"message_template_ck_3",
			sql`(meeting_type = ANY (ARRAY['vision_meeting'::text, 'orientation'::text, 'team_meeting'::text, 'prelaunch_practice'::text]))`,
		),
		check(
			"message_template_ck_4",
			sql`(category = ANY (ARRAY['meeting_invitation'::text, 'meeting_reminder'::text, 'follow_up'::text, 'announcement'::text]))`,
		),
		index("message_template_ref_1").using("btree", table.source_version_id.asc().nullsLast()),
		index("message_template_ref_2").using("btree", table.source_item_id.asc().nullsLast()),
		uniqueIndex("message_template_uq_1")
			.using("btree", table.plant_id.asc().nullsLast(), table.source_item_id.asc().nullsLast())
			.where(sql`(source_item_id IS NOT NULL)`),
	],
);
export const notice = pgTable(
	"notice",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		recipient_id: uuid("recipient_id").notNull(),
		category: text("category", {
			enum: ["task", "meeting", "phase", "insight", "relationship", "reference_update", "digest", "launch"],
		}).notNull(),
		purpose: text("purpose", {
			enum: [
				"insight_available",
				"launch_milestone",
				"meeting_evaluation",
				"meeting_invitation",
				"meeting_reminder",
				"oversight_digest",
				"phase_offer",
				"phase_transition",
				"planter_digest",
				"reference_update",
				"relationship_decision",
				"relationship_invitation",
				"task_assignment",
				"task_due",
			],
		}).notNull(),
		logical_key: text("logical_key").notNull(),
		source_record_id: uuid("source_record_id").notNull(),
		source_revision: int64("source_revision").notNull(),
		title: text("title").notNull(),
		safe_body: text("safe_body"),
		eligible_at: timestamp("eligible_at", { withTimezone: true, mode: "date" }).notNull(),
		created_at: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		schedule_date: date("schedule_date", { mode: "string" }),
		schedule_time: time("schedule_time"),
		timezone: text("timezone"),
		resolver_version: text("resolver_version"),
		read_at: timestamp("read_at", { withTimezone: true, mode: "date" }),
		archived_at: timestamp("archived_at", { withTimezone: true, mode: "date" }),
		cancelled_at: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "notice_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "notice_fk_1", columns: [table.recipient_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "notice_fk_2", columns: [table.source_record_id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "notice_fk_3",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "notice_pkey", columns: [table.id] }),
		unique("notice_uq_0").on(table.recipient_id, table.logical_key),
		unique("notice_uq_1").on(table.id, table.tenant_id),
		check("notice_ck_0", sql`(revision >= 1)`),
		check(
			"notice_ck_1",
			sql`(category = ANY (ARRAY['task'::text, 'meeting'::text, 'phase'::text, 'insight'::text, 'relationship'::text, 'reference_update'::text, 'digest'::text, 'launch'::text]))`,
		),
		check(
			"notice_ck_2",
			sql`(purpose = ANY (ARRAY['insight_available'::text, 'launch_milestone'::text, 'meeting_evaluation'::text, 'meeting_invitation'::text, 'meeting_reminder'::text, 'oversight_digest'::text, 'phase_offer'::text, 'phase_transition'::text, 'planter_digest'::text, 'reference_update'::text, 'relationship_decision'::text, 'relationship_invitation'::text, 'task_assignment'::text, 'task_due'::text]))`,
		),
		check("notice_ck_3", sql`(tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		check("notice_timezone_iana", sql`(timezone = ANY (${canonicalZones7}))`),
		index("notice_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
		index("notice_ref_2").using("btree", table.source_record_id.asc().nullsLast()),
	],
);
export const notification_preference = pgTable(
	"notification_preference",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		account_id: uuid("account_id").notNull(),
		category: text("category", {
			enum: [
				"task_due",
				"task_overdue",
				"meeting_announcement",
				"meeting_reminder",
				"planter_digest",
				"oversight_digest",
				"relationship_milestone",
				"sharing_milestone",
				"phase_milestone",
				"launch_milestone",
				"wiki_upstream_review",
			],
		}).notNull(),
		channel: text("channel", { enum: ["email", "in_app"] }).notNull(),
		enabled: boolean("enabled").notNull(),
		cadence: text("cadence", { enum: ["daily", "weekly"] }),
		weekday: integer("weekday"),
		hour: integer("hour"),
		unsubscribe_revision: int64("unsubscribe_revision").notNull(),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "notification_preference_fk_0", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "notification_preference_fk_1",
			columns: [table.id, table.account_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "notification_preference_pkey", columns: [table.id] }),
		unique("notification_preference_uq_0").on(table.id, table.account_id),
		unique("notification_preference_uq_1").on(table.account_id, table.category, table.channel),
		check("notification_preference_ck_0", sql`(revision >= 1)`),
		check(
			"notification_preference_ck_1",
			sql`category IN ('task_due','task_overdue','meeting_announcement','meeting_reminder','planter_digest','oversight_digest','relationship_milestone','sharing_milestone','phase_milestone','launch_milestone','wiki_upstream_review')`,
		),
		check("notification_preference_ck_2", sql`(channel = ANY (ARRAY['email'::text, 'in_app'::text]))`),
		check("notification_preference_ck_3", sql`(cadence = ANY (ARRAY['daily'::text, 'weekly'::text]))`),
		check("notification_preference_ck_4", sql`((weekday IS NULL) OR ((weekday >= 0) AND (weekday <= 6)))`),
		check("notification_preference_ck_5", sql`((hour IS NULL) OR ((hour >= 0) AND (hour <= 23)))`),
		check(
			"notification_preference_ck_6",
			sql`((category <> 'wiki_upstream_review'::text) OR (channel = 'in_app'::text))`,
		),
	],
);
export const obligation = pgTable(
	"obligation",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		meeting_id: uuid("meeting_id").notNull(),
		person_id: uuid("person_id"),
		kind: text("kind", { enum: ["follow_up", "evaluation"] }).notNull(),
		origin_at: timestamp("origin_at", { withTimezone: true, mode: "date" }).notNull(),
		origin_date: date("origin_date", { mode: "string" }).notNull(),
		timezone: text("timezone").notNull(),
		formula_version: text("formula_version").notNull(),
		due_date: date("due_date", { mode: "string" }).notNull(),
		assignee_id: uuid("assignee_id"),
		waived_at: timestamp("waived_at", { withTimezone: true, mode: "date" }),
		waiver_reason: text("waiver_reason"),
		superseded_at: timestamp("superseded_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "obligation_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "obligation_fk_1",
			columns: [table.meeting_id, table.plant_id],
			foreignColumns: [meeting.id, meeting.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "obligation_fk_2",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "obligation_fk_3", columns: [table.assignee_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "obligation_fk_4",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "obligation_pkey", columns: [table.id] }),
		unique("obligation_uq_0").on(table.id, table.plant_id),
		check("obligation_ck_0", sql`(revision >= 1)`),
		check("obligation_ck_1", sql`(kind = ANY (ARRAY['follow_up'::text, 'evaluation'::text]))`),
		check("obligation_ck_2", sql`((kind = 'follow_up'::text) = (person_id IS NOT NULL))`),
		check("obligation_timezone_iana", sql`(timezone = ANY (${canonicalZones7}))`),
		index("obligation_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("obligation_ref_1").using("btree", table.meeting_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("obligation_ref_2").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("obligation_ref_3").using("btree", table.assignee_id.asc().nullsLast()),
		uniqueIndex("obligation_uq_1")
			.using(
				"btree",
				table.meeting_id.asc().nullsLast(),
				table.person_id.asc().nullsLast(),
				table.kind.asc().nullsLast(),
			)
			.where(sql`(person_id IS NOT NULL)`),
		uniqueIndex("obligation_uq_2")
			.using("btree", table.meeting_id.asc().nullsLast(), table.kind.asc().nullsLast())
			.where(sql`(person_id IS NULL)`),
	],
);
export const organization = pgTable(
	"organization",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		kind: text("kind", { enum: ["sending_church", "sending_network"] }).notNull(),
		name: text("name").notNull(),
		city: text("city"),
		state_province: text("state_province"),
		country: text("country"),
		timezone: text("timezone").notNull(),
		description: text("description"),
		contact_email: text("contact_email"),
		contact_phone: text("contact_phone"),
		material_revision: int64("material_revision").notNull(),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "organization_fk_0", columns: [table.id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "organization_fk_1", columns: [table.id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "organization_pkey", columns: [table.id] }),
		unique("organization_uq_0").on(table.id, table.kind),
		check("organization_ck_0", sql`(revision >= 1)`),
		check("organization_ck_1", sql`(kind = ANY (ARRAY['sending_church'::text, 'sending_network'::text]))`),
		check("organization_ck_2", sql`(length(btrim(name)) > 0)`),
		check("organization_ck_3", sql`(id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		check("organization_timezone_iana", sql`(timezone = ANY (${canonicalZones7}))`),
	],
);
export const organization_person_removal = pgTable(
	"organization_person_removal",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		person_record_id: uuid("person_record_id").notNull(),
		removed_at: timestamp("removed_at", { withTimezone: true, mode: "date" }).notNull(),
		requested_by: uuid("requested_by"),
		witness_checkpoint: int64("witness_checkpoint").notNull(),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "organization_person_removal_fk_0",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "organization_person_removal_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "organization_person_removal_fk_2",
			columns: [table.person_record_id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "organization_person_removal_fk_3",
			columns: [table.requested_by],
			foreignColumns: [account.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "organization_person_removal_pkey", columns: [table.id] }),
		unique("organization_person_removal_uq_0").on(table.id, table.organization_id),
		unique("organization_person_removal_uq_1").on(table.person_record_id, table.organization_id),
		check("organization_person_removal_ck_0", sql`(revision >= 1)`),
		check("organization_person_removal_ck_1", sql`(witness_checkpoint >= 1)`),
		index("organization_person_removal_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("organization_person_removal_ref_3").using("btree", table.requested_by.asc().nullsLast()),
	],
);
export const participation = pgTable(
	"participation",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		meeting_id: uuid("meeting_id").notNull(),
		person_id: uuid("person_id").notNull(),
		inviter_person_id: uuid("inviter_person_id"),
		roster_member: boolean("roster_member").notNull(),
		rsvp: text("rsvp", { enum: ["pending", "confirmed", "declined"] }),
		rsvp_at: timestamp("rsvp_at", { withTimezone: true, mode: "date" }),
		presence: text("presence", { enum: ["attended", "absent", "excused"] }).notNull(),
		actual_occurrence_at: timestamp("actual_occurrence_at", { withTimezone: true, mode: "date" }),
		classification: text("classification", { enum: ["first_time", "returning", "core_group"] }),
		classification_stage: text("classification_stage"),
		classification_person_revision: int64("classification_person_revision"),
		classification_as_of: timestamp("classification_as_of", { withTimezone: true, mode: "date" }),
		prior_vision_id: uuid("prior_vision_id"),
		card_response: text("card_response", {
			enum: ["ready_commit", "interested", "prayer_request", "stay_informed", "not_interested"],
		}),
		card_notes: text("card_notes"),
		card_recorded_at: timestamp("card_recorded_at", { withTimezone: true, mode: "date" }),
		card_author_id: uuid("card_author_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "participation_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "participation_fk_1",
			columns: [table.meeting_id, table.plant_id],
			foreignColumns: [meeting.id, meeting.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "participation_fk_2",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "participation_fk_3",
			columns: [table.inviter_person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "participation_fk_4",
			columns: [table.prior_vision_id, table.plant_id],
			foreignColumns: [meeting.id, meeting.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "participation_fk_5", columns: [table.card_author_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "participation_fk_6",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "participation_pkey", columns: [table.id] }),
		unique("participation_uq_0").on(table.id, table.plant_id),
		unique("participation_uq_1").on(table.meeting_id, table.person_id),
		check("participation_ck_0", sql`(revision >= 1)`),
		check("participation_ck_1", sql`(rsvp = ANY (ARRAY['pending'::text, 'confirmed'::text, 'declined'::text]))`),
		check("participation_ck_2", sql`(presence = ANY (ARRAY['attended'::text, 'absent'::text, 'excused'::text]))`),
		check(
			"participation_ck_3",
			sql`(classification = ANY (ARRAY['first_time'::text, 'returning'::text, 'core_group'::text]))`,
		),
		check(
			"participation_ck_4",
			sql`(card_response = ANY (ARRAY['ready_commit'::text, 'interested'::text, 'prayer_request'::text, 'stay_informed'::text, 'not_interested'::text]))`,
		),
		check("participation_ck_5", sql`((inviter_person_id IS NULL) OR (inviter_person_id <> person_id))`),
		check("participation_ck_6", sql`((card_response IS NULL) = (card_recorded_at IS NULL))`),
		index("participation_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("participation_ref_1").using("btree", table.meeting_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("participation_ref_2").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("participation_ref_3").using(
			"btree",
			table.inviter_person_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("participation_ref_4").using(
			"btree",
			table.prior_vision_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("participation_ref_5").using("btree", table.card_author_id.asc().nullsLast()),
	],
);
export const passage = pgTable(
	"passage",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		release_id: uuid("release_id").notNull(),
		revision_id: uuid("revision_id").notNull(),
		tenant_id: uuid("tenant_id").notNull(),
		ordinal: integer("ordinal").notNull(),
		content: text("content").notNull(),
		content_hash: text("content_hash").notNull(),
		embedding: vector("embedding").notNull(),
		embedding_checksum: text("embedding_checksum").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "passage_fk_0",
			columns: [table.release_id, table.tenant_id],
			foreignColumns: [reference_release.id, reference_release.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "passage_fk_1",
			columns: [table.revision_id, table.tenant_id],
			foreignColumns: [article_revision.id, article_revision.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "passage_fk_2", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "passage_fk_3",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "passage_pkey", columns: [table.id] }),
		unique("passage_uq_0").on(table.release_id, table.revision_id, table.ordinal),
		index("passage_ref_0").using("btree", table.release_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
		index("passage_ref_1").using("btree", table.revision_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
		index("passage_ref_2").using("btree", table.tenant_id.asc().nullsLast()),
		index("passage_ref_3").using("btree", table.id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
	],
);
export const people_column = pgTable(
	"people_column",
	{
		plant_id: uuid("plant_id").notNull(),
		column_name: text("column_name", {
			enum: ["prospect", "attendee", "following_up", "interviewed", "core_group"],
		}).notNull(),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		primaryKey({ name: "people_column_pkey", columns: [table.plant_id, table.column_name] }),
		foreignKey({ name: "people_column_plant_id_fkey", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("no action")
			.onUpdate("no action"),
		check(
			"people_column_column_name_check",
			sql`(column_name = ANY (ARRAY['prospect'::text, 'attendee'::text, 'following_up'::text, 'interviewed'::text, 'core_group'::text]))`,
		),
	],
);
export const person = pgTable(
	"person",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		plant_id: uuid("plant_id"),
		organization_id: uuid("organization_id"),
		display_name: text("display_name").notNull(),
		first_name: text("first_name"),
		last_name: text("last_name"),
		email: text("email"),
		phone: text("phone"),
		street: text("street"),
		city: text("city"),
		state_province: text("state_province"),
		postal_code: text("postal_code"),
		country: text("country"),
		source: text("source", {
			enum: [
				"personal_referral",
				"social_media",
				"vision_meeting",
				"website",
				"event",
				"partner_church",
				"meeting_guest_list",
				"other",
			],
		}).notNull(),
		source_details: text("source_details"),
		notes: text("notes"),
		created_at: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		stage: text("stage", {
			enum: ["prospect", "attendee", "following_up", "interviewed", "core_group", "launch_team", "leader"],
		}),
		adult_classification: text("adult_classification", { enum: ["adult", "child", "unknown"] }),
		birth_date: date("birth_date", { mode: "string" }),
		linked_account_id: uuid("linked_account_id"),
		household_id: uuid("household_id"),
		household_role: text("household_role", { enum: ["head", "spouse", "child", "other"] }),
		photo_object_id: uuid("photo_object_id"),
		pipeline_position: numeric("pipeline_position"),
		state: text("state", { enum: ["live", "retired", "merged"] }).notNull(),
		retired_at: timestamp("retired_at", { withTimezone: true, mode: "date" }),
		merged_into_person_id: uuid("merged_into_person_id"),
		commitment_state: text("commitment_state", { enum: ["active", "withdrawn", "unknown"] }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "person_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "person_fk_1", columns: [table.linked_account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_fk_2",
			columns: [table.household_id, table.tenant_id],
			foreignColumns: [household.id, household.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_fk_3",
			columns: [table.photo_object_id, table.tenant_id],
			foreignColumns: [file_object.id, file_object.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_fk_4",
			columns: [table.merged_into_person_id, table.tenant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_fk_5",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "person_fk_6", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "person_fk_7", columns: [table.organization_id], foreignColumns: [organization.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "person_pkey", columns: [table.id] }),
		unique("person_uq_0").on(table.id, table.plant_id),
		unique("person_uq_2").on(table.id, table.tenant_id),
		unique("person_uq_3").on(table.id, table.organization_id),
		check("person_ck_0", sql`(revision >= 1)`),
		check(
			"person_ck_1",
			sql`(stage = ANY (ARRAY['prospect'::text, 'attendee'::text, 'following_up'::text, 'interviewed'::text, 'core_group'::text, 'launch_team'::text, 'leader'::text]))`,
		),
		check("person_ck_10", sql`(num_nonnulls(plant_id, organization_id) = 1)`),
		check(
			"person_ck_11",
			sql`(((plant_id IS NOT NULL) AND (tenant_id = plant_id)) OR ((organization_id IS NOT NULL) AND (tenant_id = organization_id)))`,
		),
		check(
			"person_ck_12",
			sql`(((plant_id IS NOT NULL) AND (stage IS NOT NULL) AND (commitment_state IS NOT NULL) AND (adult_classification IS NOT NULL) AND (pipeline_position IS NOT NULL)) OR ((organization_id IS NOT NULL) AND (stage IS NULL) AND (commitment_state IS NULL) AND (adult_classification IS NULL) AND (pipeline_position IS NULL) AND (household_id IS NULL) AND (household_role IS NULL)))`,
		),
		check("person_ck_2", sql`(adult_classification = ANY (ARRAY['adult'::text, 'child'::text, 'unknown'::text]))`),
		check("person_ck_3", sql`(state = ANY (ARRAY['live'::text, 'retired'::text, 'merged'::text]))`),
		check("person_ck_4", sql`(commitment_state = ANY (ARRAY['active'::text, 'withdrawn'::text, 'unknown'::text]))`),
		check(
			"person_ck_5",
			sql`(household_role = ANY (ARRAY['head'::text, 'spouse'::text, 'child'::text, 'other'::text]))`,
		),
		check("person_ck_6", sql`((length(btrim(display_name)) >= 1) AND (length(btrim(display_name)) <= 255))`),
		check("person_ck_7", sql`((household_id IS NULL) = (household_role IS NULL))`),
		check("person_ck_8", sql`((merged_into_person_id IS NULL) OR (merged_into_person_id <> id))`),
		check(
			"person_ck_9",
			sql`(source = ANY (ARRAY['personal_referral'::text, 'social_media'::text, 'vision_meeting'::text, 'website'::text, 'event'::text, 'partner_church'::text, 'meeting_guest_list'::text, 'other'::text]))`,
		),
		index("person_ref_1").using("btree", table.linked_account_id.asc().nullsLast()),
		index("person_ref_2").using("btree", table.household_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
		index("person_ref_3").using("btree", table.photo_object_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
		index("person_ref_4").using(
			"btree",
			table.merged_into_person_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
		index("person_ref_6").using("btree", table.tenant_id.asc().nullsLast()),
		uniqueIndex("person_uq_1")
			.using("btree", table.plant_id.asc().nullsLast(), table.linked_account_id.asc().nullsLast())
			.where(sql`((state = 'live'::text) AND (linked_account_id IS NOT NULL))`),
		uniqueIndex("person_uq_4")
			.using("btree", table.organization_id.asc().nullsLast(), table.linked_account_id.asc().nullsLast())
			.where(sql`((state = 'live'::text) AND (linked_account_id IS NOT NULL))`),
	],
);
export const person_merge = pgTable(
	"person_merge",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		plant_id: uuid("plant_id"),
		source_id: uuid("source_id").notNull(),
		survivor_id: uuid("survivor_id").notNull(),
		source_revision: int64("source_revision").notNull(),
		survivor_before_revision: int64("survivor_before_revision").notNull(),
		survivor_after_revision: int64("survivor_after_revision").notNull(),
		before_values: jsonb("before_values").notNull(),
		field_choices: jsonb("field_choices").notNull(),
		operation_id: uuid("operation_id").notNull(),
		reversed_operation_id: uuid("reversed_operation_id"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "person_merge_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_merge_fk_1",
			columns: [table.source_id, table.tenant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_merge_fk_2",
			columns: [table.survivor_id, table.tenant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "person_merge_fk_3", columns: [table.operation_id], foreignColumns: [audit_event.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "person_merge_fk_4", columns: [table.reversed_operation_id], foreignColumns: [audit_event.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_merge_fk_5",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "person_merge_fk_6", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "person_merge_pkey", columns: [table.id] }),
		unique("person_merge_uq_0").on(table.id, table.plant_id),
		unique("person_merge_uq_1").on(table.operation_id),
		unique("person_merge_uq_2").on(table.id, table.tenant_id),
		check("person_merge_ck_0", sql`(source_id <> survivor_id)`),
		check("person_merge_ck_1", sql`((plant_id IS NULL) OR (tenant_id = plant_id))`),
		index("person_merge_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("person_merge_ref_1").using("btree", table.source_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
		index("person_merge_ref_2").using("btree", table.survivor_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
		index("person_merge_ref_4").using("btree", table.reversed_operation_id.asc().nullsLast()),
		index("person_merge_ref_6").using("btree", table.tenant_id.asc().nullsLast()),
	],
);
export const person_note = pgTable(
	"person_note",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		plant_id: uuid("plant_id"),
		person_id: uuid("person_id").notNull(),
		author_id: uuid("author_id"),
		participation_id: uuid("participation_id"),
		body: text("body").notNull(),
		occurred_at: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
		recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
		edited_at: timestamp("edited_at", { withTimezone: true, mode: "date" }),
		removed_at: timestamp("removed_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "person_note_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_note_fk_1",
			columns: [table.person_id, table.tenant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "person_note_fk_2", columns: [table.author_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_note_fk_3",
			columns: [table.participation_id, table.tenant_id],
			foreignColumns: [participation.id, participation.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_note_fk_4",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "person_note_fk_5", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "person_note_pkey", columns: [table.id] }),
		unique("person_note_uq_0").on(table.id, table.plant_id),
		unique("person_note_uq_1").on(table.id, table.tenant_id),
		check("person_note_ck_0", sql`(revision >= 1)`),
		check(
			"person_note_ck_1",
			sql`(((removed_at IS NULL) AND ((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 5000))) OR ((removed_at IS NOT NULL) AND (body = ''::text)))`,
		),
		check("person_note_ck_2", sql`((plant_id IS NULL) OR (tenant_id = plant_id))`),
		check("person_note_ck_3", sql`((participation_id IS NULL) OR (plant_id IS NOT NULL))`),
		index("person_note_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("person_note_ref_1").using("btree", table.person_id.asc().nullsLast(), table.tenant_id.asc().nullsLast()),
		index("person_note_ref_2").using("btree", table.author_id.asc().nullsLast()),
		index("person_note_ref_3").using(
			"btree",
			table.participation_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
		index("person_note_ref_5").using("btree", table.tenant_id.asc().nullsLast()),
	],
);
export const person_skill = pgTable(
	"person_skill",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		person_id: uuid("person_id").notNull(),
		name: text("name").notNull(),
		category: text("category", {
			enum: ["worship", "tech", "admin", "teaching", "hospitality", "leadership", "other"],
		}).notNull(),
		proficiency: text("proficiency", { enum: ["beginner", "intermediate", "advanced", "expert"] }),
		notes: text("notes"),
		removed_at: timestamp("removed_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "person_skill_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_skill_fk_1",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_skill_fk_2",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "person_skill_pkey", columns: [table.id] }),
		unique("person_skill_uq_0").on(table.id, table.plant_id),
		check("person_skill_ck_0", sql`(revision >= 1)`),
		check(
			"person_skill_ck_1",
			sql`(category = ANY (ARRAY['worship'::text, 'tech'::text, 'admin'::text, 'teaching'::text, 'hospitality'::text, 'leadership'::text, 'other'::text]))`,
		),
		check(
			"person_skill_ck_2",
			sql`(proficiency = ANY (ARRAY['beginner'::text, 'intermediate'::text, 'advanced'::text, 'expert'::text]))`,
		),
		check("person_skill_ck_3", sql`((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 100))`),
		index("person_skill_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("person_skill_ref_1").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
	],
);
export const person_tag = pgTable(
	"person_tag",
	{
		plant_id: uuid("plant_id").notNull(),
		person_id: uuid("person_id").notNull(),
		tag_id: uuid("tag_id").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "person_tag_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_tag_fk_1",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "person_tag_fk_2",
			columns: [table.tag_id, table.plant_id],
			foreignColumns: [tag.id, tag.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "person_tag_pkey", columns: [table.plant_id, table.person_id, table.tag_id] }),
		index("person_tag_ref_1").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("person_tag_ref_2").using("btree", table.tag_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
	],
);
export const phase_transition = pgTable(
	"phase_transition",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		kind: text("kind", { enum: ["creation", "initial_declaration", "movement", "noop"] }).notNull(),
		from_phase: integer("from_phase"),
		to_phase: integer("to_phase").notNull(),
		reason: text("reason").notNull(),
		occurred_at: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
		recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
		operation_id: uuid("operation_id").notNull(),
		criterion_version_id: uuid("criterion_version_id"),
		offer_answer: text("offer_answer", { enum: ["accepted", "declined"] }),
		answered_at: timestamp("answered_at", { withTimezone: true, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "phase_transition_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "phase_transition_fk_1", columns: [table.operation_id], foreignColumns: [audit_event.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "phase_transition_fk_2",
			columns: [table.criterion_version_id],
			foreignColumns: [reference_version.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "phase_transition_fk_3",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "phase_transition_pkey", columns: [table.id] }),
		unique("phase_transition_uq_0").on(table.id, table.plant_id),
		unique("phase_transition_uq_1").on(table.operation_id),
		check("creation_phase", sql`((kind <> 'creation'::text) OR ((from_phase IS NULL) AND (to_phase = 1)))`),
		check(
			"phase_transition_ck_0",
			sql`(kind = ANY (ARRAY['creation'::text, 'initial_declaration'::text, 'movement'::text, 'noop'::text]))`,
		),
		check("phase_transition_ck_1", sql`(offer_answer = ANY (ARRAY['accepted'::text, 'declined'::text]))`),
		check("phase_transition_ck_2", sql`((to_phase >= 0) AND (to_phase <= 6))`),
		check("phase_transition_ck_3", sql`((from_phase IS NULL) OR ((from_phase >= 0) AND (from_phase <= 6)))`),
		check("phase_transition_ck_4", sql`((kind <> 'creation'::text) OR ((from_phase IS NULL) AND (to_phase = 1)))`),
		check("phase_transition_ck_5", sql`((offer_answer IS NULL) = (answered_at IS NULL))`),
		index("phase_transition_ref_2").using("btree", table.criterion_version_id.asc().nullsLast()),
		uniqueIndex("phase_transition_uq_2")
			.using("btree", table.plant_id.asc().nullsLast())
			.where(sql`(kind = 'creation'::text)`),
		uniqueIndex("phase_transition_uq_3")
			.using("btree", table.plant_id.asc().nullsLast())
			.where(sql`(kind = 'initial_declaration'::text)`),
	],
);
export const pipeline_person = pgTable(
	"pipeline_person",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		person_id: uuid("person_id").notNull(),
		stage_id: uuid("stage_id").notNull(),
		responsible_seat_id: uuid("responsible_seat_id"),
		assessed_on: date("assessed_on", { mode: "string" }),
		assessor_label: text("assessor_label"),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "pipeline_person_fk_0", columns: [table.organization_id], foreignColumns: [organization.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "pipeline_person_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "pipeline_person_fk_2",
			columns: [table.person_id, table.organization_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "pipeline_person_fk_3",
			columns: [table.stage_id, table.organization_id],
			foreignColumns: [pipeline_stage.id, pipeline_stage.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "pipeline_person_fk_4", columns: [table.responsible_seat_id], foreignColumns: [seat.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "pipeline_person_pkey", columns: [table.id] }),
		unique("pipeline_person_uq_0").on(table.id, table.organization_id),
		unique("pipeline_person_uq_1").on(table.person_id, table.organization_id),
		check("pipeline_person_ck_0", sql`(revision >= 1)`),
		check("pipeline_person_ck_1", sql`((assessed_on IS NULL) = (assessor_label IS NULL))`),
		index("pipeline_person_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("pipeline_person_ref_3").using(
			"btree",
			table.stage_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("pipeline_person_ref_4").using("btree", table.responsible_seat_id.asc().nullsLast()),
	],
);
export const pipeline_sharing = pgTable(
	"pipeline_sharing",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		relationship_id: uuid("relationship_id").notNull(),
		network_id: uuid("network_id").notNull(),
		share_pipeline_totals: boolean("share_pipeline_totals")
			.notNull()
			.default(sql`false`),
		changed_by: uuid("changed_by"),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "pipeline_sharing_fk_0", columns: [table.organization_id], foreignColumns: [organization.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "pipeline_sharing_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "pipeline_sharing_fk_2", columns: [table.relationship_id], foreignColumns: [affiliation.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "pipeline_sharing_fk_3", columns: [table.network_id], foreignColumns: [organization.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "pipeline_sharing_fk_4", columns: [table.changed_by], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "pipeline_sharing_pkey", columns: [table.id] }),
		unique("pipeline_sharing_uq_0").on(table.id, table.organization_id),
		unique("pipeline_sharing_uq_1").on(table.relationship_id),
		check("pipeline_sharing_ck_0", sql`(revision >= 1)`),
		check("pipeline_sharing_ck_1", sql`(network_id <> organization_id)`),
		index("pipeline_sharing_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("pipeline_sharing_ref_3").using("btree", table.network_id.asc().nullsLast()),
		index("pipeline_sharing_ref_4").using("btree", table.changed_by.asc().nullsLast()),
	],
);
export const pipeline_stage = pgTable(
	"pipeline_stage",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		stable_kind: text("stable_kind", {
			enum: ["potential_leader", "apprentice", "resident", "commissioned", "not_continuing", "other"],
		}).notNull(),
		label: text("label").notNull(),
		position: integer("position").notNull(),
		removed_at: timestamp("removed_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "pipeline_stage_fk_0", columns: [table.organization_id], foreignColumns: [organization.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "pipeline_stage_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "pipeline_stage_pkey", columns: [table.id] }),
		unique("pipeline_stage_uq_0").on(table.id, table.organization_id),
		check("pipeline_stage_ck_0", sql`(revision >= 1)`),
		check(
			"pipeline_stage_ck_1",
			sql`(stable_kind = ANY (ARRAY['potential_leader'::text, 'apprentice'::text, 'resident'::text, 'commissioned'::text, 'not_continuing'::text, 'other'::text]))`,
		),
		check("pipeline_stage_ck_2", sql`("position" >= 0)`),
		check("pipeline_stage_ck_3", sql`((length(btrim(label)) >= 1) AND (length(btrim(label)) <= 255))`),
		index("pipeline_stage_ref_0").using("btree", table.organization_id.asc().nullsLast()),
	],
);
export const pipeline_stage_move = pgTable(
	"pipeline_stage_move",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		person_id: uuid("person_id").notNull(),
		from_stage_id: uuid("from_stage_id"),
		to_stage_id: uuid("to_stage_id").notNull(),
		old_label: text("old_label"),
		new_label: text("new_label").notNull(),
		actor_id: uuid("actor_id"),
		moved_at: timestamp("moved_at", { withTimezone: true, mode: "date" }).notNull(),
		reason: text("reason"),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "pipeline_stage_move_fk_0",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "pipeline_stage_move_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "pipeline_stage_move_fk_2",
			columns: [table.person_id, table.organization_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "pipeline_stage_move_fk_3",
			columns: [table.from_stage_id, table.organization_id],
			foreignColumns: [pipeline_stage.id, pipeline_stage.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "pipeline_stage_move_fk_4",
			columns: [table.to_stage_id, table.organization_id],
			foreignColumns: [pipeline_stage.id, pipeline_stage.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "pipeline_stage_move_fk_5", columns: [table.actor_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "pipeline_stage_move_pkey", columns: [table.id] }),
		unique("pipeline_stage_move_uq_0").on(table.id, table.organization_id),
		check("pipeline_stage_move_ck_0", sql`(revision >= 1)`),
		check("pipeline_stage_move_ck_1", sql`((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 5000))`),
		index("pipeline_stage_move_ref_0").using("btree", table.organization_id.asc().nullsLast()),
		index("pipeline_stage_move_ref_2").using(
			"btree",
			table.person_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("pipeline_stage_move_ref_3").using(
			"btree",
			table.from_stage_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("pipeline_stage_move_ref_4").using(
			"btree",
			table.to_stage_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("pipeline_stage_move_ref_5").using("btree", table.actor_id.asc().nullsLast()),
	],
);
export const plant = pgTable(
	"plant",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		name: text("name").notNull(),
		street: text("street"),
		description: text("description"),
		timezone: text("timezone").notNull(),
		warning_days: integer("warning_days").notNull(),
		alert_days: integer("alert_days").notNull(),
		digest_weekday: integer("digest_weekday").notNull(),
		digest_hour: integer("digest_hour").notNull(),
		phase: integer("phase").notNull(),
		material_revision: int64("material_revision").notNull(),
		lead_answer: text("lead_answer", { enum: ["yes", "no", "skip"] }),
		journey_answer: text("journey_answer", { enum: ["existing", "unsure", "discerning", "skip"] }),
		launch_answer: text("launch_answer", { enum: ["planned", "no_date", "skip"] }),
		onboarding_completed_at: timestamp("onboarding_completed_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
		city: text("city"),
		state_province: text("state_province"),
		country: text("country"),
		digest_cadence: text("digest_cadence", { enum: ["off", "daily", "weekly"] })
			.notNull()
			.default("weekly"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "plant_fk_0", columns: [table.id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "plant_fk_1", columns: [table.id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "plant_pkey", columns: [table.id] }),
		check("plant_ck_0", sql`(revision >= 1)`),
		check("plant_ck_1", sql`(length(btrim(name)) > 0)`),
		check("plant_ck_10", sql`(launch_answer = ANY (ARRAY['planned'::text, 'no_date'::text, 'skip'::text]))`),
		check("plant_ck_11", sql`(id <> '00000000-0000-0000-0000-000000000000'::uuid)`),
		check("plant_ck_2", sql`((warning_days >= 1) AND (warning_days <= 365))`),
		check("plant_ck_3", sql`((alert_days >= 1) AND (alert_days <= 365))`),
		check("plant_ck_4", sql`(warning_days < alert_days)`),
		check("plant_ck_5", sql`((digest_weekday >= 0) AND (digest_weekday <= 6))`),
		check("plant_ck_6", sql`((digest_hour >= 0) AND (digest_hour <= 23))`),
		check("plant_ck_7", sql`((phase >= 0) AND (phase <= 6))`),
		check("plant_ck_8", sql`(lead_answer = ANY (ARRAY['yes'::text, 'no'::text, 'skip'::text]))`),
		check(
			"plant_ck_9",
			sql`(journey_answer = ANY (ARRAY['existing'::text, 'unsure'::text, 'discerning'::text, 'skip'::text]))`,
		),
		check("plant_digest_cadence", sql`digest_cadence IN ('off','daily','weekly')`),
		check("plant_timezone_iana", sql`(timezone = ANY (${canonicalZones7}))`),
	],
);
export const plant_geography = pgTable(
	"plant_geography",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		city: text("city"),
		state_province: text("state_province"),
		country: text("country"),
		region_item_id: uuid("region_item_id"),
		reference_version_id: uuid("reference_version_id").notNull(),
		committed_at: timestamp("committed_at", { withTimezone: true, mode: "date" }).notNull(),
		effective_at: timestamp("effective_at", { withTimezone: true, mode: "date" }).notNull(),
		supersedes_id: uuid("supersedes_id"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "plant_geography_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "plant_geography_fk_1", columns: [table.region_item_id], foreignColumns: [reference_item.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "plant_geography_fk_2",
			columns: [table.reference_version_id],
			foreignColumns: [reference_version.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "plant_geography_fk_3",
			columns: [table.supersedes_id, table.plant_id],
			foreignColumns: [plant_geography.id, plant_geography.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "plant_geography_fk_4",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "plant_geography_pkey", columns: [table.id] }),
		unique("plant_geography_uq_0").on(table.id, table.plant_id),
		index("plant_geography_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("plant_geography_ref_1").using("btree", table.region_item_id.asc().nullsLast()),
		index("plant_geography_ref_2").using("btree", table.reference_version_id.asc().nullsLast()),
		index("plant_geography_ref_3").using(
			"btree",
			table.supersedes_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		uniqueIndex("plant_geography_uq_1")
			.using("btree", table.supersedes_id.asc().nullsLast())
			.where(sql`(supersedes_id IS NOT NULL)`),
	],
);
export const platform_grant = pgTable(
	"platform_grant",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		account_id: uuid("account_id").notNull(),
		capability: text("capability", { enum: ["feedback_triage", "reference_publish", "recovery_operator"] }).notNull(),
		expires_at: timestamp("expires_at", { withTimezone: true, mode: "date" }),
		revoked_at: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "platform_grant_fk_0", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "platform_grant_fk_1",
			columns: [table.id, table.account_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "platform_grant_pkey", columns: [table.id] }),
		unique("platform_grant_uq_0").on(table.id, table.account_id),
		check("platform_grant_ck_0", sql`(revision >= 1)`),
		check(
			"platform_grant_ck_1",
			sql`(capability = ANY (ARRAY['feedback_triage'::text, 'reference_publish'::text, 'recovery_operator'::text]))`,
		),
		uniqueIndex("platform_grant_uq_1")
			.using("btree", table.account_id.asc().nullsLast(), table.capability.asc().nullsLast())
			.where(sql`(revoked_at IS NULL)`),
	],
);
export const private_calendar = pgTable(
	"private_calendar",
	{
		account_id: uuid("account_id").notNull(),
		pending_timezone: text("pending_timezone"),
		pending_boundary: timestamp("pending_boundary", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "private_calendar_fk_0", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "private_calendar_pkey", columns: [table.account_id] }),
		check("private_calendar_ck_0", sql`(revision >= 1)`),
		check("private_calendar_ck_1", sql`((pending_timezone IS NULL) = (pending_boundary IS NULL))`),
		check("private_calendar_pending_timezone_iana", sql`(pending_timezone = ANY (${canonicalZones7}))`),
	],
);
export const private_week = pgTable(
	"private_week",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		author_id: uuid("author_id").notNull(),
		ordinal: int64("ordinal").notNull(),
		monday: date("monday", { mode: "string" }).notNull(),
		timezone: text("timezone").notNull(),
		starts_at: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
		ends_at: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
		spiritually: text("spiritually", { enum: ["steady", "strained", "struggling"] }),
		marriage_family: text("marriage_family", { enum: ["steady", "strained", "struggling"] }),
		financially: text("financially", { enum: ["steady", "strained", "struggling"] }),
		pace: text("pace", { enum: ["steady", "strained", "struggling"] }),
		note: text("note"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "private_week_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "private_week_fk_1", columns: [table.author_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "private_week_pkey", columns: [table.id] }),
		unique("private_week_uq_0").on(table.id, table.plant_id),
		unique("private_week_uq_1").on(table.author_id, table.ordinal),
		unique("private_week_uq_2").on(table.id, table.author_id),
		check("private_week_ck_0", sql`(revision >= 1)`),
		check("private_week_ck_1", sql`(ends_at > starts_at)`),
		check(
			"private_week_ck_2",
			sql`(num_nonnulls(spiritually, marriage_family, financially, pace) = ANY (ARRAY[0, 4]))`,
		),
		check("private_week_ck_3", sql`((note IS NULL) OR (length(note) <= 2000))`),
		check("private_week_ck_4", sql`(spiritually = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text]))`),
		check(
			"private_week_ck_5",
			sql`(marriage_family = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text]))`,
		),
		check("private_week_ck_6", sql`(financially = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text]))`),
		check("private_week_ck_7", sql`(pace = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text]))`),
		check("private_week_timezone_iana", sql`(timezone = ANY (${canonicalZones7}))`),
		index("private_week_ref_0").using("btree", table.plant_id.asc().nullsLast()),
	],
);
export const private_week_revision = pgTable(
	"private_week_revision",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		week_id: uuid("week_id").notNull(),
		author_id: uuid("author_id").notNull(),
		before_revision: int64("before_revision").notNull(),
		after_revision: int64("after_revision").notNull(),
		spiritually: text("spiritually", { enum: ["steady", "strained", "struggling"] }).notNull(),
		marriage_family: text("marriage_family", { enum: ["steady", "strained", "struggling"] }).notNull(),
		financially: text("financially", { enum: ["steady", "strained", "struggling"] }).notNull(),
		pace: text("pace", { enum: ["steady", "strained", "struggling"] }).notNull(),
		note: text("note"),
		corrected_at: timestamp("corrected_at", { withTimezone: true, mode: "date" }).notNull(),
		request_key: text("request_key").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "private_week_revision_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "private_week_revision_fk_1",
			columns: [table.week_id, table.author_id],
			foreignColumns: [private_week.id, private_week.author_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "private_week_revision_fk_2", columns: [table.author_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "private_week_revision_pkey", columns: [table.id] }),
		unique("private_week_revision_uq_0").on(table.id, table.plant_id),
		unique("private_week_revision_uq_1").on(table.author_id, table.request_key),
		check(
			"private_week_revision_ck_0",
			sql`(spiritually = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text]))`,
		),
		check(
			"private_week_revision_ck_1",
			sql`(marriage_family = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text]))`,
		),
		check(
			"private_week_revision_ck_2",
			sql`(financially = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text]))`,
		),
		check(
			"private_week_revision_ck_3",
			sql`(pace = ANY (ARRAY['steady'::text, 'strained'::text, 'struggling'::text]))`,
		),
		index("private_week_revision_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("private_week_revision_ref_1").using(
			"btree",
			table.week_id.asc().nullsLast(),
			table.author_id.asc().nullsLast(),
		),
	],
);
export const prompt_dismissal = pgTable(
	"prompt_dismissal",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		account_id: uuid("account_id").notNull(),
		plant_id: uuid("plant_id").notNull(),
		prompt_key: text("prompt_key").notNull(),
		context_version: text("context_version").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "prompt_dismissal_fk_0", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "prompt_dismissal_fk_1", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "prompt_dismissal_fk_2",
			columns: [table.id, table.account_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "prompt_dismissal_pkey", columns: [table.id] }),
		unique("prompt_dismissal_uq_0").on(table.id, table.account_id),
		unique("prompt_dismissal_uq_1").on(table.account_id, table.plant_id, table.prompt_key, table.context_version),
		index("prompt_dismissal_ref_1").using("btree", table.plant_id.asc().nullsLast()),
	],
);
export const provider_event = pgTable(
	"provider_event",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		event_key: text("event_key").notNull(),
		message_id: text("message_id").notNull(),
		kind: text("kind", {
			enum: ["accepted", "scheduled", "sent", "delivered", "bounced", "complained", "opened", "clicked", "cancelled"],
		}).notNull(),
		occurred_at: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
		received_at: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull(),
		payload_hash: text("payload_hash").notNull(),
		mail_id: uuid("mail_id"),
		processed_at: timestamp("processed_at", { withTimezone: true, mode: "date" }),
		safe_payload: jsonb("safe_payload").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "provider_event_fk_0", columns: [table.mail_id], foreignColumns: [mail.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "provider_event_fk_1", columns: [table.id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "provider_event_pkey", columns: [table.id] }),
		unique("provider_event_uq_0").on(table.event_key),
		check(
			"provider_event_ck_0",
			sql`(kind = ANY (ARRAY['accepted'::text, 'scheduled'::text, 'sent'::text, 'delivered'::text, 'bounced'::text, 'complained'::text, 'opened'::text, 'clicked'::text, 'cancelled'::text]))`,
		),
		index("provider_event_ref_0").using("btree", table.mail_id.asc().nullsLast()),
	],
);
export const reader_feedback = pgTable(
	"reader_feedback",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_context_id: uuid("plant_context_id"),
		organization_context_id: uuid("organization_context_id"),
		account_id: uuid("account_id").notNull(),
		assessment_id: uuid("assessment_id"),
		finding_id: uuid("finding_id"),
		rating: text("rating", { enum: ["useful", "not_useful", "helpful", "unhelpful"] }).notNull(),
		comment: text("comment"),
		reference_version_id: uuid("reference_version_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
		article_id: uuid("article_id"),
		article_revision_id: uuid("article_revision_id"),
		organization_source_id: uuid("organization_source_id"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "reader_feedback_fk_0", columns: [table.plant_context_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "reader_feedback_fk_1",
			columns: [table.organization_context_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "reader_feedback_fk_2", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "reader_feedback_fk_3", columns: [table.assessment_id], foreignColumns: [assessment.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "reader_feedback_fk_4", columns: [table.finding_id], foreignColumns: [finding.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "reader_feedback_fk_5",
			columns: [table.reference_version_id],
			foreignColumns: [reference_version.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "reader_feedback_fk_6", columns: [table.article_id], foreignColumns: [reference_item.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "reader_feedback_fk_7",
			columns: [table.article_revision_id],
			foreignColumns: [article_revision.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "reader_feedback_fk_8",
			columns: [table.organization_source_id],
			foreignColumns: [organization.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "reader_feedback_fk_9",
			columns: [table.id, table.account_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "reader_feedback_pkey", columns: [table.id] }),
		check("reader_feedback_ck_0", sql`(revision >= 1)`),
		check(
			"reader_feedback_ck_1",
			sql`(rating = ANY (ARRAY['useful'::text, 'not_useful'::text, 'helpful'::text, 'unhelpful'::text]))`,
		),
		check("reader_feedback_ck_2", sql`(num_nonnulls(assessment_id, finding_id, article_revision_id) = 1)`),
		check(
			"reader_feedback_ck_3",
			sql`(((article_revision_id IS NULL) AND (rating = ANY (ARRAY['useful'::text, 'not_useful'::text])) AND (article_id IS NULL)) OR ((article_revision_id IS NOT NULL) AND (rating = ANY (ARRAY['helpful'::text, 'unhelpful'::text])) AND (article_id IS NOT NULL) AND (plant_context_id IS NOT NULL)))`,
		),
		check("reader_feedback_ck_4", sql`(num_nonnulls(plant_context_id, organization_context_id) = 1)`),
		index("reader_feedback_ref_0").using("btree", table.plant_context_id.asc().nullsLast()),
		index("reader_feedback_ref_1").using("btree", table.organization_context_id.asc().nullsLast()),
		index("reader_feedback_ref_3").using("btree", table.assessment_id.asc().nullsLast()),
		index("reader_feedback_ref_4").using("btree", table.finding_id.asc().nullsLast()),
		index("reader_feedback_ref_5").using("btree", table.reference_version_id.asc().nullsLast()),
		index("reader_feedback_ref_6").using("btree", table.article_id.asc().nullsLast()),
		index("reader_feedback_ref_7").using("btree", table.article_revision_id.asc().nullsLast()),
		index("reader_feedback_ref_8").using("btree", table.organization_source_id.asc().nullsLast()),
		index("reader_feedback_ref_9").using("btree", table.id.asc().nullsLast(), table.account_id.asc().nullsLast()),
		uniqueIndex("reader_feedback_uq_0")
			.using("btree", table.account_id.asc().nullsLast(), table.assessment_id.asc().nullsLast())
			.where(sql`(assessment_id IS NOT NULL)`),
		uniqueIndex("reader_feedback_uq_1")
			.using("btree", table.account_id.asc().nullsLast(), table.finding_id.asc().nullsLast())
			.where(sql`(finding_id IS NOT NULL)`),
		uniqueIndex("reader_feedback_uq_2")
			.using(
				"btree",
				table.account_id.asc().nullsLast(),
				table.plant_context_id.asc().nullsLast(),
				table.article_id.asc().nullsLast(),
			)
			.where(sql`((article_revision_id IS NOT NULL) AND (organization_source_id IS NULL))`),
		uniqueIndex("reader_feedback_uq_3")
			.using(
				"btree",
				table.account_id.asc().nullsLast(),
				table.plant_context_id.asc().nullsLast(),
				table.article_id.asc().nullsLast(),
				table.organization_source_id.asc().nullsLast(),
			)
			.where(sql`((article_revision_id IS NOT NULL) AND (organization_source_id IS NOT NULL))`),
	],
);
export const reading = pgTable(
	"reading",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		account_id: uuid("account_id").notNull(),
		article_id: uuid("article_id").notNull(),
		last_revision_id: uuid("last_revision_id"),
		plant_context_id: uuid("plant_context_id"),
		observed_fraction: numeric("observed_fraction").notNull(),
		resume_position: text("resume_position"),
		last_viewed_at: timestamp("last_viewed_at", { withTimezone: true, mode: "date" }),
		completed_at: timestamp("completed_at", { withTimezone: true, mode: "date" }),
		completed_revision_id: uuid("completed_revision_id"),
		completed_fraction: numeric("completed_fraction"),
		policy_version: text("policy_version").notNull(),
		last_read_meaningful_sequence: int64("last_read_meaningful_sequence").notNull(),
		bookmarked: boolean("bookmarked").notNull(),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "reading_fk_0", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "reading_fk_1", columns: [table.article_id], foreignColumns: [reference_item.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "reading_fk_2", columns: [table.last_revision_id], foreignColumns: [article_revision.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "reading_fk_3", columns: [table.plant_context_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "reading_fk_4", columns: [table.completed_revision_id], foreignColumns: [article_revision.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "reading_fk_5",
			columns: [table.id, table.account_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "reading_pkey", columns: [table.id] }),
		unique("reading_uq_0").on(table.id, table.account_id),
		unique("reading_uq_1").on(table.account_id, table.article_id),
		check("reading_ck_0", sql`(revision >= 1)`),
		check("reading_ck_1", sql`((observed_fraction >= (0)::numeric) AND (observed_fraction <= (1)::numeric))`),
		check(
			"reading_ck_2",
			sql`((completed_fraction IS NULL) OR ((completed_fraction >= (0)::numeric) AND (completed_fraction <= (1)::numeric)))`,
		),
		check("reading_ck_3", sql`((completed_at IS NULL) = (completed_revision_id IS NULL))`),
		index("reading_ref_1").using("btree", table.article_id.asc().nullsLast()),
		index("reading_ref_2").using("btree", table.last_revision_id.asc().nullsLast()),
		index("reading_ref_3").using("btree", table.plant_context_id.asc().nullsLast()),
		index("reading_ref_4").using("btree", table.completed_revision_id.asc().nullsLast()),
	],
);
export const record = pgTable(
	"record",
	{
		id: uuid("id").notNull(),
		kind: text("kind", {
			enum: [
				"account",
				"affiliation",
				"article_editor_state",
				"article_revision",
				"assessment",
				"assessment_contributor",
				"assessment_fact",
				"assignment_feedback",
				"attestation",
				"commitment",
				"communication",
				"communication_recipient",
				"contact_outcome",
				"conversation",
				"conversation_entry",
				"development_enrollment",
				"development_milestone",
				"development_program",
				"development_program_version",
				"development_reading",
				"development_stage",
				"digest_coverage",
				"discovery",
				"document",
				"document_revision",
				"effect",
				"enrollment_milestone",
				"enrollment_plan",
				"feedback",
				"feedback_publication",
				"file_object",
				"finding",
				"four_cs",
				"generated_document",
				"household",
				"interview",
				"invitation",
				"job",
				"launch_debrief",
				"launch_guest",
				"launch_milestone",
				"leadership_conversation",
				"lifecycle_witness",
				"mail",
				"mail_attempt",
				"mail_request",
				"meeting",
				"meeting_evaluation",
				"meeting_item",
				"message_template",
				"notice",
				"notification_preference",
				"obligation",
				"audit_event",
				"organization",
				"organization_person_removal",
				"participation",
				"passage",
				"person",
				"person_merge",
				"person_note",
				"person_skill",
				"phase_transition",
				"pipeline_person",
				"pipeline_sharing",
				"pipeline_stage",
				"pipeline_stage_move",
				"plant",
				"plant_geography",
				"platform_grant",
				"prompt_dismissal",
				"provider_event",
				"reader_feedback",
				"reading",
				"recurrence",
				"reference_activation",
				"reference_item",
				"reference_release",
				"reference_version",
				"residency_link",
				"responsibility",
				"review",
				"seat",
				"sending_goal",
				"suppression",
				"tag",
				"task",
				"team",
				"team_role",
				"team_tenure",
				"training_assignment",
				"training_credit",
				"training_program",
				"training_requirement",
				"training_version",
				"venue",
				"wiki_preference",
			],
		}).notNull(),
		tenant_id: uuid("tenant_id").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "record_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "record_pkey", columns: [table.id] }),
		unique("record_uq_0").on(table.id, table.tenant_id),
		check(
			"record_ck_0",
			sql`(kind = ANY (ARRAY['account'::text, 'affiliation'::text, 'article_editor_state'::text, 'article_revision'::text, 'assessment'::text, 'assessment_contributor'::text, 'assessment_fact'::text, 'assignment_feedback'::text, 'attestation'::text, 'commitment'::text, 'communication'::text, 'communication_recipient'::text, 'contact_outcome'::text, 'conversation'::text, 'conversation_entry'::text, 'development_enrollment'::text, 'development_milestone'::text, 'development_program'::text, 'development_program_version'::text, 'development_reading'::text, 'development_stage'::text, 'digest_coverage'::text, 'discovery'::text, 'document'::text, 'document_revision'::text, 'effect'::text, 'enrollment_milestone'::text, 'enrollment_plan'::text, 'feedback'::text, 'feedback_publication'::text, 'file_object'::text, 'finding'::text, 'four_cs'::text, 'generated_document'::text, 'household'::text, 'interview'::text, 'invitation'::text, 'job'::text, 'launch_debrief'::text, 'launch_guest'::text, 'launch_milestone'::text, 'leadership_conversation'::text, 'lifecycle_witness'::text, 'mail'::text, 'mail_attempt'::text, 'mail_request'::text, 'meeting'::text, 'meeting_evaluation'::text, 'meeting_item'::text, 'message_template'::text, 'notice'::text, 'notification_preference'::text, 'obligation'::text, 'audit_event'::text, 'organization'::text, 'organization_person_removal'::text, 'participation'::text, 'passage'::text, 'person'::text, 'person_merge'::text, 'person_note'::text, 'person_skill'::text, 'phase_transition'::text, 'pipeline_person'::text, 'pipeline_sharing'::text, 'pipeline_stage'::text, 'pipeline_stage_move'::text, 'plant'::text, 'plant_geography'::text, 'platform_grant'::text, 'prompt_dismissal'::text, 'provider_event'::text, 'reader_feedback'::text, 'reading'::text, 'recurrence'::text, 'reference_activation'::text, 'reference_item'::text, 'reference_release'::text, 'reference_version'::text, 'residency_link'::text, 'responsibility'::text, 'review'::text, 'seat'::text, 'sending_goal'::text, 'suppression'::text, 'tag'::text, 'task'::text, 'team'::text, 'team_role'::text, 'team_tenure'::text, 'training_assignment'::text, 'training_credit'::text, 'training_program'::text, 'training_requirement'::text, 'training_version'::text, 'venue'::text, 'wiki_preference'::text]))`,
		),
		check(
			"record_ck_1",
			sql`((kind <> ALL (ARRAY['account'::text, 'plant'::text, 'organization'::text])) OR (tenant_id = id))`,
		),
		index("record_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
	],
);
export const recurrence = pgTable(
	"recurrence",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		interval: text("interval", { enum: ["daily", "weekly", "biweekly", "monthly", "quarterly", "yearly"] }).notNull(),
		end_date: date("end_date", { mode: "string" }),
		timezone: text("timezone").notNull(),
		local_time: time("local_time"),
		source_task_id: uuid("source_task_id").notNull(),
		source_revision: int64("source_revision").notNull(),
		stopped_at: timestamp("stopped_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "recurrence_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "recurrence_fk_1",
			columns: [table.source_task_id, table.plant_id],
			foreignColumns: [task.id, task.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "recurrence_fk_2",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "recurrence_pkey", columns: [table.id] }),
		unique("recurrence_uq_0").on(table.id, table.plant_id),
		check("recurrence_ck_0", sql`(revision >= 1)`),
		check(
			"recurrence_ck_1",
			sql`("interval" = ANY (ARRAY['daily'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text, 'quarterly'::text, 'yearly'::text]))`,
		),
		check("recurrence_timezone_iana", sql`(timezone = ANY (${canonicalZones7}))`),
		index("recurrence_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("recurrence_ref_1").using("btree", table.source_task_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
	],
);
export const reference_activation = pgTable(
	"reference_activation",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		release_id: uuid("release_id").notNull(),
		activation_number: int64("activation_number").notNull(),
		previous_id: uuid("previous_id"),
		activated_at: timestamp("activated_at", { withTimezone: true, mode: "date" }).notNull(),
		actor_id: uuid("actor_id"),
		actor_tombstone: text("actor_tombstone"),
		reason: text("reason").notNull(),
		expected_prior_number: int64("expected_prior_number").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "reference_activation_fk_0",
			columns: [table.release_id],
			foreignColumns: [reference_release.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "reference_activation_fk_1",
			columns: [table.previous_id],
			foreignColumns: [reference_activation.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "reference_activation_fk_2", columns: [table.actor_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "reference_activation_fk_3", columns: [table.id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "reference_activation_pkey", columns: [table.id] }),
		unique("reference_activation_uq_0").on(table.activation_number),
		check("reference_activation_ck_0", sql`(num_nonnulls(actor_id, actor_tombstone) = 1)`),
		index("reference_activation_ref_0").using("btree", table.release_id.asc().nullsLast()),
		index("reference_activation_ref_1").using("btree", table.previous_id.asc().nullsLast()),
		index("reference_activation_ref_2").using("btree", table.actor_id.asc().nullsLast()),
	],
);
export const reference_item = pgTable(
	"reference_item",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		kind: text("kind", {
			enum: [
				"article",
				"section",
				"phase",
				"criterion",
				"rubric",
				"playbook",
				"task_template",
				"ministry_template",
				"mail_template",
				"document_template",
				"launch_inventory",
				"geography_region",
				"geography_dataset",
				"source",
				"qualification",
			],
		}).notNull(),
		canonical_key: text("canonical_key").notNull(),
		tenant_id: uuid("tenant_id").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "reference_item_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "reference_item_fk_1",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "reference_item_pkey", columns: [table.id] }),
		unique("reference_item_uq_0").on(table.kind, table.canonical_key),
		unique("reference_item_uq_1").on(table.id, table.tenant_id),
		check(
			"reference_item_ck_0",
			sql`(kind = ANY (ARRAY['article'::text, 'section'::text, 'phase'::text, 'criterion'::text, 'rubric'::text, 'playbook'::text, 'task_template'::text, 'ministry_template'::text, 'mail_template'::text, 'document_template'::text, 'launch_inventory'::text, 'geography_region'::text, 'geography_dataset'::text, 'source'::text, 'qualification'::text]))`,
		),
		index("reference_item_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
	],
);
export const reference_release = pgTable(
	"reference_release",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		release_key: text("release_key").notNull(),
		artifact_locator: text("artifact_locator").notNull(),
		manifest_hash: text("manifest_hash").notNull(),
		state: text("state", { enum: ["building", "validated", "failed"] }).notNull(),
		complete_at: timestamp("complete_at", { withTimezone: true, mode: "date" }),
		validated_at: timestamp("validated_at", { withTimezone: true, mode: "date" }),
		approval_locator: text("approval_locator"),
		approval_hash: text("approval_hash"),
		chunker_version: text("chunker_version").notNull(),
		embedding_profile: text("embedding_profile").notNull(),
		embedding_dimensions: integer("embedding_dimensions").notNull(),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
		tenant_id: uuid("tenant_id").notNull(),
		source_revision_id: uuid("source_revision_id"),
		failure_code: text("failure_code"),
		expected_passages: integer("expected_passages").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "reference_release_fk_0", columns: [table.tenant_id], foreignColumns: [tenant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "reference_release_fk_1",
			columns: [table.source_revision_id, table.tenant_id],
			foreignColumns: [article_revision.id, article_revision.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "reference_release_fk_2",
			columns: [table.id, table.tenant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "reference_release_pkey", columns: [table.id] }),
		unique("reference_release_uq_0").on(table.release_key),
		unique("reference_release_uq_1").on(table.id, table.tenant_id),
		check("reference_release_ck_0", sql`(revision >= 1)`),
		check("reference_release_ck_1", sql`(state = ANY (ARRAY['building'::text, 'validated'::text, 'failed'::text]))`),
		check(
			"reference_release_ck_2",
			sql`((tenant_id = '00000000-0000-0000-0000-000000000000'::uuid) = (source_revision_id IS NULL))`,
		),
		index("reference_release_ref_0").using("btree", table.tenant_id.asc().nullsLast()),
		index("reference_release_ref_1").using(
			"btree",
			table.source_revision_id.asc().nullsLast(),
			table.tenant_id.asc().nullsLast(),
		),
	],
);
export const reference_version = pgTable(
	"reference_version",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		item_id: uuid("item_id").notNull(),
		release_id: uuid("release_id").notNull(),
		version_number: integer("version_number").notNull(),
		artifact_path: text("artifact_path").notNull(),
		content_hash: text("content_hash").notNull(),
		source_credit: text("source_credit").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "reference_version_fk_0", columns: [table.item_id], foreignColumns: [reference_item.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "reference_version_fk_1", columns: [table.release_id], foreignColumns: [reference_release.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "reference_version_fk_2", columns: [table.id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "reference_version_pkey", columns: [table.id] }),
		unique("reference_version_uq_0").on(table.item_id, table.version_number),
		unique("reference_version_uq_1").on(table.id, table.item_id),
		index("reference_version_ref_1").using("btree", table.release_id.asc().nullsLast()),
	],
);
export const relationship_invitation = pgTable(
	"relationship_invitation",
	{
		invitation_id: uuid("invitation_id").notNull(),
		plant_id: uuid("plant_id"),
		account_id: uuid("account_id"),
		sending_church_id: uuid("sending_church_id"),
		organization_id: uuid("organization_id").notNull(),
		inviter_description: text("inviter_description").notNull(),
		subject_revision: int64("subject_revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "relationship_invitation_account_id_fkey",
			columns: [table.account_id],
			foreignColumns: [account.id],
		})
			.onDelete("no action")
			.onUpdate("no action"),
		foreignKey({
			name: "relationship_invitation_invitation_id_fkey",
			columns: [table.invitation_id],
			foreignColumns: [invitation.id],
		})
			.onDelete("no action")
			.onUpdate("no action"),
		foreignKey({
			name: "relationship_invitation_organization_id_fkey",
			columns: [table.organization_id],
			foreignColumns: [organization.id],
		})
			.onDelete("no action")
			.onUpdate("no action"),
		primaryKey({ name: "relationship_invitation_pkey", columns: [table.invitation_id] }),
		foreignKey({ name: "relationship_invitation_plant_id_fkey", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("no action")
			.onUpdate("no action"),
		foreignKey({
			name: "relationship_invitation_sending_church_id_fkey",
			columns: [table.sending_church_id],
			foreignColumns: [organization.id],
		})
			.onDelete("no action")
			.onUpdate("no action"),
		check("relationship_invitation_check", sql`(num_nonnulls(plant_id, account_id, sending_church_id) = 1)`),
		check("relationship_invitation_check1", sql`(organization_id IS DISTINCT FROM sending_church_id)`),
		check(
			"relationship_invitation_inviter_description_check",
			sql`((length(inviter_description) >= 1) AND (length(inviter_description) <= 500))`,
		),
		check("relationship_invitation_subject_revision_check", sql`(subject_revision >= 1)`),
	],
);
export const residency_link = pgTable(
	"residency_link",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		person_id: uuid("person_id").notNull(),
		account_id: uuid("account_id"),
		affiliation_id: uuid("affiliation_id").notNull(),
		invitation_id: uuid("invitation_id").notNull(),
		accepted_at: timestamp("accepted_at", { withTimezone: true, mode: "date" }).notNull(),
		ended_at: timestamp("ended_at", { withTimezone: true, mode: "date" }),
		consent_revision: int64("consent_revision").notNull(),
		share_foundations: boolean("share_foundations")
			.notNull()
			.default(sql`false`),
		share_milestones: boolean("share_milestones")
			.notNull()
			.default(sql`false`),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "residency_link_fk_0", columns: [table.organization_id], foreignColumns: [organization.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "residency_link_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "residency_link_fk_2",
			columns: [table.person_id, table.organization_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "residency_link_fk_3", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "residency_link_fk_4", columns: [table.affiliation_id], foreignColumns: [affiliation.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "residency_link_fk_5",
			columns: [table.invitation_id, table.organization_id],
			foreignColumns: [invitation.id, invitation.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "residency_link_pkey", columns: [table.id] }),
		unique("residency_link_uq_0").on(table.id, table.organization_id),
		check("residency_link_ck_0", sql`(revision >= 1)`),
		check("residency_link_ck_1", sql`(consent_revision >= 1)`),
		check("residency_link_ck_2", sql`((ended_at IS NULL) OR (NOT (share_foundations OR share_milestones)))`),
		check("residency_link_ck_3", sql`((account_id IS NOT NULL) OR (ended_at IS NOT NULL))`),
		index("residency_link_ref_2").using(
			"btree",
			table.person_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		index("residency_link_ref_3").using("btree", table.account_id.asc().nullsLast()),
		index("residency_link_ref_4").using("btree", table.affiliation_id.asc().nullsLast()),
		index("residency_link_ref_5").using(
			"btree",
			table.invitation_id.asc().nullsLast(),
			table.organization_id.asc().nullsLast(),
		),
		uniqueIndex("residency_link_uq_1")
			.using("btree", table.organization_id.asc().nullsLast(), table.person_id.asc().nullsLast())
			.where(sql`(ended_at IS NULL)`),
		uniqueIndex("residency_link_uq_2")
			.using("btree", table.organization_id.asc().nullsLast(), table.account_id.asc().nullsLast())
			.where(sql`((ended_at IS NULL) AND (account_id IS NOT NULL))`),
	],
);
export const responsibility = pgTable(
	"responsibility",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		team_id: uuid("team_id").notNull(),
		source_version_id: uuid("source_version_id").notNull(),
		source_line: text("source_line").notNull(),
		text: text("text").notNull(),
		sort_order: integer("sort_order").notNull(),
		completed_on: date("completed_on", { mode: "string" }),
		removed_at: timestamp("removed_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "responsibility_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "responsibility_fk_1",
			columns: [table.team_id, table.plant_id],
			foreignColumns: [team.id, team.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "responsibility_fk_2",
			columns: [table.source_version_id],
			foreignColumns: [reference_version.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "responsibility_fk_3",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "responsibility_pkey", columns: [table.id] }),
		unique("responsibility_uq_0").on(table.id, table.plant_id),
		unique("responsibility_uq_1").on(table.team_id, table.source_version_id, table.source_line),
		check("responsibility_ck_0", sql`(revision >= 1)`),
		index("responsibility_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("responsibility_ref_1").using("btree", table.team_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("responsibility_ref_2").using("btree", table.source_version_id.asc().nullsLast()),
	],
);
export const rsvp_proof = pgTable(
	"rsvp_proof",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		participation_id: uuid("participation_id").notNull(),
		token_hash: text("token_hash").notNull(),
		expires_at: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
		state: text("state", { enum: ["pending", "answered", "revoked", "superseded", "expired"] }).notNull(),
		answered_at: timestamp("answered_at", { withTimezone: true, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "rsvp_proof_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "rsvp_proof_fk_1",
			columns: [table.participation_id, table.plant_id],
			foreignColumns: [participation.id, participation.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "rsvp_proof_pkey", columns: [table.id] }),
		unique("rsvp_proof_uq_0").on(table.id, table.plant_id),
		unique("rsvp_proof_uq_1").on(table.token_hash),
		check(
			"rsvp_proof_ck_0",
			sql`(state = ANY (ARRAY['pending'::text, 'answered'::text, 'revoked'::text, 'superseded'::text, 'expired'::text]))`,
		),
		index("rsvp_proof_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("rsvp_proof_ref_1").using(
			"btree",
			table.participation_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		uniqueIndex("rsvp_proof_uq_2")
			.using("btree", table.participation_id.asc().nullsLast())
			.where(sql`(state = 'pending'::text)`),
	],
);
export const schema_migration = pgTable(
	"schema_migration",
	{
		name: text("name").notNull(),
		applied_at: timestamp("applied_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`now()`),
		sha256: text("sha256").notNull(),
		provenance: text("provenance", { enum: ["original", "adopted"] }).notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		primaryKey({ name: "schema_migration_pkey", columns: [table.name] }),
		check("schema_migration_provenance_check", sql`(provenance = ANY (ARRAY['original'::text, 'adopted'::text]))`),
		check("schema_migration_sha256_check", sql`(sha256 ~ '^[a-f0-9]{64}$'::text)`),
	],
);
export const seat = pgTable(
	"seat",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		account_id: uuid("account_id").notNull(),
		plant_id: uuid("plant_id"),
		organization_id: uuid("organization_id"),
		role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
		accepted_at: timestamp("accepted_at", { withTimezone: true, mode: "date" }).notNull(),
		ended_at: timestamp("ended_at", { withTimezone: true, mode: "date" }),
		invitation_id: uuid("invitation_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "seat_fk_0", columns: [table.account_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "seat_fk_1", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "seat_fk_2", columns: [table.organization_id], foreignColumns: [organization.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "seat_fk_3", columns: [table.invitation_id], foreignColumns: [invitation.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "seat_fk_4", columns: [table.id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "seat_pkey", columns: [table.id] }),
		check("seat_ck_0", sql`(revision >= 1)`),
		check("seat_ck_1", sql`(role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))`),
		check("seat_ck_2", sql`(num_nonnulls(plant_id, organization_id) = 1)`),
		index("seat_ref_3").using("btree", table.invitation_id.asc().nullsLast()),
		uniqueIndex("seat_uq_0")
			.using("btree", table.account_id.asc().nullsLast())
			.where(sql`(ended_at IS NULL)`),
		uniqueIndex("seat_uq_1")
			.using("btree", table.plant_id.asc().nullsLast())
			.where(sql`((role = 'owner'::text) AND (ended_at IS NULL))`),
		uniqueIndex("seat_uq_2")
			.using("btree", table.organization_id.asc().nullsLast())
			.where(sql`((role = 'owner'::text) AND (ended_at IS NULL))`),
	],
);
export const sending_goal = pgTable(
	"sending_goal",
	{
		id: uuid("id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		leaders_target: integer("leaders_target").notNull(),
		plants_target: integer("plants_target").notNull(),
		target_year: integer("target_year").notNull(),
		rationale: text("rationale").notNull(),
		revision: int64("revision").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "sending_goal_fk_0", columns: [table.organization_id], foreignColumns: [organization.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "sending_goal_fk_1",
			columns: [table.id, table.organization_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "sending_goal_pkey", columns: [table.id] }),
		unique("sending_goal_uq_0").on(table.id, table.organization_id),
		check("sending_goal_ck_0", sql`(revision >= 1)`),
		check("sending_goal_ck_1", sql`(leaders_target >= 0)`),
		check("sending_goal_ck_2", sql`(plants_target >= 0)`),
		check("sending_goal_ck_3", sql`((target_year >= 1) AND (target_year <= 9999))`),
		index("sending_goal_ref_0").using("btree", table.organization_id.asc().nullsLast()),
	],
);
export const suppression = pgTable(
	"suppression",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		address_hash: text("address_hash").notNull(),
		reason: text("reason", { enum: ["hard_bounce", "complaint"] }).notNull(),
		source_event_id: uuid("source_event_id").notNull(),
		suppressed_at: timestamp("suppressed_at", { withTimezone: true, mode: "date" }).notNull(),
		cleared_at: timestamp("cleared_at", { withTimezone: true, mode: "date" }),
		clear_operation_id: uuid("clear_operation_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "suppression_fk_0", columns: [table.source_event_id], foreignColumns: [provider_event.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "suppression_fk_1", columns: [table.clear_operation_id], foreignColumns: [audit_event.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "suppression_fk_2", columns: [table.id], foreignColumns: [record.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "suppression_pkey", columns: [table.id] }),
		unique("suppression_uq_0").on(table.address_hash),
		check("suppression_ck_0", sql`(revision >= 1)`),
		check("suppression_ck_1", sql`(reason = ANY (ARRAY['hard_bounce'::text, 'complaint'::text]))`),
		index("suppression_ref_0").using("btree", table.source_event_id.asc().nullsLast()),
		index("suppression_ref_1").using("btree", table.clear_operation_id.asc().nullsLast()),
	],
);
export const tag = pgTable(
	"tag",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		name: text("name").notNull(),
		normalized_name: text("normalized_name").notNull(),
		color: text("color"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "tag_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "tag_fk_1", columns: [table.id, table.plant_id], foreignColumns: [record.id, record.tenant_id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "tag_pkey", columns: [table.id] }),
		unique("tag_uq_0").on(table.id, table.plant_id),
		unique("tag_uq_1").on(table.plant_id, table.normalized_name),
		check("tag_ck_0", sql`(revision >= 1)`),
		check("tag_ck_1", sql`((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 100))`),
		check("tag_ck_2", sql`(normalized_name = lower(btrim(name)))`),
	],
);
export const task = pgTable(
	"task",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		title: text("title").notNull(),
		description: text("description"),
		category: text("category", {
			enum: [
				"administrative",
				"vision_meeting",
				"follow_up",
				"general",
				"ministry_team",
				"launch_prep",
				"training",
				"promotion",
				"recurring",
			],
		}).notNull(),
		priority: text("priority", { enum: ["low", "medium", "high", "urgent"] }).notNull(),
		status: text("status", {
			enum: ["not_started", "in_progress", "blocked", "complete", "no_longer_needed"],
		}).notNull(),
		creator_id: uuid("creator_id"),
		created_at: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		assignee_id: uuid("assignee_id"),
		due_kind: text("due_kind", { enum: ["undated", "date_only", "timed"] }).notNull(),
		due_date: date("due_date", { mode: "string" }),
		due_time: time("due_time"),
		timezone: text("timezone"),
		due_at: timestamp("due_at", { withTimezone: true, mode: "date" }),
		resolver_version: text("resolver_version"),
		person_id: uuid("person_id"),
		meeting_id: uuid("meeting_id"),
		team_id: uuid("team_id"),
		launch_id: uuid("launch_id"),
		parent_id: uuid("parent_id"),
		position: integer("position"),
		series_id: uuid("series_id"),
		occurrence_key: text("occurrence_key"),
		predecessor_id: uuid("predecessor_id"),
		obligation_id: uuid("obligation_id"),
		completed_at: timestamp("completed_at", { withTimezone: true, mode: "date" }),
		deleted_at: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
		source_template_id: uuid("source_template_id"),
		import_operation_id: uuid("import_operation_id"),
		milestone_id: uuid("milestone_id"),
		seed_key: text("seed_key"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "task_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "task_fk_1", columns: [table.creator_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "task_fk_10",
			columns: [table.obligation_id, table.plant_id],
			foreignColumns: [obligation.id, obligation.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "task_fk_11", columns: [table.source_template_id], foreignColumns: [reference_version.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "task_fk_12", columns: [table.import_operation_id], foreignColumns: [audit_event.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "task_fk_13",
			columns: [table.milestone_id, table.plant_id],
			foreignColumns: [launch_milestone.id, launch_milestone.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "task_fk_14",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "task_fk_2", columns: [table.assignee_id], foreignColumns: [account.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "task_fk_3",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "task_fk_4",
			columns: [table.meeting_id, table.plant_id],
			foreignColumns: [meeting.id, meeting.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "task_fk_5",
			columns: [table.team_id, table.plant_id],
			foreignColumns: [team.id, team.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "task_fk_6", columns: [table.launch_id], foreignColumns: [launch.plant_id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "task_fk_7",
			columns: [table.parent_id, table.plant_id],
			foreignColumns: [task.id, task.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "task_fk_8",
			columns: [table.series_id, table.plant_id],
			foreignColumns: [recurrence.id, recurrence.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "task_fk_9",
			columns: [table.predecessor_id, table.plant_id],
			foreignColumns: [task.id, task.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "task_pkey", columns: [table.id] }),
		unique("task_uq_0").on(table.id, table.plant_id),
		check("task_ck_0", sql`(revision >= 1)`),
		check(
			"task_ck_1",
			sql`(status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'blocked'::text, 'complete'::text, 'no_longer_needed'::text]))`,
		),
		check("task_ck_10", sql`((launch_id IS NULL) OR (launch_id = plant_id))`),
		check("task_ck_2", sql`(priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'urgent'::text]))`),
		check("task_ck_3", sql`(due_kind = ANY (ARRAY['undated'::text, 'date_only'::text, 'timed'::text]))`),
		check("task_ck_4", sql`(num_nonnulls(person_id, meeting_id, team_id, launch_id) <= 1)`),
		check("task_ck_5", sql`((parent_id IS NULL) OR (parent_id <> id))`),
		check(
			"task_ck_6",
			sql`((parent_id IS NULL) OR ((due_kind = 'undated'::text) AND (series_id IS NULL) AND (occurrence_key IS NULL) AND (predecessor_id IS NULL) AND (obligation_id IS NULL) AND (num_nonnulls(person_id, meeting_id, team_id, launch_id) = 0)))`,
		),
		check(
			"task_ck_7",
			sql`(((due_kind = 'undated'::text) AND (num_nonnulls(due_date, due_time, timezone, due_at, resolver_version) = 0)) OR ((due_kind = 'date_only'::text) AND (due_date IS NOT NULL) AND (num_nonnulls(due_time, timezone, due_at, resolver_version) = 0)) OR ((due_kind = 'timed'::text) AND (num_nonnulls(due_date, due_time, timezone, due_at, resolver_version) = 5)))`,
		),
		check("task_ck_8", sql`((status = 'complete'::text) = (completed_at IS NOT NULL))`),
		check(
			"task_ck_9",
			sql`(category = ANY (ARRAY['administrative'::text, 'vision_meeting'::text, 'follow_up'::text, 'general'::text, 'ministry_team'::text, 'launch_prep'::text, 'training'::text, 'promotion'::text, 'recurring'::text]))`,
		),
		check("task_timezone_iana", sql`(timezone = ANY (${canonicalZones7}))`),
		index("task_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("task_ref_1").using("btree", table.creator_id.asc().nullsLast()),
		index("task_ref_10").using("btree", table.obligation_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("task_ref_11").using("btree", table.source_template_id.asc().nullsLast()),
		index("task_ref_12").using("btree", table.import_operation_id.asc().nullsLast()),
		index("task_ref_13").using("btree", table.milestone_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("task_ref_2").using("btree", table.assignee_id.asc().nullsLast()),
		index("task_ref_3").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("task_ref_4").using("btree", table.meeting_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("task_ref_5").using("btree", table.team_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("task_ref_6").using("btree", table.launch_id.asc().nullsLast()),
		index("task_ref_7").using("btree", table.parent_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("task_ref_8").using("btree", table.series_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("task_ref_9").using("btree", table.predecessor_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		uniqueIndex("task_uq_1")
			.using("btree", table.series_id.asc().nullsLast(), table.occurrence_key.asc().nullsLast())
			.where(sql`(series_id IS NOT NULL)`),
		uniqueIndex("task_uq_2")
			.using("btree", table.predecessor_id.asc().nullsLast())
			.where(sql`(predecessor_id IS NOT NULL)`),
		uniqueIndex("task_uq_3")
			.using("btree", table.series_id.asc().nullsLast())
			.where(
				sql`((series_id IS NOT NULL) AND (deleted_at IS NULL) AND (status <> ALL (ARRAY['complete'::text, 'no_longer_needed'::text])))`,
			),
		uniqueIndex("task_uq_4")
			.using("btree", table.obligation_id.asc().nullsLast())
			.where(sql`((obligation_id IS NOT NULL) AND (deleted_at IS NULL))`),
		uniqueIndex("task_uq_5")
			.using("btree", table.milestone_id.asc().nullsLast(), table.seed_key.asc().nullsLast())
			.where(sql`(seed_key IS NOT NULL)`),
	],
);
export const task_dependency = pgTable(
	"task_dependency",
	{
		plant_id: uuid("plant_id").notNull(),
		task_id: uuid("task_id").notNull(),
		prerequisite_id: uuid("prerequisite_id").notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "task_dependency_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "task_dependency_fk_1",
			columns: [table.task_id, table.plant_id],
			foreignColumns: [task.id, task.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "task_dependency_fk_2",
			columns: [table.prerequisite_id, table.plant_id],
			foreignColumns: [task.id, task.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "task_dependency_pkey", columns: [table.plant_id, table.task_id, table.prerequisite_id] }),
		check("task_dependency_ck_0", sql`(task_id <> prerequisite_id)`),
		index("task_dependency_ref_1").using("btree", table.task_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("task_dependency_ref_2").using(
			"btree",
			table.prerequisite_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
	],
);
export const team = pgTable(
	"team",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		icon: text("icon"),
		template_version_id: uuid("template_version_id"),
		template_key: text("template_key"),
		state: text("state", { enum: ["forming", "active", "paused"] }).notNull(),
		archived_at: timestamp("archived_at", { withTimezone: true, mode: "date" }),
		sort_order: integer("sort_order").notNull(),
		leader_person_id: uuid("leader_person_id"),
		leader_source: text("leader_source", { enum: ["explicit", "role_derived", "legacy"] }),
		leader_role_id: uuid("leader_role_id"),
		responsibility_offer: text("responsibility_offer", { enum: ["accepted", "declined"] }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
		responsibility_offer_version_id: uuid("responsibility_offer_version_id"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "team_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "team_fk_1", columns: [table.template_version_id], foreignColumns: [reference_version.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "team_fk_2",
			columns: [table.leader_person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "team_fk_3",
			columns: [table.leader_role_id, table.plant_id],
			foreignColumns: [team_role.id, team_role.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "team_fk_4",
			columns: [table.responsibility_offer_version_id],
			foreignColumns: [reference_version.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "team_fk_5",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "team_pkey", columns: [table.id] }),
		unique("team_uq_0").on(table.id, table.plant_id),
		check("team_ck_0", sql`(revision >= 1)`),
		check("team_ck_1", sql`(state = ANY (ARRAY['forming'::text, 'active'::text, 'paused'::text]))`),
		check("team_ck_2", sql`(leader_source = ANY (ARRAY['explicit'::text, 'role_derived'::text, 'legacy'::text]))`),
		check("team_ck_3", sql`(responsibility_offer = ANY (ARRAY['accepted'::text, 'declined'::text]))`),
		check("team_ck_4", sql`((leader_person_id IS NULL) = (leader_source IS NULL))`),
		check("team_ck_5", sql`((responsibility_offer IS NULL) = (responsibility_offer_version_id IS NULL))`),
		index("team_ref_1").using("btree", table.template_version_id.asc().nullsLast()),
		index("team_ref_2").using("btree", table.leader_person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("team_ref_3").using("btree", table.leader_role_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("team_ref_4").using("btree", table.responsibility_offer_version_id.asc().nullsLast()),
		uniqueIndex("team_uq_1")
			.using("btree", table.plant_id.asc().nullsLast(), table.template_key.asc().nullsLast())
			.where(sql`(template_key IS NOT NULL)`),
	],
);
export const team_role = pgTable(
	"team_role",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		team_id: uuid("team_id").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		leadership: boolean("leadership").notNull(),
		time_commitment: text("time_commitment"),
		desired_skills: text("desired_skills"),
		sort_order: integer("sort_order").notNull(),
		template_key: text("template_key"),
		retired_at: timestamp("retired_at", { withTimezone: true, mode: "date" }),
		responsibility_key: text("responsibility_key", {
			enum: [
				"worship",
				"children",
				"assimilation",
				"small_groups",
				"administration_finance",
				"facilities",
				"promotion",
				"technology",
				"prayer",
			],
		}),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "team_role_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "team_role_fk_1",
			columns: [table.team_id, table.plant_id],
			foreignColumns: [team.id, team.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "team_role_fk_2",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "team_role_pkey", columns: [table.id] }),
		unique("team_role_uq_0").on(table.id, table.plant_id),
		check("team_role_ck_0", sql`(revision >= 1)`),
		check(
			"team_role_ck_1",
			sql`(responsibility_key = ANY (ARRAY['worship'::text, 'children'::text, 'assimilation'::text, 'small_groups'::text, 'administration_finance'::text, 'facilities'::text, 'promotion'::text, 'technology'::text, 'prayer'::text]))`,
		),
		index("team_role_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("team_role_ref_1").using("btree", table.team_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		uniqueIndex("team_role_uq_1")
			.using("btree", table.team_id.asc().nullsLast(), table.template_key.asc().nullsLast())
			.where(sql`(template_key IS NOT NULL)`),
	],
);
export const team_tenure = pgTable(
	"team_tenure",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		role_id: uuid("role_id").notNull(),
		person_id: uuid("person_id").notNull(),
		started_on: date("started_on", { mode: "string" }).notNull(),
		ended_on: date("ended_on", { mode: "string" }),
		previous_tenure_id: uuid("previous_tenure_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "team_tenure_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "team_tenure_fk_1",
			columns: [table.role_id, table.plant_id],
			foreignColumns: [team_role.id, team_role.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "team_tenure_fk_2",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "team_tenure_fk_3",
			columns: [table.previous_tenure_id, table.plant_id],
			foreignColumns: [team_tenure.id, team_tenure.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "team_tenure_fk_4",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "team_tenure_pkey", columns: [table.id] }),
		unique("team_tenure_uq_0").on(table.id, table.plant_id),
		check("team_tenure_ck_0", sql`(revision >= 1)`),
		check("team_tenure_ck_1", sql`((ended_on IS NULL) OR (ended_on >= started_on))`),
		index("team_tenure_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("team_tenure_ref_1").using("btree", table.role_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("team_tenure_ref_2").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("team_tenure_ref_3").using(
			"btree",
			table.previous_tenure_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		uniqueIndex("team_tenure_uq_1")
			.using("btree", table.role_id.asc().nullsLast())
			.where(sql`(ended_on IS NULL)`),
	],
);
export const tenant = pgTable(
	"tenant",
	{
		id: uuid("id").notNull(),
		kind: text("kind", { enum: ["account", "plant", "organization", "global"] }).notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		primaryKey({ name: "tenant_pkey", columns: [table.id] }),
		check(
			"tenant_ck_0",
			sql`(kind = ANY (ARRAY['account'::text, 'plant'::text, 'organization'::text, 'global'::text]))`,
		),
		check("tenant_ck_1", sql`((kind = 'global'::text) = (id = '00000000-0000-0000-0000-000000000000'::uuid))`),
	],
);
export const training_assignment = pgTable(
	"training_assignment",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		person_id: uuid("person_id").notNull(),
		program_id: uuid("program_id").notNull(),
		version_id: uuid("version_id").notNull(),
		assigned_on: date("assigned_on", { mode: "string" }).notNull(),
		ended_on: date("ended_on", { mode: "string" }),
		selection_operation_id: uuid("selection_operation_id").notNull(),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "training_assignment_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_assignment_fk_1",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_assignment_fk_2",
			columns: [table.program_id, table.plant_id],
			foreignColumns: [training_program.id, training_program.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_assignment_fk_3",
			columns: [table.version_id, table.program_id],
			foreignColumns: [training_version.id, training_version.program_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_assignment_fk_4",
			columns: [table.selection_operation_id],
			foreignColumns: [audit_event.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_assignment_fk_5",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "training_assignment_pkey", columns: [table.id] }),
		unique("training_assignment_uq_0").on(table.id, table.plant_id),
		check("training_assignment_ck_0", sql`(revision >= 1)`),
		index("training_assignment_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("training_assignment_ref_1").using(
			"btree",
			table.person_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("training_assignment_ref_2").using(
			"btree",
			table.program_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("training_assignment_ref_3").using(
			"btree",
			table.version_id.asc().nullsLast(),
			table.program_id.asc().nullsLast(),
		),
		index("training_assignment_ref_4").using("btree", table.selection_operation_id.asc().nullsLast()),
		uniqueIndex("training_assignment_uq_1")
			.using("btree", table.person_id.asc().nullsLast(), table.program_id.asc().nullsLast())
			.where(sql`(ended_on IS NULL)`),
	],
);
export const training_credit = pgTable(
	"training_credit",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		person_id: uuid("person_id").notNull(),
		version_id: uuid("version_id").notNull(),
		assignment_id: uuid("assignment_id"),
		completed_on: date("completed_on", { mode: "string" }).notNull(),
		recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
		notes: text("notes"),
		revoked_at: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
		prior_credit_id: uuid("prior_credit_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "training_credit_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_credit_fk_1",
			columns: [table.person_id, table.plant_id],
			foreignColumns: [person.id, person.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_credit_fk_2",
			columns: [table.version_id, table.plant_id],
			foreignColumns: [training_version.id, training_version.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_credit_fk_3",
			columns: [table.assignment_id, table.plant_id],
			foreignColumns: [training_assignment.id, training_assignment.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_credit_fk_4",
			columns: [table.prior_credit_id, table.plant_id],
			foreignColumns: [training_credit.id, training_credit.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_credit_fk_5",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "training_credit_pkey", columns: [table.id] }),
		unique("training_credit_uq_0").on(table.id, table.plant_id),
		check("training_credit_ck_0", sql`(revision >= 1)`),
		index("training_credit_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("training_credit_ref_1").using("btree", table.person_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("training_credit_ref_2").using("btree", table.version_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("training_credit_ref_3").using(
			"btree",
			table.assignment_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("training_credit_ref_4").using(
			"btree",
			table.prior_credit_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		uniqueIndex("training_credit_uq_1")
			.using("btree", table.person_id.asc().nullsLast(), table.version_id.asc().nullsLast())
			.where(sql`(revoked_at IS NULL)`),
	],
);
export const training_program = pgTable(
	"training_program",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		team_id: uuid("team_id"),
		name: text("name").notNull(),
		description: text("description"),
		required: boolean("required").notNull(),
		archived_at: timestamp("archived_at", { withTimezone: true, mode: "date" }),
		current_version_id: uuid("current_version_id"),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "training_program_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_program_fk_1",
			columns: [table.team_id, table.plant_id],
			foreignColumns: [team.id, team.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_program_fk_2",
			columns: [table.current_version_id, table.plant_id],
			foreignColumns: [training_version.id, training_version.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_program_fk_3",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "training_program_pkey", columns: [table.id] }),
		unique("training_program_uq_0").on(table.id, table.plant_id),
		check("training_program_ck_0", sql`(revision >= 1)`),
		index("training_program_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("training_program_ref_1").using("btree", table.team_id.asc().nullsLast(), table.plant_id.asc().nullsLast()),
		index("training_program_ref_2").using(
			"btree",
			table.current_version_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
	],
);
export const training_requirement = pgTable(
	"training_requirement",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		version_id: uuid("version_id").notNull(),
		requirement_key: text("requirement_key").notNull(),
		kind: text("kind", { enum: ["human", "reading"] }).notNull(),
		description: text("description").notNull(),
		article_id: uuid("article_id"),
		source_revision_id: uuid("source_revision_id"),
		minimum_fraction: numeric("minimum_fraction"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "training_requirement_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_requirement_fk_1",
			columns: [table.version_id, table.plant_id],
			foreignColumns: [training_version.id, training_version.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({ name: "training_requirement_fk_2", columns: [table.article_id], foreignColumns: [reference_item.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_requirement_fk_3",
			columns: [table.source_revision_id],
			foreignColumns: [article_revision.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_requirement_fk_4",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "training_requirement_pkey", columns: [table.id] }),
		unique("training_requirement_uq_0").on(table.id, table.plant_id),
		unique("training_requirement_uq_1").on(table.version_id, table.requirement_key),
		check("training_requirement_ck_0", sql`(kind = ANY (ARRAY['human'::text, 'reading'::text]))`),
		check(
			"training_requirement_ck_1",
			sql`((kind = 'reading'::text) = ((article_id IS NOT NULL) AND (source_revision_id IS NOT NULL) AND (minimum_fraction IS NOT NULL)))`,
		),
		index("training_requirement_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("training_requirement_ref_1").using(
			"btree",
			table.version_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("training_requirement_ref_2").using("btree", table.article_id.asc().nullsLast()),
		index("training_requirement_ref_3").using("btree", table.source_revision_id.asc().nullsLast()),
	],
);
export const training_version = pgTable(
	"training_version",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		program_id: uuid("program_id").notNull(),
		version_number: integer("version_number").notNull(),
		source_hash: text("source_hash").notNull(),
		compatible_prior_id: uuid("compatible_prior_id"),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "training_version_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_version_fk_1",
			columns: [table.program_id, table.plant_id],
			foreignColumns: [training_program.id, training_program.plant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_version_fk_2",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "training_version_fk_3",
			columns: [table.compatible_prior_id, table.program_id],
			foreignColumns: [training_version.id, training_version.program_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "training_version_pkey", columns: [table.id] }),
		unique("training_version_uq_0").on(table.id, table.plant_id),
		unique("training_version_uq_1").on(table.program_id, table.version_number),
		unique("training_version_uq_2").on(table.id, table.program_id),
		check("training_version_ck_0", sql`((compatible_prior_id IS NULL) OR (compatible_prior_id <> id))`),
		index("training_version_ref_0").using("btree", table.plant_id.asc().nullsLast()),
		index("training_version_ref_1").using(
			"btree",
			table.program_id.asc().nullsLast(),
			table.plant_id.asc().nullsLast(),
		),
		index("training_version_ref_3").using(
			"btree",
			table.compatible_prior_id.asc().nullsLast(),
			table.program_id.asc().nullsLast(),
		),
	],
);
export const venue = pgTable(
	"venue",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		name: text("name").notNull(),
		address: text("address").notNull(),
		contact_name: text("contact_name"),
		phone: text("phone"),
		email: text("email"),
		cost_description: text("cost_description"),
		capacity: integer("capacity"),
		notes: text("notes"),
		archived_at: timestamp("archived_at", { withTimezone: true, mode: "date" }),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "venue_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "venue_fk_1",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "venue_pkey", columns: [table.id] }),
		unique("venue_uq_0").on(table.id, table.plant_id),
		check("venue_ck_0", sql`(revision >= 1)`),
		check("venue_ck_1", sql`((capacity IS NULL) OR (capacity >= 1))`),
		index("venue_ref_0").using("btree", table.plant_id.asc().nullsLast()),
	],
);
export const wiki_preference = pgTable(
	"wiki_preference",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		plant_id: uuid("plant_id").notNull(),
		organization_id: uuid("organization_id").notNull(),
		recognition_operation_id: uuid("recognition_operation_id").notNull(),
		group_kind: text("group_kind", { enum: ["sending_church", "sending_network"] }).notNull(),
		position: integer("position").notNull(),
		revision: int64("revision")
			.notNull()
			.default(sql`1`),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({ name: "wiki_preference_fk_0", columns: [table.plant_id], foreignColumns: [plant.id] })
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "wiki_preference_fk_1",
			columns: [table.plant_id, table.organization_id],
			foreignColumns: [affiliation.plant_id, affiliation.organization_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "wiki_preference_fk_2",
			columns: [table.recognition_operation_id],
			foreignColumns: [audit_event.id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "wiki_preference_fk_3",
			columns: [table.id, table.plant_id],
			foreignColumns: [record.id, record.tenant_id],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		foreignKey({
			name: "wiki_preference_fk_4",
			columns: [table.organization_id, table.group_kind],
			foreignColumns: [organization.id, organization.kind],
		})
			.onDelete("restrict")
			.onUpdate("no action"),
		primaryKey({ name: "wiki_preference_pkey", columns: [table.id] }),
		unique("wiki_preference_uq_0").on(table.id, table.plant_id),
		unique("wiki_preference_uq_1").on(table.plant_id, table.organization_id),
		unique("wiki_preference_uq_2").on(table.plant_id, table.group_kind, table.position),
		check("wiki_preference_ck_0", sql`(revision >= 1)`),
		check("wiki_preference_ck_1", sql`(group_kind = ANY (ARRAY['sending_church'::text, 'sending_network'::text]))`),
		check("wiki_preference_ck_2", sql`("position" >= 0)`),
		index("wiki_preference_ref_2").using("btree", table.recognition_operation_id.asc().nullsLast()),
		index("wiki_preference_ref_4").using(
			"btree",
			table.organization_id.asc().nullsLast(),
			table.group_kind.asc().nullsLast(),
		),
	],
);

export const onboarding_setup = pgTable(
	"onboarding_setup",
	{
		plant_id: uuid("plant_id")
			.primaryKey()
			.references(() => plant.id),
		account_id: uuid("account_id")
			.notNull()
			.unique()
			.references(() => account.id),
		creation_operation_id: uuid("creation_operation_id")
			.notNull()
			.unique()
			.references(() => audit_event.id),
		lead: jsonb("lead").notNull(),
		journey: jsonb("journey").notNull(),
		launch: jsonb("launch").notNull(),
		people_step: text("people_step", { enum: ["pending", "saved", "skipped"] }).notNull(),
		completed_material_revision: int64("completed_material_revision"),
	},
	(t): PgTableExtraConfigValue[] => [
		check("onboarding_people_step", sql`${t.people_step} IN ('pending','saved','skipped')`),
		check(
			"onboarding_completion_revision",
			sql`${t.completed_material_revision} IS NULL OR ${t.completed_material_revision} >= 1`,
		),
	],
);
export const settings_preview = pgTable(
	"settings_preview",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		account_id: uuid("account_id")
			.notNull()
			.references(() => account.id),
		tenant_id: uuid("tenant_id")
			.notNull()
			.references(() => tenant.id),
		kind: text("kind", { enum: ["plant_timezone", "personal_timezone"] }).notNull(),
		expected_revision: int64("expected_revision").notNull(),
		value: jsonb("value").notNull(),
		expires_at: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(t): PgTableExtraConfigValue[] => [
		check("settings_preview_kind", sql`${t.kind} IN ('plant_timezone','personal_timezone')`),
	],
);

/** Attributable domain changes and their optional exact-request reply. Ordinary writers append only. */
export const audit_event = pgTable(
	"audit_event",
	{
		id: uuid("id")
			.notNull()
			.default(sql`gen_random_uuid()`),
		tenant_id: uuid("tenant_id").notNull(),
		actor_id: uuid("actor_id"),
		actor_token: text("actor_token"),
		system_cause: text("system_cause"),
		action: text("action").notNull(),
		kind: text("kind").notNull(),
		subject_type: text("subject_type").notNull().default("record"),
		subject_id: uuid("subject_id").notNull(),
		before_value: jsonb("before_value"),
		after_value: jsonb("after_value"),
		occurred_at: timestamp("occurred_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`clock_timestamp()`),
		recorded_at: timestamp("recorded_at", { withTimezone: true, mode: "date" })
			.notNull()
			.default(sql`clock_timestamp()`),
		before_revision: int64("before_revision"),
		after_revision: int64("after_revision"),
		reason: text("reason"),
		request_key: text("request_key"),
		request_identity: jsonb("request_identity"),
		result: jsonb("result"),
		command_id: uuid("command_id"),
		event_key: text("event_key"),
		metadata: jsonb("metadata").notNull().default({}),
	},
	(table): PgTableExtraConfigValue[] => [
		check(
			"audit_action",
			sql.raw(
				"(action IN ('account.deletion_requested','affiliation.approved','affiliation.ended','attestation.corrected','attestation.recorded','audit.imported','communication.approved','communication.send_intended','deletion.cancelled','deletion.live_purge_completed','documents.copied','documents.saved','execution.cancelled','execution.completed','execution.partial','execution.reconciled','execution.started','feedback.publication_intended','feedback.published','feedback.received','feedback.reconciled','files.finalized','followup.corrected','followup.recorded','identity.credential_changed','identity.credential_observed','identity.credential_reconciled','identity.domain_accepted','identity.email_changed','identity.sessions_revoked','intelligence.feedback_recorded','intelligence.published','intelligence.requested','intelligence.superseded','invitation.changed','invitation.claimed','invitation.revoked','launch.changed','launch.corrected','launch.debrief_submitted','launch.outcome_recorded','launch.summary_published','mail.accepted','mail.cancelled','mail.delivered','mail.reconciled','mail.refused','meetings.changed','meetings.corrected','meetings.finalized','meetings.response_recorded','meetings.rsvp_recorded','membership.created','membership.ended','membership.role_changed','note_correction','organization.profile_changed','people.corrected','people.created','people.merged','people.recorded','people.restored','people.retired','people.stage_changed','people.unmerged','people.updated','phase.created','phase.declared','phase.transitioned','plant.created','plant.deletion_requested','plant.profile_changed','recovery.copy_expired','recovery.restored','reference.activated','roles.changed','security.access_denied','security.audit_exported','security.audit_inspected','security.bulk_export','security.operator_accessed','settings.changed','sharing.changed','tasks.changed','tasks.completed','tasks.waived','teams.changed','training.assigned','training.assignment_removed','training.completed','training.corrected','training.revoked','wiki.hidden','wiki.published','wiki.source_order_changed'))",
			),
		),
		check(
			"audit_kind",
			sql.raw(
				"(kind IN ('create','edit','correct','retire','restore','merge','unmerge','stage_change','classification_change','commitment_change','assign','remove','accept','revoke','resend','role_change','leader_change','tick','untick','archive','earn','revoke_credit','offer_answer','publish','hide','read','progress','complete','reopen','waive','supersede','finalize','reconcile','noop','triage','suppress','suppression_clear','preference','model_attempt','tool_attempt','effect_result','mail_member','outcome','declaration','movement'))",
			),
		),
		check("audit_attribution", sql`num_nonnulls(actor_id,actor_token,system_cause)>=1`),
		check(
			"audit_projection",
			sql`jsonb_typeof(metadata)='object' AND (metadata->'diff' IS NULL OR (jsonb_typeof(metadata->'diff')='object' AND octet_length(convert_to((metadata->'diff')::text,'UTF8'))<=2048))`,
		),
		foreignKey({ name: "audit_command", columns: [table.command_id], foreignColumns: [audit_event.id] }).onDelete(
			"set null",
		),
		foreignKey({ name: "audit_public_subject", columns: [table.subject_id], foreignColumns: [record.id] }),
		primaryKey({ name: "audit_event_pkey", columns: [table.id] }),
		unique("audit_event_identity").on(table.id, table.tenant_id),
		unique("audit_request_key").on(table.tenant_id, table.request_key),
		unique("audit_event_key").on(table.subject_id, table.event_key),
		foreignKey({ name: "audit_event_owner", columns: [table.tenant_id], foreignColumns: [tenant.id] }),
		foreignKey({ name: "audit_event_actor", columns: [table.actor_id], foreignColumns: [account.id] }).onDelete(
			"set null",
		),
		index("audit_subject_history").on(table.tenant_id, table.subject_id, table.occurred_at, table.id),
		index("audit_command").on(table.command_id),
	],
);
