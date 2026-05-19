/**
 * GTFS data loader for a web worker context (uses fetch).
 * @module gtfs-loader
 */

const NON_BIKE_KW = ['TGV', 'OUIGO', 'INOUIGO', 'INOUI'];

// ---------- internal helpers ----------

/**
 * Normalize a stop name: lowercase, strip NFD accents, replace non-alphanum with spaces.
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Parse a GTFS HH:MM:SS time string (hours may be >= 24) to seconds since midnight.
 * @param {string} s
 * @returns {number}
 */
function parseGTFSTime(s) {
  const c1 = s.indexOf(':');
  const c2 = s.indexOf(':', c1 + 1);
  return +s.slice(0, c1) * 3600 + +s.slice(c1 + 1, c2) * 60 + +s.slice(c2 + 1);
}

/**
 * Minimal CSV parser. Handles BOM and \r\n line endings.
 * Does NOT support quoted fields containing commas.
 * @param {string} text
 * @returns {Object[]}
 */
function parseCSV(text) {
  if (!text) return [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const lines = text.split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].replace(/\r$/, '').split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line) continue;
    const vals = line.split(',');
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = vals[j] ?? '';
    rows.push(row);
  }
  return rows;
}

/**
 * Fast line-scanner for stop_times.txt.
 * Extracts only columns 0–4 (trip_id, arrival_time, departure_time, stop_id, stop_sequence).
 * Lines whose trip_id is not in bikeTrips are skipped immediately after reading trip_id.
 *
 * @param {string}                              text       Raw file text
 * @param {Map<string, string>}                 bikeTrips  trip_id → service_id
 * @param {Map<string, Array>}                  tripStops  Output: trip_id → stop entries
 */
function scanStopTimes(text, bikeTrips, tripStops) {
  if (!text) return;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let pos = text.indexOf('\n') + 1; // skip header line
  const len = text.length;

  while (pos < len) {
    let lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = len;

    // column 0: trip_id  (ends at first comma)
    const c0 = text.indexOf(',', pos);
    if (c0 < 0 || c0 >= lineEnd) { pos = lineEnd + 1; continue; }
    const trip_id = text.slice(pos, c0);

    // Early exit for non-bike trips
    if (!bikeTrips.has(trip_id)) { pos = lineEnd + 1; continue; }

    // column 1: arrival_time
    const c1 = text.indexOf(',', c0 + 1);
    if (c1 < 0 || c1 >= lineEnd) { pos = lineEnd + 1; continue; }

    // column 2: departure_time
    const c2 = text.indexOf(',', c1 + 1);
    if (c2 < 0 || c2 >= lineEnd) { pos = lineEnd + 1; continue; }

    // column 3: stop_id
    const c3 = text.indexOf(',', c2 + 1);
    if (c3 < 0 || c3 >= lineEnd) { pos = lineEnd + 1; continue; }

    // column 4: stop_sequence (ends at next comma or line end)
    const c4 = text.indexOf(',', c3 + 1);
    const seqEnd = c4 < 0 || c4 >= lineEnd ? lineEnd : c4;

    const arr_secs      = parseGTFSTime(text.slice(c0 + 1, c1));
    const dep_secs      = parseGTFSTime(text.slice(c1 + 1, c2));
    const stop_id       = text.slice(c2 + 1, c3);
    const stop_sequence = parseInt(text.slice(c3 + 1, seqEnd), 10);

    let arr = tripStops.get(trip_id);
    if (!arr) { arr = []; tripStops.set(trip_id, arr); }
    arr.push({ stop_id, arr_secs, dep_secs, stop_sequence });

    pos = lineEnd + 1;
  }
}

// ---------- public exports ----------

/**
 * Load all required GTFS files and return parsed data structures.
 *
 * @param {string} basePath  URL/path prefix for the GTFS directory (no trailing slash needed)
 * @returns {Promise<{
 *   rawConnections: Array,
 *   stopsById:      Map<string, Object>,
 *   stopsByNorm:    Map<string, string[]>,
 *   servicesByDate: Map<string, Set<string>>
 * }>}
 */
export async function loadGTFS(basePath) {
  const base = basePath.replace(/\/$/, '') + '/';
  const get  = (name) =>
    fetch(base + name).then(r => r.ok ? r.text() : '').catch(() => '');

  const [stopsText, routesText, tripsText, stopTimesText, calText] = await Promise.all([
    get('stops.txt'),
    get('routes.txt'),
    get('trips.txt'),
    get('stop_times.txt'),
    get('calendar_dates.txt'),
  ]);

  // --- stops ---
  const stopsById  = new Map();
  const stopsByNorm = new Map();
  for (const row of parseCSV(stopsText)) {
    stopsById.set(row.stop_id, row);
    const norm = normalizeName(row.stop_name || '');
    if (!norm) continue;
    let list = stopsByNorm.get(norm);
    if (!list) { list = []; stopsByNorm.set(norm, list); }
    list.push(row.stop_id);
  }

  // --- routes → identify non-bike route_ids ---
  const nonBikeRoutes = new Set();
  for (const row of parseCSV(routesText)) {
    const label = ((row.route_short_name || '') + ' ' + (row.route_long_name || '')).toUpperCase();
    if (NON_BIKE_KW.some(kw => label.includes(kw))) nonBikeRoutes.add(row.route_id);
  }

  // --- trips → collect bike-friendly trip_id → service_id ---
  const bikeTrips = new Map();
  for (const row of parseCSV(tripsText)) {
    if (nonBikeRoutes.has(row.route_id)) continue;
    const label = ((row.trip_id || '') + ' ' + (row.trip_headsign || '')).toUpperCase();
    if (NON_BIKE_KW.some(kw => label.includes(kw))) continue;
    bikeTrips.set(row.trip_id, row.service_id);
  }

  // --- calendar_dates ---
  const servicesByDate = new Map();
  for (const row of parseCSV(calText)) {
    if (row.exception_type !== '1') continue;
    let set = servicesByDate.get(row.date);
    if (!set) { set = new Set(); servicesByDate.set(row.date, set); }
    set.add(row.service_id);
  }

  // --- stop_times (fast scanner) ---
  const tripStops = new Map(); // trip_id → [{stop_id, arr_secs, dep_secs, stop_sequence}]
  scanStopTimes(stopTimesText, bikeTrips, tripStops);

  // --- build raw connections from consecutive stop pairs ---
  const rawConnections = [];
  for (const [trip_id, stops] of tripStops) {
    stops.sort((a, b) => a.stop_sequence - b.stop_sequence);
    const service_id = bikeTrips.get(trip_id);
    for (let i = 0; i + 1 < stops.length; i++) {
      rawConnections.push({
        dep_stop:   stops[i].stop_id,
        arr_stop:   stops[i + 1].stop_id,
        dep_secs:   stops[i].dep_secs,
        arr_secs:   stops[i + 1].arr_secs,
        trip_id,
        service_id,
      });
    }
  }

  // rawConnections sorted by dep_secs (ascending)
  rawConnections.sort((a, b) => a.dep_secs - b.dep_secs);

  return { rawConnections, stopsById, stopsByNorm, servicesByDate };
}

/**
 * Filter rawConnections to those active on queryDate and convert dep_secs / arr_secs
 * to absolute Unix timestamps using the local midnight of that date.
 * If servicesByDate has no entry for queryDate, all connections are included.
 *
 * @param {Array}  rawConnections   From loadGTFS()
 * @param {Map}    servicesByDate   From loadGTFS()
 * @param {string} queryDate        YYYYMMDD
 * @returns {Array}  Connections sorted by dep_timestamp, each:
 *                   { dep_stop, arr_stop, dep_timestamp, arr_timestamp, trip_id }
 */
export function materializeConnections(rawConnections, servicesByDate, queryDate) {
  const services = servicesByDate.get(queryDate); // undefined → accept all

  const yr  = +queryDate.slice(0, 4);
  const mo  = +queryDate.slice(4, 6) - 1; // 0-based month
  const dy  = +queryDate.slice(6, 8);
  const midnight = Math.floor(new Date(yr, mo, dy, 0, 0, 0, 0).getTime() / 1000);

  const result = [];
  for (const rc of rawConnections) {
    if (services && !services.has(rc.service_id)) continue;
    result.push({
      dep_stop:      rc.dep_stop,
      arr_stop:      rc.arr_stop,
      dep_timestamp: midnight + rc.dep_secs,
      arr_timestamp: midnight + rc.arr_secs,
      trip_id:       rc.trip_id,
    });
  }

  // rawConnections is already sorted by dep_secs; adding a constant preserves order
  return result;
}

/**
 * Find stop IDs whose normalised name matches query.
 * Returns exact matches first; falls back to partial matches
 * (query is a substring of the stop name, or vice-versa).
 *
 * @param {string}               query
 * @param {Map<string,string[]>} stopsByNorm
 * @returns {string[]}
 */
export function findMatchingStops(query, stopsByNorm) {
  const norm = normalizeName(query);
  if (!norm) return [];

  // Exact match
  if (stopsByNorm.has(norm)) return [...stopsByNorm.get(norm)];

  // Partial match
  const results = [];
  for (const [key, ids] of stopsByNorm) {
    if (key.includes(norm) || norm.includes(key)) results.push(...ids);
  }
  return results;
}
