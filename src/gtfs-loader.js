/**
 * GTFS data loader for a web worker context (uses fetch).
 * Parses the VTER v1 binary timetable format produced by scripts/build_timetable.rb.
 * @module gtfs-loader
 *
 * ╭────────────────────────────────────────────────────────────────────────╮
 * │ Copyright (C) 2026-present  Ulysse Buonomo                             │
 * │                                                                        │
 * │ This program is free software: you can redistribute it and/or modify   │
 * │ it under the terms of the GNU General Public License as published by   │
 * │ the Free Software Foundation, either version 3 of the License, or      │
 * │  (at your option) any later version.                                   │
 * │                                                                        │
 * │ This program is distributed in the hope that it will be useful,        │
 * │ but WITHOUT ANY WARRANTY; without even the implied warranty of         │
 * │ MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the          │
 * │ GNU General Public License for more details.                           │
 * │                                                                        │
 * │ You should have received a copy of the GNU General Public License      │
 * │ along with this program.  If not, see <https://www.gnu.org/licenses/>. │
 * ╰────────────────────────────────────────────────────────────────────────╯
 */

// ---------- internal helpers ----------

/**
 * Normalize a stop name: lowercase, strip NFD accents, replace non-alphanum with spaces.
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
	return name
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]/g, ' ')
		.trim()
		.replace(/\s+/g, ' ')
}

// ---------- binary parser ----------

/**
 * Parse a VTER v1 binary timetable ArrayBuffer.
 *
 * Binary layout:
 *   Header (24 bytes):
 *     [0-3]   ASCII "VTER"
 *     [4-7]   uint32 LE  format_version = 1
 *     [8-9]   uint16 LE  num_stops
 *     [10-11] uint16 LE  num_services
 *     [12-13] uint16 LE  num_trips   (count only)
 *     [14-15] uint16 LE  reserved
 *     [16-19] uint32 LE  num_connections
 *     [20-23] uint32 LE  num_calendar_entries
 *
 *   Stops section (num_stops variable-length records):
 *     uint16 LE  stop_id byte length
 *     N bytes    stop_id UTF-8
 *     uint16 LE  stop_name byte length
 *     M bytes    stop_name UTF-8
 *     float32 LE latitude
 *     float32 LE longitude
 *
 *   Services section (num_services variable-length records):
 *     uint16 LE  service_id byte length
 *     N bytes    service_id UTF-8
 *
 *   Calendar section (num_calendar_entries × 6 bytes, sorted by date):
 *     uint32 LE  date as YYYYMMDD integer (e.g. 20260706)
 *     uint16 LE  service_idx
 *
 *   Connections section (num_connections × 16 bytes, sorted by dep_secs):
 *     uint16 LE  dep_stop_idx
 *     uint16 LE  arr_stop_idx
 *     uint32 LE  dep_secs
 *     uint32 LE  arr_secs
 *     uint16 LE  trip_idx
 *     uint16 LE  service_idx
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{
 *   rawConnections: Array,
 *   stopsById:      Map<string, Object>,
 *   stopsByNorm:    Map<string, string[]>,
 *   servicesByDate: Map<string, Set<string>>
 * }}
 * @throws {Error} if magic bytes are not "VTER" or format_version !== 1
 */
export function parseTimetable(arrayBuffer) {
	const view = new DataView(arrayBuffer)
	const decoder = new TextDecoder()

	// ── Validate header ────────────────────────────────────────────────────────

	const magic = String.fromCharCode(
		view.getUint8(0),
		view.getUint8(1),
		view.getUint8(2),
		view.getUint8(3),
	)
	if (magic !== 'VTER') {
		throw new Error(
			`Invalid timetable file: expected magic "VTER", got "${magic}"`,
		)
	}

	const formatVersion = view.getUint32(4, true)
	if (formatVersion !== 1) {
		throw new Error(
			`Unsupported VTER format version: ${formatVersion} (only version 1 is supported)`,
		)
	}

	const numStops = view.getUint16(8, true)
	const numServices = view.getUint16(10, true)
	// numTrips              = view.getUint16(12, true)  — count only, strings not stored
	// reserved              = view.getUint16(14, true)
	const numConnections = view.getUint32(16, true)
	const numCalendarEntries = view.getUint32(20, true)

	let offset = 24

	// ── Parse stops ────────────────────────────────────────────────────────────

	/** @type {string[]} index → stop_id */
	const stopIdsByIdx = []
	/** @type {Map<string, {stop_id: string, stop_name: string, stop_lat: number, stop_lon: number}>} */
	const stopsById = new Map()
	/** @type {Map<string, string[]>} */
	const stopsByNorm = new Map()

	for (let i = 0; i < numStops; i++) {
		const idLen = view.getUint16(offset, true)
		offset += 2
		const stopId = decoder.decode(new Uint8Array(arrayBuffer, offset, idLen))
		offset += idLen

		const nameLen = view.getUint16(offset, true)
		offset += 2
		const stopName = decoder.decode(
			new Uint8Array(arrayBuffer, offset, nameLen),
		)
		offset += nameLen

		const lat = view.getFloat32(offset, true)
		offset += 4
		const lon = view.getFloat32(offset, true)
		offset += 4

		stopIdsByIdx.push(stopId)
		stopsById.set(stopId, {
			stop_id: stopId,
			stop_name: stopName,
			stop_lat: lat,
			stop_lon: lon,
		})

		const norm = normalizeName(stopName)
		if (norm) {
			let list = stopsByNorm.get(norm)
			if (!list) {
				list = []
				stopsByNorm.set(norm, list)
			}
			list.push(stopId)
		}
	}

	// ── Parse services ─────────────────────────────────────────────────────────

	/** @type {string[]} index → service_id */
	const serviceIdsByIdx = []

	for (let i = 0; i < numServices; i++) {
		const idLen = view.getUint16(offset, true)
		offset += 2
		const serviceId = decoder.decode(new Uint8Array(arrayBuffer, offset, idLen))
		offset += idLen
		serviceIdsByIdx.push(serviceId)
	}

	// ── Parse calendar ─────────────────────────────────────────────────────────

	/** @type {Map<string, Set<string>>} "YYYYMMDD" → Set<service_id> */
	const servicesByDate = new Map()

	for (let i = 0; i < numCalendarEntries; i++) {
		const dateInt = view.getUint32(offset, true) // e.g. 20260706
		offset += 4
		const serviceIdx = view.getUint16(offset, true)
		offset += 2

		const dateStr = String(dateInt) // → "20260706"
		const serviceId = serviceIdsByIdx[serviceIdx]

		let set = servicesByDate.get(dateStr)
		if (!set) {
			set = new Set()
			servicesByDate.set(dateStr, set)
		}
		set.add(serviceId)
	}

	// ── Parse connections ──────────────────────────────────────────────────────

	/** @type {Array<{dep_stop: string, arr_stop: string, dep_secs: number, arr_secs: number, trip_id: number, service_id: string}>} */
	const rawConnections = []

	for (let i = 0; i < numConnections; i++) {
		const depStopIdx = view.getUint16(offset, true)
		offset += 2
		const arrStopIdx = view.getUint16(offset, true)
		offset += 2
		const depSecs = view.getUint32(offset, true)
		offset += 4
		const arrSecs = view.getUint32(offset, true)
		offset += 4
		const tripIdx = view.getUint16(offset, true)
		offset += 2
		const serviceIdx = view.getUint16(offset, true)
		offset += 2

		rawConnections.push({
			dep_stop: stopIdsByIdx[depStopIdx],
			arr_stop: stopIdsByIdx[arrStopIdx],
			dep_secs: depSecs,
			arr_secs: arrSecs,
			trip_id: tripIdx, // integer; CSA only uses it as a Map key
			service_id: serviceIdsByIdx[serviceIdx],
		})
	}
	// rawConnections is already sorted by dep_secs per the VTER spec

	return { rawConnections, stopsById, stopsByNorm, servicesByDate }
}

// ---------- public exports ----------

/**
 * Fetch and parse the VTER v1 binary timetable for the given base path.
 * Caching is the caller's responsibility (see worker.js ensureGTFS).
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
	const base = basePath.replace(/\/$/, '')
	const res = await fetch(`${base}/timetable.bin`)
	if (!res.ok) {
		throw new Error(
			`Failed to fetch timetable.bin: ${res.status} ${res.statusText}`,
		)
	}
	const buffer = await res.arrayBuffer()
	return parseTimetable(buffer)
}

/**
 * Filter rawConnections to those active on queryDate and convert dep_secs / arr_secs
 * to absolute Unix timestamps using the local midnight of that date.
 * If servicesByDate has no entry for queryDate, all connections are included.
 *
 * @param {Array}  rawConnections   From parseTimetable() / loadGTFS()
 * @param {Map}    servicesByDate   From parseTimetable() / loadGTFS()
 * @param {string} queryDate        YYYYMMDD
 * @returns {Array}  Connections sorted by dep_timestamp, each:
 *                   { dep_stop, arr_stop, dep_timestamp, arr_timestamp, trip_id }
 */
export function materializeConnections(
	rawConnections,
	servicesByDate,
	queryDate,
) {
	const services = servicesByDate.get(queryDate) // undefined → accept all

	const yr = +queryDate.slice(0, 4)
	const mo = +queryDate.slice(4, 6) - 1 // 0-based month
	const dy = +queryDate.slice(6, 8)
	const midnight = Math.floor(new Date(yr, mo, dy, 0, 0, 0, 0).getTime() / 1000)

	const result = []
	for (const rc of rawConnections) {
		if (services && !services.has(rc.service_id)) continue
		result.push({
			dep_stop: rc.dep_stop,
			arr_stop: rc.arr_stop,
			dep_timestamp: midnight + rc.dep_secs,
			arr_timestamp: midnight + rc.arr_secs,
			trip_id: rc.trip_id,
		})
	}

	// rawConnections is already sorted by dep_secs; adding a constant preserves order
	return result
}

/**
 * Find stop IDs whose normalised name is an exact match for the query.
 * Returns an empty array when no stop matches, which the caller treats as an
 * invalid station name.
 *
 * @param {string}               query
 * @param {Map<string,string[]>} stopsByNorm
 * @returns {string[]}
 */
export function findMatchingStops(query, stopsByNorm) {
	const norm = normalizeName(query)
	if (!norm) return []

	const exact = stopsByNorm.get(norm)
	return exact ? [...exact] : []
}

/**
 * Suggest up to `limit` unique stop display names whose normalised name starts
 * with (prefix, ranked first) or contains (substring, ranked second) the
 * normalised query.
 *
 * @param {string}               query
 * @param {Map<string,string[]>} stopsByNorm   norm → [stop_id, …]
 * @param {Map<string,Object>}   stopsById     stop_id → stop row
 * @param {number}               [limit=8]
 * @returns {string[]}
 */
export function suggestStopNames(query, stopsByNorm, stopsById, limit = 8) {
	const norm = normalizeName(query)
	if (norm.length < 2) return []

	const prefixNames = new Set()
	const substrNames = new Set()

	for (const [key, ids] of stopsByNorm) {
		const isPre = key.startsWith(norm)
		const isSub = !isPre && key.includes(norm)
		if (!isPre && !isSub) continue
		const bucket = isPre ? prefixNames : substrNames
		for (const id of ids) {
			const stop = stopsById.get(id)
			if (stop && stop.stop_name) bucket.add(stop.stop_name)
		}
	}

	// Remove names already in the prefix bucket from the substring bucket
	for (const name of prefixNames) substrNames.delete(name)

	return [...prefixNames]
		.sort()
		.concat([...substrNames].sort())
		.slice(0, limit)
}
