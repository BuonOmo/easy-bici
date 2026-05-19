/**
 * Pure Connection Scan Algorithm (CSA).
 * @module csa
 */

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
 * @param {Array}    connections  Sorted by dep_timestamp: { dep_stop, arr_stop, dep_timestamp, arr_timestamp, trip_id }
 * @param {string[]} origins     Stop IDs all reachable at t0
 * @param {string[]} dests       Target stop IDs
 * @param {number}   t0          Earliest departure Unix timestamp (seconds)
 * @returns {{ path: Array|null, departureTime: number, arrivalTime: number }}
 */
export function runCSA(connections, origins, dests, t0) {
	const originSet = new Set(origins)
	const destSet = new Set(dests)

	const T = new Map() // stop → earliest known arrival time
	const In = new Map() // stop → index of connection that last improved T[stop]
	const inTrip = new Map() // trip_id → true once boarded

	for (const o of origins) T.set(o, t0)

	let bestArrival = Infinity
	let bestDest = null

	const start = lowerBound(connections, t0)

	for (let i = start; i < connections.length; i++) {
		const c = connections[i]

		// Early termination: no later departure can beat the best arrival found
		if (c.dep_timestamp > bestArrival) break

		// Boardable if already riding this trip, or dep_stop is reachable in time
		const canBoard =
			inTrip.has(c.trip_id) ||
			(T.has(c.dep_stop) && T.get(c.dep_stop) <= c.dep_timestamp)

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

	// Reconstruct path backwards from bestDest by following In[]
	const path = []
	let stop = bestDest
	const seen = new Set()
	while (In.has(stop) && !seen.has(stop)) {
		seen.add(stop)
		const conn = connections[In.get(stop)]
		path.push(conn)
		stop = conn.dep_stop
		if (originSet.has(stop)) break
	}
	path.reverse()

	if (path.length === 0 || !originSet.has(path[0].dep_stop)) {
		return { path: null, departureTime: 0, arrivalTime: 0 }
	}

	return {
		path,
		departureTime: path[0].dep_timestamp,
		arrivalTime: bestArrival,
	}
}

/**
 * Find up to maxResults journey options by calling runCSA repeatedly,
 * advancing t0 to departureTime+1 after each found journey.
 * @param {Array}    connections
 * @param {string[]} origins
 * @param {string[]} dests
 * @param {number}   t0
 * @param {number}   [maxResults=3]
 * @returns {Array<{ path: Array, departureTime: number, arrivalTime: number }>}
 */
export function findOptions(connections, origins, dests, t0, maxResults = 3) {
	const options = []
	let cur = t0
	while (options.length < maxResults) {
		const result = runCSA(connections, origins, dests, cur)
		if (result.path === null) break
		options.push(result)
		cur = result.departureTime + 1
	}
	return options
}
