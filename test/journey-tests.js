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
export async function runTests(
	test,
	assert,
	{ connections, stopsByNorm, stopsById, dateStr, t0 },
) {
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

	/**
	 * Synthetic connections — Pareto dominance filter.
	 *
	 * Four direct trips all share the same origin (A) and destination (B),
	 * but two different service types:
	 *
	 *   T1    dep=100  arr=200  type=''    — same structure as T2, dominated by it
	 *   T2    dep=150  arr=200  type=''    — Pareto-optimal within its group
	 *   T_fee dep=160  arr=190  type='tgv' — different structural group from T1/T2
	 *   T3    dep=200  arr=350  type=''    — Pareto-optimal within its group
	 *
	 * T_fee departs later AND arrives earlier than T2. A naïve cross-type Pareto
	 * filter would therefore remove T2, hiding the bike-fine option from the
	 * user. The structural-group filter must prevent that: only journeys in the
	 * same group (same stops × type per leg) are compared, so T2 survives.
	 */
	await test('Pareto filter: dominated journeys are removed', () => {
		const syntheticConnections = [
			// T1: dominated within its group by T2 (same arrival, later departure)
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_timestamp: 100,
				arr_timestamp: 200,
				trip_id: 'T1',
				type: '',
			},
			// T2: bike-fine, Pareto-optimal within its group
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_timestamp: 150,
				arr_timestamp: 200,
				trip_id: 'T2',
				type: '',
			},
			// T_fee: tgv (fee-required), departs later AND arrives earlier than T2
			//        but belongs to a different structural group — must NOT remove T2
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_timestamp: 160,
				arr_timestamp: 190,
				trip_id: 'T_fee',
				type: 'tgv',
			},
			// T3: bike-fine, Pareto-optimal (later departure, later arrival)
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_timestamp: 200,
				arr_timestamp: 350,
				trip_id: 'T3',
				type: '',
			},
		]

		const options = findOptions(syntheticConnections, ['A'], ['B'], 0, 10)

		assert(
			options.length === 3,
			`Expected 3 journeys (T2, T_fee, T3), got ${options.length}: ` +
				JSON.stringify(
					options.map((o) => ({
						dep: o.departureTime,
						arr: o.arrivalTime,
						type: o.path[0].type,
					})),
				),
		)
		assert(
			options.every((o) => o.departureTime !== 100),
			`Dominated journey T1 (dep=100, arr=200, type='') must not appear in results`,
		)
		assert(
			options.some((o) => o.departureTime === 150 && o.arrivalTime === 200),
			`Bike-fine journey T2 (dep=150, arr=200) must survive even though T_fee ` +
				`departs later (160) and arrives earlier (190)`,
		)
		assert(
			options.some((o) => o.departureTime === 160 && o.arrivalTime === 190),
			`Fee journey T_fee (dep=160, arr=190) must be present`,
		)
		assert(
			options.some((o) => o.departureTime === 200 && o.arrivalTime === 350),
			`Journey T3 (dep=200, arr=350) must be present`,
		)
	})

	/**
	 * Grenoble → Paris Gare de Lyon: no returned journey is dominated by another.
	 *
	 * This route is known to produce many journeys sharing the same final leg
	 * (Chambéry → Paris) but with different — often long — waits at Chambéry.
	 * After the Pareto filter, no result should be strictly worse than another
	 * in both departure time and arrival time.
	 */
	await test('Grenoble → Paris Gare de Lyon: no result is Pareto-dominated', () => {
		const origins = findMatchingStops('Grenoble', stopsByNorm)
		const dests = findMatchingStops(
			'Paris Gare de Lyon Hall 1 - 2',
			stopsByNorm,
		)
		assert(origins.length > 0, `No stops found matching "Grenoble"`)
		assert(
			dests.length > 0,
			`No stops found matching "Paris Gare de Lyon Hall 1 - 2"`,
		)

		const options = findOptions(connections, origins, dests, t0, 10)
		assert(
			options.length > 0,
			`Expected ≥1 journey from Grenoble to Paris Gare de Lyon on ${dateStr} after 08:00, got 0`,
		)

		for (const j of options) {
			const jKey = j.path
				.map((l) => `${l.dep_stop}:${l.arr_stop}:${l.type}`)
				.join('|')
			const dominatedBy = options.find(
				(other) =>
					other !== j &&
					other.path
						.map((l) => `${l.dep_stop}:${l.arr_stop}:${l.type}`)
						.join('|') === jKey &&
					other.departureTime >= j.departureTime &&
					other.arrivalTime <= j.arrivalTime &&
					(other.departureTime > j.departureTime ||
						other.arrivalTime < j.arrivalTime),
			)
			assert(
				dominatedBy === undefined,
				`Journey (dep=${j.departureTime}, arr=${j.arrivalTime}) is dominated by ` +
					`(dep=${dominatedBy?.departureTime}, arr=${dominatedBy?.arrivalTime})`,
			)
		}
	})

	/**
	 * Lyon Part-Dieu → Grenoble, departing on a weekday morning.
	 *
	 * The K6 TER line (Lyon Part-Dieu – Grenoble) runs daily.  At least one
	 * of the returned options must be fully bookable on the SNCF TER website:
	 * every leg's departure stop and arrival stop must carry a `ter_id` (set
	 * by the TER Stop Indices section embedded in timetable.bin at build time).
	 *
	 * This catches regressions where the TER annotation is missing or the
	 * binary parser fails to read the TER Stop Indices section.
	 */
	await test('Lyon Part-Dieu → Grenoble: at least one option is fully bookable on TER', () => {
		const origins = findMatchingStops('Lyon Part-Dieu', stopsByNorm)
		const dests = findMatchingStops('Grenoble', stopsByNorm)
		assert(origins.length > 0, 'No stops found for "Lyon Part-Dieu"')
		assert(dests.length > 0, 'No stops found for "Grenoble"')
		assert(connections.length > 0, `No connections materialised for ${dateStr}`)

		const options = findOptions(connections, origins, dests, t0, 5)
		assert(
			options.length > 0,
			`Expected ≥1 journey from Lyon Part-Dieu to Grenoble on ${dateStr}, got 0.\n` +
				`origins=${JSON.stringify(origins)}\ndests=${JSON.stringify(dests)}`,
		)

		// Simulate formatOption: every leg must have ter_id on both endpoints.
		const fullyBookable = options.some((opt) =>
			opt.path.every((leg) => {
				const from = stopsById.get(leg.dep_stop)
				const to = stopsById.get(leg.arr_stop)
				return from?.ter_id && to?.ter_id
			}),
		)

		assert(
			fullyBookable,
			`Expected ≥1 option where every leg has both dep_ter_id and arr_ter_id set, ` +
				`but none found among ${options.length} option(s).\n` +
				options
					.map(
						(o, i) =>
							`  Option ${i + 1}: ` +
							o.path
								.map(
									(l) =>
										`${stopsById.get(l.dep_stop)?.stop_name}` +
										`(ter=${stopsById.get(l.dep_stop)?.ter_id}) → ` +
										`${stopsById.get(l.arr_stop)?.stop_name}` +
										`(ter=${stopsById.get(l.arr_stop)?.ter_id})`,
								)
								.join(', '),
					)
					.join('\n'),
		)
	})
}
