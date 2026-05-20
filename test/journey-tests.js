/**
 * Shared test cases for easy-bici.
 *
 * This module is environment-agnostic: it works in a browser (test/index.html)
 * and in Node.js (test/run.js).  Callers supply the test harness primitives
 * and the pre-resolved GTFS context so that loading strategy (fetch vs fs)
 * and date-picking stay in the caller.
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

import { findMatchingStops } from '../src/gtfs-loader.js'
import { findOptions } from '../src/csa.js'

/**
 * Pick the weekday nearest to the middle of the feed's date range.
 * Using a dynamic date means tests keep passing after the daily GTFS update.
 *
 * @param {Map<string, Set<string>>} servicesByDate
 * @returns {string} YYYYMMDD
 */
export function findTestDate(servicesByDate) {
	const dates = [...servicesByDate.keys()].sort()
	if (dates.length === 0) throw new Error('No dates found in timetable')
	const mid = Math.floor(dates.length / 2)
	for (let off = 0; off < dates.length; off++) {
		for (const idx of [mid + off, mid - off]) {
			if (idx < 0 || idx >= dates.length) continue
			const d = dates[idx]
			const day = new Date(
				+d.slice(0, 4),
				+d.slice(4, 6) - 1,
				+d.slice(6, 8),
			).getDay() // 0 = Sun … 6 = Sat
			if (day >= 1 && day <= 5) return d
		}
	}
	return dates[mid] // fallback: any date
}

/**
 * Register all test cases with the given harness.
 *
 * @param {(name: string, fn: () => void | Promise<void>) => Promise<void>} test
 *   Harness function — records pass/fail and renders output.
 * @param {(condition: boolean, message: string) => void} assert
 *   Throws on failure.
 * @param {{ connections: Array, stopsByNorm: Map, dateStr: string, t0: number }} ctx
 *   Pre-resolved context from the caller:
 *     connections  — materialized (date-filtered, timestamped) connections
 *     stopsByNorm  — normalised-name → stop-ID map
 *     dateStr      — YYYYMMDD used (for error messages)
 *     t0           — Unix timestamp for 08:00 on dateStr
 */
export async function runTests(test, assert, { connections, stopsByNorm, dateStr, t0 }) {
	/**
	 * Grenoble → Vannes, departing on a weekday morning.
	 *
	 * This route requires a service-type change at an intermediate station
	 * (e.g. TER → TGV INOUI at Lyon Part-Dieu).  It was failing because the
	 * binary timetable stored operator-specific StopPoint IDs
	 * (StopPoint:OCETrain TER-XXXXXXXX, StopPoint:OCETGV INOUI-XXXXXXXX, …)
	 * for the same physical station, making CSA unable to transfer between
	 * them.  The fix normalises all stop IDs to their parent StopArea in
	 * build_timetable.rb, so inter-service transfers work transparently.
	 */
	await test('Grenoble → Vannes: finds journeys departing on a weekday morning', () => {
		const origins = findMatchingStops('Grenoble', stopsByNorm)
		const dests = findMatchingStops('Vannes', stopsByNorm)
		assert(origins.length > 0, `No stops found matching "Grenoble"`)
		assert(dests.length > 0, `No stops found matching "Vannes"`)
		assert(connections.length > 0, `No connections materialised for ${dateStr}`)

		const options = findOptions(connections, origins, dests, t0, 3)
		assert(
			options.length > 0,
			`Expected ≥1 journey from Grenoble to Vannes on ${dateStr} after 08:00, got 0.\n` +
				`origins=${JSON.stringify(origins)}\ndests=${JSON.stringify(dests)}\n` +
				`connections on that day: ${connections.length}`,
		)
	})

	/**
	 * Grenoble → Nantes, departing on a weekday morning.
	 *
	 * The most natural routing goes Grenoble → Lyon Part-Dieu (TER) then
	 * Lyon Part-Dieu → Nantes (Intercités / TGV).  This test verifies that
	 * at least one of the returned journey options uses exactly that
	 * two-train itinerary — no spurious intermediate stops or extra changes.
	 */
	await test('Grenoble → Nantes: finds a 2-train journey via Lyon Part-Dieu', () => {
		const origins = findMatchingStops('Grenoble', stopsByNorm)
		const dests = findMatchingStops('Nantes', stopsByNorm)
		const lyonPD = findMatchingStops('Lyon Part-Dieu', stopsByNorm)
		assert(origins.length > 0, `No stops found matching "Grenoble"`)
		assert(dests.length > 0, `No stops found matching "Nantes"`)
		assert(lyonPD.length > 0, `No stops found matching "Lyon Part-Dieu"`)
		assert(connections.length > 0, `No connections materialised for ${dateStr}`)

		// Fetch up to 5 options to maximise the chance of finding a direct
		// two-leg routing among the earliest departures.
		const options = findOptions(connections, origins, dests, t0, 5)
		assert(
			options.length > 0,
			`Expected ≥1 journey from Grenoble to Nantes on ${dateStr} after 08:00, got 0.\n` +
				`origins=${JSON.stringify(origins)}\ndests=${JSON.stringify(dests)}\n` +
				`connections on that day: ${connections.length}`,
		)

		const lyonPDSet = new Set(lyonPD)
		const twoLegViaLyon = options.some(
			({ path }) =>
				path.length === 2 &&
				lyonPDSet.has(path[0].arr_stop) &&
				lyonPDSet.has(path[1].dep_stop),
		)
		assert(
			twoLegViaLyon,
			`Expected ≥1 journey with exactly 2 legs (Grenoble→Lyon Part-Dieu, Lyon Part-Dieu→Nantes), ` +
				`but none found among ${options.length} option(s).\n` +
				`options=${JSON.stringify(options.map((o) => o.path.map((l) => `${l.dep_stop}→${l.arr_stop}`)))}\n` +
				`Lyon Part-Dieu stops: ${JSON.stringify(lyonPD)}`,
		)
	})
}
