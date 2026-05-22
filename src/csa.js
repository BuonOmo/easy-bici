/**
 * Pure Connection Scan Algorithm (CSA).
 * @module csa
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

import { MIN_CONNECTION_TIME_SECONDS } from './parameters.js'

/** Binary search: first index i where connections[i].dep_timestamp >= t0. */
function lowerBound(connections, t0) {
	let lo = 0,
		hi = connections.length
	while (lo < hi) {
		const mid = (lo + hi) >>> 1
		if (connections[mid].dep_timestamp < t0) lo = mid + 1
		else hi = mid
	}
	return lo
}

/**
 * Run the Connection Scan Algorithm to find the earliest-arrival journey.
 * The returned `path` is an array of legs:
 *   { trip_id, dep_stop, dep_timestamp, arr_stop, arr_timestamp }
 *
 * @param {Array}    connections  Sorted by dep_timestamp: { dep_stop, arr_stop, dep_timestamp, arr_timestamp, trip_id }
 * @param {string[]} origins     Stop IDs all reachable at t0
 * @param {string[]} dests       Target stop IDs
 * @param {number}   t0          Earliest departure Unix timestamp (seconds)
 * @returns {{ path: Array|null, departureTime: number, arrivalTime: number }}
 */
export function runCSA(connections, origins, dests, t0) {
	const originSet = new Set(origins)
	const destSet = new Set(dests)

	// earliest known arrival time at stop (seconds)
	const T = new Map()
	// index of connection that last improved T[stop]
	const In = new Map()
	// trip_id -> true once boarded
	const inTrip = new Map()

	for (const o of origins) T.set(o, t0)

	let bestArrival = Infinity
	let bestDest = null

	const start = lowerBound(connections, t0)

	for (let i = start; i < connections.length; i++) {
		const c = connections[i]

		// Early termination: no later departure can beat the best arrival found
		if (c.dep_timestamp > bestArrival) break

		// Determine if we can board connection `c`.
		// - If already in the trip, we can board without further checks.
		// - Otherwise, the departure stop must be reachable in time.
		//   * If the reachability came from an origin (no In entry), allow boarding
		//     as long as T[dep_stop] <= dep_timestamp (origin boarding).
		//   * If the reachability came from another connection (transfer), require
		//     additional MIN_CONNECTION_TIME_SECONDS.
		let canBoard = false

		if (inTrip.has(c.trip_id)) {
			canBoard = true
		} else if (T.has(c.dep_stop)) {
			const arriveTime = T.get(c.dep_stop)
			if (In.has(c.dep_stop)) {
				// This arrival was produced by a previous connection → enforce min connection time.
				if (arriveTime + MIN_CONNECTION_TIME_SECONDS <= c.dep_timestamp) {
					canBoard = true
				}
			} else {
				// Arrival comes from an origin (initial presence). Allow boarding if arrival <= dep.
				if (arriveTime <= c.dep_timestamp) {
					canBoard = true
				}
			}
		}

		if (!canBoard) continue

		inTrip.set(c.trip_id, true)

		const prevArr = T.get(c.arr_stop) ?? Infinity
		if (c.arr_timestamp < prevArr) {
			T.set(c.arr_stop, c.arr_timestamp)
			In.set(c.arr_stop, i)

			if (destSet.has(c.arr_stop) && c.arr_timestamp < bestArrival) {
				bestArrival = c.arr_timestamp
				bestDest = c.arr_stop
			}
		}
	}

	if (bestDest === null) return { path: null, departureTime: 0, arrivalTime: 0 }

	// Reconstruct path of connections backwards from bestDest by following In[]
	const connectionsPath = []
	let stop = bestDest
	const seen = new Set()
	while (In.has(stop) && !seen.has(stop)) {
		seen.add(stop)
		const conn = connections[In.get(stop)]
		connectionsPath.push(conn)
		stop = conn.dep_stop
		if (originSet.has(stop)) break
	}
	connectionsPath.reverse()

	// Validate that path starts at an origin
	if (
		connectionsPath.length === 0 ||
		!originSet.has(connectionsPath[0].dep_stop)
	) {
		return { path: null, departureTime: 0, arrivalTime: 0 }
	}

	// Compress consecutive connections on the same trip into legs.
	// Each leg is the contiguous span of connections with the same trip_id.
	const legs = []
	for (let i = 0; i < connectionsPath.length; ) {
		const first = connectionsPath[i]
		let j = i + 1
		let last = first
		while (
			j < connectionsPath.length &&
			connectionsPath[j].trip_id === first.trip_id
		) {
			last = connectionsPath[j]
			j++
		}
		// Create compressed leg: board at first.dep_stop at first.dep_timestamp,
		// alight at last.arr_stop at last.arr_timestamp.
		legs.push({
			trip_id: first.trip_id,
			dep_stop: first.dep_stop,
			dep_timestamp: first.dep_timestamp,
			arr_stop: last.arr_stop,
			arr_timestamp: last.arr_timestamp,
			type: first.type || '',
		})
		i = j
	}

	return {
		path: legs, // compressed legs only (no intermediate stops while on same trip)
		departureTime: legs[0].dep_timestamp,
		arrivalTime: bestArrival,
	}
}

/**
 * Score a single journey against the rest of the candidate pool.
 * Higher score → better option.
 *
 * Criteria (all relative to the pool unless stated absolutely):
 *   +100  Earlier arrival   (normalised 0–100; 100 = earliest in pool)
 *   − 20² Per change        (absolute penalty: –20 × (path.length - 1)²)
 *   + 50  Shorter duration  (normalised 0–50;  50 = shortest in pool)
 *   + 25  Closest departure (normalised 0–25;  25 = closest to t0 in pool)
 *
 * @param {{ path: Array, departureTime: number, arrivalTime: number }} option
 * @param {number} t0  Original requested departure (Unix seconds)
 * @param {{ minArrival: number, maxArrival: number,
 *           minDuration: number, maxDuration: number,
 *           minOffset:  number, maxOffset:  number }} stats
 * @returns {number}
 */
function scoreOption(option, t0, stats) {
	const { path, departureTime, arrivalTime } = option
	const duration = arrivalTime - departureTime
	const offset = departureTime - t0 // ≥ 0: seconds after requested departure

	const {
		minArrival,
		maxArrival,
		minDuration,
		maxDuration,
		minOffset,
		maxOffset,
	} = stats

	// Normalised arrival score (100 for earliest, 0 for latest)
	const arrRange = maxArrival - minArrival
	const arrivalScore =
		arrRange > 0 ? ((maxArrival - arrivalTime) / arrRange) * 100 : 100

	// Absolute connection penalty
	const connectionPenalty = -20 * (path.length - 1) * (path.length - 1)

	// Normalised duration score (50 for shortest, 0 for longest)
	const durRange = maxDuration - minDuration
	const durationScore =
		durRange > 0 ? ((maxDuration - duration) / durRange) * 50 : 50

	// Normalised departure-proximity score (25 for closest to t0, 0 for latest)
	const offRange = maxOffset - minOffset
	const offsetScore = offRange > 0 ? ((maxOffset - offset) / offRange) * 25 : 25

	return arrivalScore + connectionPenalty + durationScore + offsetScore
}

/**
 * Collect every feasible journey from t0 until no more exist, then return
 * the top maxResults options ranked by a multi-criteria score.
 *
 * Scoring criteria (see scoreOption):
 *   +100  Earlier arrival (normalised)
 *   − 20  Per leg/train   (absolute)
 *   + 50  Shorter duration (normalised)
 *   + 25  Closest to requested departure (normalised)
 *
 * @param {Array}    connections  Sorted by dep_timestamp
 * @param {string[]} origins
 * @param {string[]} dests
 * @param {number}   t0           Earliest departure Unix timestamp (seconds)
 * @param {number}   [maxResults=10]
 * @returns {Array<{ path: Array, departureTime: number, arrivalTime: number, score: number }>}
 */
export function findOptions(connections, origins, dests, t0, maxResults = 10) {
	// 1. Collect every reachable journey from t0 until the timetable is exhausted.
	const all = []
	let cur = t0
	while (true) {
		const result = runCSA(connections, origins, dests, cur)
		if (result.path === null) break
		all.push(result)
		cur = result.departureTime + 1
	}

	if (all.length === 0) return []

	// 2. Compute pool-wide min/max for normalised scoring.
	let minArrival = Infinity,
		maxArrival = -Infinity
	let minDuration = Infinity,
		maxDuration = -Infinity
	let minOffset = Infinity,
		maxOffset = -Infinity

	for (const j of all) {
		const duration = j.arrivalTime - j.departureTime
		const offset = j.departureTime - t0
		if (j.arrivalTime < minArrival) minArrival = j.arrivalTime
		if (j.arrivalTime > maxArrival) maxArrival = j.arrivalTime
		if (duration < minDuration) minDuration = duration
		if (duration > maxDuration) maxDuration = duration
		if (offset < minOffset) minOffset = offset
		if (offset > maxOffset) maxOffset = offset
	}

	const stats = {
		minArrival,
		maxArrival,
		minDuration,
		maxDuration,
		minOffset,
		maxOffset,
	}

	// 3. Score, sort descending, return top maxResults.
	return all
		.map((j) => ({ ...j, score: scoreOption(j, t0, stats) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, maxResults)
}
