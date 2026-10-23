// The independent database probe for evf timing (C114, C118). It runs beside the timing set on its own connections and
// prints one JSON line per round trip: {"k":"read"|"write","s":<epoch ms>,"e":<epoch ms>}.
//   node timing-probe.mjs <package.json that depends on pg> <write: 0|1>     (EVF_PROBE_URL: the quiet database)
// read: SELECT 1 every 100 ms. write: a one-row update and COMMIT every 100 ms, sent as one protocol call, so a slow
// round trip measures the database, not three client round trips.
import { createRequire } from "node:module";

const pg = createRequire(process.argv[2])("pg");
const write = process.argv[3] === "1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loop(kind, statement) {
	const client = new pg.Client({ connectionString: process.env.EVF_PROBE_URL });
	await client.connect();
	if (kind === "write")
		await client.query(
			"CREATE TABLE IF NOT EXISTS evf_timing_probe (id int PRIMARY KEY, at timestamptz NOT NULL); " +
				"INSERT INTO evf_timing_probe VALUES (1, clock_timestamp()) ON CONFLICT (id) DO NOTHING",
		);
	for (;;) {
		const s = Date.now();
		await client.query(statement);
		const e = Date.now();
		process.stdout.write(JSON.stringify({ k: kind, s, e }) + "\n");
		await sleep(Math.max(0, 100 - (e - s)));
	}
}

loop("read", "SELECT 1");
if (write) loop("write", "BEGIN; UPDATE evf_timing_probe SET at = clock_timestamp() WHERE id = 1; COMMIT");
