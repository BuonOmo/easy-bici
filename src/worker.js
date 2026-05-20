/**
 * ES-module web worker entry point.
 * Loads GTFS data on first search, runs CSA, and returns results.
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
 *
 * Incoming messages:
 *   { type: 'search', query: { departure, arrival, datetime }, requestId }
 *   { type: 'ping',   requestId }
 *
 * Outgoing messages:
 *   { type: 'results', results, requestId, mock?: true }
 *   { type: 'error',   error,   requestId }
 *   { type: 'pong',    requestId }
 *   { type: 'loading', message, requestId }
 */

import {
	loadGTFS,
	materializeConnections,
	findMatchingStops,
	suggestStopNames,
} from './gtfs-loader.js'
import { findOptions } from './csa.js'

// ── Configuration ─────────────────────────────────────────────────────────────

const GTFS_BASE = '../data'
const MAX_RESULTS = 10

// ── GTFS state (loaded once, shared across all search calls) ──────────────────

let gtfsData = null // populated after first successful load
let loadingPromise = null // in-flight Promise while loading

/**
 * Ensure GTFS data is loaded, fetching timetable.bin on first call.
 * Multiple concurrent callers share the same in-flight loadingPromise so the
 * binary is never fetched more than once per worker lifetime.
 *
 * @param {string} requestId  Passed through to the 'loading' progress message.
 * @returns {Promise<{rawConnections, stopsById, stopsByNorm, servicesByDate}>}
 */
async function ensureGTFS(requestId) {
	if (gtfsData) return gtfsData

	if (!loadingPromise) {
		self.postMessage({
			type: 'loading',
			message: 'Loading timetable data…',
			requestId,
		})
		loadingPromise = loadGTFS(GTFS_BASE)
			.then((data) => {
				gtfsData = data
				return data
			})
			.catch((err) => {
				loadingPromise = null // allow retry on next request
				throw err
			})
	}

	return loadingPromise
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Convert a Date to a YYYYMMDD string in local time. */
function toGTFSDate(date) {
	const y = date.getFullYear()
	const m = String(date.getMonth() + 1).padStart(2, '0')
	const d = String(date.getDate()).padStart(2, '0')
	return `${y}${m}${d}`
}

// ── Result formatting ─────────────────────────────────────────────────────────

function formatOption({ path, arrivalTime }, stopsById) {
	if (!path || path.length === 0) return null

	let totalMinutes = 0
	const connexions = path.map((c) => {
		const from = stopsById.get(c.dep_stop)
		const to = stopsById.get(c.arr_stop)
		const legMins = Math.round((c.arr_timestamp - c.dep_timestamp) / 60)
		totalMinutes += legMins
		return {
			from: from && from.stop_name ? from.stop_name : c.dep_stop,
			to: to && to.stop_name ? to.stop_name : c.arr_stop,
			start: new Date(c.dep_timestamp * 1000).toISOString(),
			duration: legMins,
		}
	})

	return { duration: totalMinutes, connexions }
}

// ── Search ────────────────────────────────────────────────────────────────────

/** Thrown when a station name cannot be resolved to a known stop. */
class InvalidStationError extends Error {
	/** @param {'departure' | 'arrival'} field */
	constructor(field) {
		super(`No stop found for ${field}`)
		this.field = field
	}
}

async function search(query, requestId) {
	const data = await ensureGTFS(requestId)
	const { rawConnections, stopsById, stopsByNorm, servicesByDate } = data

	// Resolve stop IDs for departure / arrival
	const originIds = findMatchingStops(query.departure || '', stopsByNorm)
	const destIds = findMatchingStops(query.arrival || '', stopsByNorm)

	if (originIds.length === 0) throw new InvalidStationError('departure')
	if (destIds.length === 0) throw new InvalidStationError('arrival')

	// Parse departure date/time
	const queryDate = query.datetime ? new Date(query.datetime) : new Date()
	const dateStr = toGTFSDate(queryDate)
	const t0 = Math.floor(queryDate.getTime() / 1000)

	// Build absolute-timestamp connections for the requested date
	const connections = materializeConnections(
		rawConnections,
		servicesByDate,
		dateStr,
	)

	// Run CSA for up to MAX_RESULTS options
	const options = findOptions(connections, originIds, destIds, t0, MAX_RESULTS)

	return options.map((o) => formatOption(o, stopsById)).filter(Boolean)
}

// ── Message handler ───────────────────────────────────────────────────────────

self.addEventListener('message', async ({ data }) => {
	const { type, query, requestId } = data || {}

	if (type === 'ping') {
		self.postMessage({ type: 'pong', requestId })
		return
	}

	if (type === 'autocomplete') {
		try {
			const { stopsByNorm, stopsById } = await ensureGTFS(requestId)
			const suggestions = suggestStopNames(
				data.query || '',
				stopsByNorm,
				stopsById,
				8,
			)
			self.postMessage({
				type: 'suggestions',
				suggestions,
				field: data.field,
				requestId,
			})
		} catch (_err) {
			self.postMessage({
				type: 'suggestions',
				suggestions: [],
				field: data.field,
				requestId,
			})
		}
		return
	}

	if (type !== 'search') return

	try {
		const results = await search(query, requestId)
		self.postMessage({ type: 'results', results, requestId })
	} catch (err) {
		if (err instanceof InvalidStationError) {
			self.postMessage({ type: 'invalid_station', field: err.field, requestId })
		} else {
			self.postMessage({
				type: 'error',
				error: err.message || 'Unknown error',
				requestId,
			})
		}
	}
})
