/**
 * voyage-ter/worker.js
 *
 * ES-module web worker entry point.
 * Loads GTFS data on first search, runs CSA, and returns results.
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
} from './gtfs-loader.js'
import { findOptions } from './csa.js'

// ── Configuration ─────────────────────────────────────────────────────────────

const GTFS_BASE = 'data/gtfs'
const MAX_RESULTS = 3

// ── GTFS state (loaded once, shared across all search calls) ──────────────────

let gtfsData = null // populated after first successful load
let loadingPromise = null // in-flight Promise while loading

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
				loadingPromise = null // allow retry on next search
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

// ── Mock data (fallback when GTFS unavailable) ────────────────────────────────

function makeMockResults(query) {
	const dep = query.departure || 'Departure'
	const arr = query.arrival || 'Arrival'
	const base = query.datetime ? new Date(query.datetime) : new Date()
	// round up to nearest 15 minutes
	const t = Math.ceil(base.getTime() / (15 * 60 * 1000)) * 15 * 60 * 1000

	return Array.from({ length: MAX_RESULTS }, (_, i) => {
		const start = t + i * 20 * 60 * 1000
		const leg1Min = 20 + Math.floor(Math.random() * 30)
		const leg2Min = 15 + Math.floor(Math.random() * 25)
		const mid = dep + ' → (changement)'
		return {
			duration: leg1Min + leg2Min,
			connexions: [
				{
					from: dep,
					to: mid,
					start: new Date(start).toISOString(),
					duration: leg1Min,
				},
				{
					from: mid,
					to: arr,
					start: new Date(start + (leg1Min + 5) * 60000).toISOString(),
					duration: leg2Min,
				},
			],
		}
	})
}

// ── Search ────────────────────────────────────────────────────────────────────

async function search(query, requestId) {
	const data = await ensureGTFS(requestId)
	const { rawConnections, stopsById, stopsByNorm, servicesByDate } = data

	// Resolve stop IDs for departure / arrival
	const originIds = findMatchingStops(query.departure || '', stopsByNorm)
	const destIds = findMatchingStops(query.arrival || '', stopsByNorm)

	if (originIds.length === 0) {
		throw new Error(`No stop found for departure: "${query.departure}"`)
	}
	if (destIds.length === 0) {
		throw new Error(`No stop found for arrival: "${query.arrival}"`)
	}

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

	if (type !== 'search') return

	try {
		const results = await search(query, requestId)

		if (results.length === 0) {
			// No routes found with real data – fall back to mock so the UI isn't empty
			self.postMessage({
				type: 'results',
				results: makeMockResults(query),
				requestId,
				mock: true,
			})
		} else {
			self.postMessage({ type: 'results', results, requestId })
		}
	} catch (err) {
		// GTFS unavailable or search error – return mock data with a flag
		console.warn('[worker] Falling back to mock data:', err.message)
		self.postMessage({
			type: 'results',
			results: makeMockResults(query),
			requestId,
			mock: true,
		})
	}
})
