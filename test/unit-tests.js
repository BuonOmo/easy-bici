/**
 * Pure unit tests for easy-bici — no timetable.bin required.
 *
 * All test cases use synthetic in-memory data so they run without any GTFS
 * fixture and execute in milliseconds.  They complement the integration-level
 * journey tests in journey-tests.js, which validate real route-finding
 * behaviour against the live timetable.
 *
 * Covered modules / functions
 * ───────────────────────────
 *   gtfs-loader : normalizeName, findMatchingStops, suggestStopNames,
 *                 materializeConnections, parseTimetable
 *   csa         : runCSA
 *   journey-tests: findTestDate
 *   i18n        : t, getLocale
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

import {
	normalizeName,
	findMatchingStops,
	suggestStopNames,
	materializeConnections,
	parseTimetable,
} from '../src/gtfs-loader.js'
import { runCSA } from '../src/csa.js'
import { findTestDate } from './journey-tests.js'
import { t, getLocale, DEFAULT_LOCALE } from '../src/i18n.js'
import { MIN_CONNECTION_TIME_SECONDS } from '../src/parameters.js'

// ── VTER v1 binary builder ────────────────────────────────────────────────────

/**
 * Build a minimal VTER v1 binary timetable ArrayBuffer for testing purposes.
 *
 * @param {object} opts
 * @param {Array<{id: string, name: string, lat?: number, lon?: number}>} [opts.stops]
 * @param {string[]} [opts.services]   service_id strings
 * @param {Array<{depStopIdx: number, arrStopIdx: number, depSecs: number, arrSecs: number, tripIdx: number, serviceIdx: number}>} [opts.connections]
 * @param {Array<{date: number, serviceIdx: number}>} [opts.calendar]   date as YYYYMMDD integer
 * @param {number} [opts.numTrips]
 * @param {number[]|null} [opts.terStopIndices]  stop indices for TER section (null = omit)
 * @param {number[]|null} [opts.tripTypes]       type codes per trip (null = omit)
 * @returns {ArrayBuffer}
 */
function buildVTER({
	stops = [],
	services = [],
	connections = [],
	calendar = [],
	numTrips = 0,
	terStopIndices = null,
	tripTypes = null,
} = {}) {
	const enc = new TextEncoder()

	// Encode each section as Uint8Array chunks.
	const stopChunks = stops.map(({ id, name, lat = 0, lon = 0 }) => {
		const idBytes = enc.encode(id)
		const nameBytes = enc.encode(name)
		const chunk = new Uint8Array(
			2 + idBytes.length + 2 + nameBytes.length + 8,
		)
		const dv = new DataView(chunk.buffer)
		let p = 0
		dv.setUint16(p, idBytes.length, true)
		p += 2
		chunk.set(idBytes, p)
		p += idBytes.length
		dv.setUint16(p, nameBytes.length, true)
		p += 2
		chunk.set(nameBytes, p)
		p += nameBytes.length
		dv.setFloat32(p, lat, true)
		p += 4
		dv.setFloat32(p, lon, true)
		return chunk
	})

	const serviceChunks = services.map((id) => {
		const idBytes = enc.encode(id)
		const chunk = new Uint8Array(2 + idBytes.length)
		new DataView(chunk.buffer).setUint16(0, idBytes.length, true)
		chunk.set(idBytes, 2)
		return chunk
	})

	const calSection = new Uint8Array(calendar.length * 6)
	const calDV = new DataView(calSection.buffer)
	for (let i = 0; i < calendar.length; i++) {
		calDV.setUint32(i * 6, calendar[i].date, true)
		calDV.setUint16(i * 6 + 4, calendar[i].serviceIdx, true)
	}

	const connSection = new Uint8Array(connections.length * 16)
	const connDV = new DataView(connSection.buffer)
	for (let i = 0; i < connections.length; i++) {
		const c = connections[i]
		connDV.setUint16(i * 16, c.depStopIdx, true)
		connDV.setUint16(i * 16 + 2, c.arrStopIdx, true)
		connDV.setUint32(i * 16 + 4, c.depSecs, true)
		connDV.setUint32(i * 16 + 8, c.arrSecs, true)
		connDV.setUint16(i * 16 + 12, c.tripIdx, true)
		connDV.setUint16(i * 16 + 14, c.serviceIdx, true)
	}

	let terSection = new Uint8Array(0)
	if (terStopIndices !== null) {
		terSection = new Uint8Array(2 + terStopIndices.length * 2)
		const tDV = new DataView(terSection.buffer)
		tDV.setUint16(0, terStopIndices.length, true)
		for (let i = 0; i < terStopIndices.length; i++) {
			tDV.setUint16(2 + i * 2, terStopIndices[i], true)
		}
	}

	let typesSection = new Uint8Array(0)
	if (tripTypes !== null) {
		typesSection = new Uint8Array(tripTypes)
	}

	const stopSize = stopChunks.reduce((s, c) => s + c.length, 0)
	const serviceSize = serviceChunks.reduce((s, c) => s + c.length, 0)
	const total =
		24 +
		stopSize +
		serviceSize +
		calSection.length +
		connSection.length +
		terSection.length +
		typesSection.length

	const buf = new ArrayBuffer(total)
	const out = new Uint8Array(buf)
	const dv = new DataView(buf)

	// Header
	out[0] = 0x56; out[1] = 0x54; out[2] = 0x45; out[3] = 0x52 // "VTER"
	dv.setUint32(4, 1, true) // version
	dv.setUint16(8, stops.length, true)
	dv.setUint16(10, services.length, true)
	dv.setUint16(12, numTrips, true)
	dv.setUint16(14, 0, true) // reserved
	dv.setUint32(16, connections.length, true)
	dv.setUint32(20, calendar.length, true)

	let off = 24
	for (const chunk of stopChunks) {
		out.set(chunk, off)
		off += chunk.length
	}
	for (const chunk of serviceChunks) {
		out.set(chunk, off)
		off += chunk.length
	}
	out.set(calSection, off)
	off += calSection.length
	out.set(connSection, off)
	off += connSection.length
	out.set(terSection, off)
	off += terSection.length
	out.set(typesSection, off)

	return buf
}

// ── Test suite ────────────────────────────────────────────────────────────────

/**
 * Register all unit tests with the given harness.
 *
 * @param {(name: string, fn: () => void | Promise<void>) => Promise<void>} test
 * @param {(condition: boolean, message: string) => void} assert
 */
export async function runUnitTests(test, assert) {
	// ── normalizeName ──────────────────────────────────────────────────────────

	await test('normalizeName: lowercases ASCII input', () => {
		assert(
			normalizeName('Grenoble') === 'grenoble',
			'Grenoble → grenoble',
		)
		assert(
			normalizeName('LYON PART-DIEU') === 'lyon part dieu',
			'LYON PART-DIEU → lyon part dieu',
		)
	})

	await test('normalizeName: strips NFD accents', () => {
		assert(
			normalizeName('Château-Thierry') === 'chateau thierry',
			'Château → chateau, hyphen → space',
		)
		assert(
			normalizeName('Île-de-France') === 'ile de france',
			'Île → ile',
		)
		assert(
			normalizeName('Étoile') === 'etoile',
			'É → e',
		)
	})

	await test('normalizeName: collapses whitespace and non-alphanum chars', () => {
		assert(
			normalizeName("Gare de l'Est") === 'gare de l est',
			"apostrophe → space",
		)
		assert(
			normalizeName('  Multiple   Spaces  ') === 'multiple spaces',
			'leading/trailing/internal spaces collapsed',
		)
		assert(
			normalizeName('Lyon Part-Dieu') === 'lyon part dieu',
			'hyphen → space',
		)
	})

	await test('normalizeName: empty string returns empty string', () => {
		assert(normalizeName('') === '', 'empty input → empty output')
	})

	// ── findMatchingStops ──────────────────────────────────────────────────────

	await test('findMatchingStops: returns IDs for exact normalised match', () => {
		const stopsByNorm = new Map([
			['grenoble', ['SA:GRE']],
			['lyon part dieu', ['SA:LPD1', 'SA:LPD2']],
		])
		const res = findMatchingStops('Grenoble', stopsByNorm)
		assert(res.length === 1, `expected 1, got ${res.length}`)
		assert(res[0] === 'SA:GRE', `expected SA:GRE, got ${res[0]}`)

		const res2 = findMatchingStops('Lyon Part-Dieu', stopsByNorm)
		assert(res2.length === 2, `expected 2, got ${res2.length}`)
	})

	await test('findMatchingStops: returns empty array when no stop matches', () => {
		const stopsByNorm = new Map([['grenoble', ['SA:GRE']]])
		const res = findMatchingStops('Paris', stopsByNorm)
		assert(res.length === 0, `expected 0, got ${res.length}`)
	})

	await test('findMatchingStops: returns empty array for empty query', () => {
		const stopsByNorm = new Map([['grenoble', ['SA:GRE']]])
		const res = findMatchingStops('', stopsByNorm)
		assert(res.length === 0, `expected 0 for empty query, got ${res.length}`)
	})

	await test('findMatchingStops: matches despite accents and casing', () => {
		const stopsByNorm = new Map([['chateau thierry', ['SA:CT']]])
		const res = findMatchingStops('Château-Thierry', stopsByNorm)
		assert(res.length === 1, `expected 1, got ${res.length}`)
		assert(res[0] === 'SA:CT', `expected SA:CT, got ${res[0]}`)
	})

	// ── suggestStopNames ───────────────────────────────────────────────────────

	await test('suggestStopNames: returns empty for query shorter than 2 chars', () => {
		const stopsByNorm = new Map([['grenoble', ['SA:GRE']]])
		const stopsById = new Map([['SA:GRE', { stop_name: 'Grenoble' }]])
		assert(
			suggestStopNames('g', stopsByNorm, stopsById).length === 0,
			'single char → empty',
		)
		assert(
			suggestStopNames('', stopsByNorm, stopsById).length === 0,
			'empty string → empty',
		)
	})

	await test('suggestStopNames: prefix matches ranked before substring matches', () => {
		const stopsByNorm = new Map([
			['grenoble', ['ID1']],
			['mont grenoble', ['ID2']],
		])
		const stopsById = new Map([
			['ID1', { stop_name: 'Grenoble' }],
			['ID2', { stop_name: 'Mont Grenoble' }],
		])
		const res = suggestStopNames('gren', stopsByNorm, stopsById, 10)
		assert(res.length === 2, `expected 2, got ${res.length}`)
		assert(
			res[0] === 'Grenoble',
			`prefix match should come first, got ${res[0]}`,
		)
		assert(
			res[1] === 'Mont Grenoble',
			`substring match should come second, got ${res[1]}`,
		)
	})

	await test('suggestStopNames: limit parameter is respected', () => {
		const stopsByNorm = new Map(
			['one', 'two', 'three', 'four', 'five'].map((k) => [k, [`ID:${k}`]]),
		)
		const stopsById = new Map(
			['one', 'two', 'three', 'four', 'five'].map((k) => [
				`ID:${k}`,
				{ stop_name: k },
			]),
		)
		// All keys start with '' but we need a real query; all contain 'o'
		const res = suggestStopNames('o', stopsByNorm, stopsById, 2)
		assert(res.length <= 2, `limit not respected: got ${res.length}`)
	})

	await test('suggestStopNames: deduplicates names from multiple stop IDs', () => {
		const stopsByNorm = new Map([['grenoble', ['ID1', 'ID2']]])
		const stopsById = new Map([
			['ID1', { stop_name: 'Grenoble' }],
			['ID2', { stop_name: 'Grenoble' }], // same name
		])
		const res = suggestStopNames('gren', stopsByNorm, stopsById, 10)
		assert(res.length === 1, `expected 1 (deduped), got ${res.length}`)
		assert(res[0] === 'Grenoble', `got ${res[0]}`)
	})

	await test('suggestStopNames: prefix match name is excluded from substring bucket', () => {
		// 'grenoble' both starts with and includes 'gren' — should appear only once
		const stopsByNorm = new Map([['grenoble', ['ID1']]])
		const stopsById = new Map([['ID1', { stop_name: 'Grenoble' }]])
		const res = suggestStopNames('gren', stopsByNorm, stopsById, 10)
		assert(res.length === 1, `expected 1, got ${res.length}`)
	})

	// ── materializeConnections ────────────────────────────────────────────────

	await test('materializeConnections: converts dep_secs/arr_secs to Unix timestamps', () => {
		const rawConnections = [
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_secs: 3600,
				arr_secs: 7200,
				trip_id: 1,
				service_id: 'SVC1',
				type: 'ter',
			},
		]
		const servicesByDate = new Map([['20260101', new Set(['SVC1'])]])
		const result = materializeConnections(
			rawConnections,
			servicesByDate,
			'20260101',
		)
		assert(result.length === 1, `expected 1 connection, got ${result.length}`)
		const midnight = Math.floor(
			new Date(2026, 0, 1, 0, 0, 0).getTime() / 1000,
		)
		assert(
			result[0].dep_timestamp === midnight + 3600,
			`dep_timestamp: expected ${midnight + 3600}, got ${result[0].dep_timestamp}`,
		)
		assert(
			result[0].arr_timestamp === midnight + 7200,
			`arr_timestamp: expected ${midnight + 7200}, got ${result[0].arr_timestamp}`,
		)
		assert(result[0].type === 'ter', `type should be preserved`)
	})

	await test('materializeConnections: filters connections by active services', () => {
		const rawConnections = [
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_secs: 0,
				arr_secs: 100,
				trip_id: 1,
				service_id: 'SVC1',
				type: '',
			},
			{
				dep_stop: 'C',
				arr_stop: 'D',
				dep_secs: 0,
				arr_secs: 100,
				trip_id: 2,
				service_id: 'SVC2',
				type: '',
			},
		]
		const servicesByDate = new Map([['20260101', new Set(['SVC1'])]])
		const result = materializeConnections(
			rawConnections,
			servicesByDate,
			'20260101',
		)
		assert(result.length === 1, `expected 1, got ${result.length}`)
		assert(result[0].dep_stop === 'A', `expected stop A, got ${result[0].dep_stop}`)
	})

	await test('materializeConnections: includes all connections when date has no entry', () => {
		const rawConnections = [
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_secs: 0,
				arr_secs: 100,
				trip_id: 1,
				service_id: 'SVC1',
				type: '',
			},
			{
				dep_stop: 'C',
				arr_stop: 'D',
				dep_secs: 0,
				arr_secs: 100,
				trip_id: 2,
				service_id: 'SVC2',
				type: '',
			},
		]
		const servicesByDate = new Map() // no entry for any date
		const result = materializeConnections(
			rawConnections,
			servicesByDate,
			'20260101',
		)
		assert(
			result.length === 2,
			`expected 2 (no filter), got ${result.length}`,
		)
	})

	await test('materializeConnections: falls back to empty string when type is missing', () => {
		const rawConnections = [
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_secs: 0,
				arr_secs: 100,
				trip_id: 1,
				service_id: 'SVC1',
				// no type property
			},
		]
		const servicesByDate = new Map()
		const result = materializeConnections(
			rawConnections,
			servicesByDate,
			'20260101',
		)
		assert(result[0].type === '', `type should default to '', got '${result[0].type}'`)
	})

	// ── parseTimetable ────────────────────────────────────────────────────────

	await test('parseTimetable: throws on invalid magic bytes', () => {
		const buf = new ArrayBuffer(24) // zeroed — magic will be "\x00\x00\x00\x00"
		const dv = new DataView(buf)
		dv.setUint32(4, 1, true) // valid version, but bad magic
		let threw = false
		try {
			parseTimetable(buf)
		} catch (e) {
			threw = true
			assert(
				e.message.includes('VTER'),
				`error should mention "VTER": ${e.message}`,
			)
		}
		assert(threw, 'expected parseTimetable to throw on bad magic')
	})

	await test('parseTimetable: throws on unsupported format version', () => {
		const buf = new ArrayBuffer(24)
		const out = new Uint8Array(buf)
		out[0] = 0x56; out[1] = 0x54; out[2] = 0x45; out[3] = 0x52 // "VTER"
		new DataView(buf).setUint32(4, 99, true) // version 99
		let threw = false
		try {
			parseTimetable(buf)
		} catch (e) {
			threw = true
			assert(
				e.message.includes('99'),
				`error should mention version 99: ${e.message}`,
			)
		}
		assert(threw, 'expected parseTimetable to throw on bad version')
	})

	await test('parseTimetable: parses stops, services, calendar, and connections', () => {
		const buf = buildVTER({
			stops: [
				{ id: 'StopArea:S1', name: 'Alpha', lat: 1.0, lon: 2.0 },
				{ id: 'StopArea:S2', name: 'Beta', lat: 3.0, lon: 4.0 },
			],
			services: ['SVC_A', 'SVC_B'],
			calendar: [
				{ date: 20260101, serviceIdx: 0 },
				{ date: 20260101, serviceIdx: 1 },
			],
			connections: [
				{
					depStopIdx: 0,
					arrStopIdx: 1,
					depSecs: 3600,
					arrSecs: 7200,
					tripIdx: 0,
					serviceIdx: 0,
				},
			],
			numTrips: 0,
		})

		const { rawConnections, stopsById, stopsByNorm, servicesByDate } =
			parseTimetable(buf)

		// Stops
		assert(stopsById.has('StopArea:S1'), 'stop S1 present')
		assert(
			stopsById.get('StopArea:S1').stop_name === 'Alpha',
			'stop S1 name',
		)
		assert(
			stopsByNorm.has('alpha'),
			'normalised name "alpha" present',
		)
		assert(
			stopsByNorm.has('beta'),
			'normalised name "beta" present',
		)

		// Calendar
		assert(
			servicesByDate.has('20260101'),
			'date 20260101 present',
		)
		const svcs = servicesByDate.get('20260101')
		assert(svcs.has('SVC_A'), 'SVC_A active on 20260101')
		assert(svcs.has('SVC_B'), 'SVC_B active on 20260101')

		// Raw connections
		assert(rawConnections.length === 1, `expected 1 connection, got ${rawConnections.length}`)
		const rc = rawConnections[0]
		assert(rc.dep_stop === 'StopArea:S1', `dep_stop: ${rc.dep_stop}`)
		assert(rc.arr_stop === 'StopArea:S2', `arr_stop: ${rc.arr_stop}`)
		assert(rc.dep_secs === 3600, `dep_secs: ${rc.dep_secs}`)
		assert(rc.arr_secs === 7200, `arr_secs: ${rc.arr_secs}`)
		assert(rc.service_id === 'SVC_A', `service_id: ${rc.service_id}`)
	})

	await test('parseTimetable: annotates stops with ter_id from TER Stop Indices', () => {
		const buf = buildVTER({
			stops: [
				{ id: 'StopArea:OCE87747006', name: 'Grenoble TER' },
				{ id: 'StopArea:S2', name: 'Other Stop' },
			],
			services: [],
			calendar: [],
			connections: [],
			numTrips: 1,
			terStopIndices: [0], // only stop 0 (OCE87747006) is a TER stop
			tripTypes: [1],      // trip 0 = type 1 = "ter"
		})

		const { stopsById } = parseTimetable(buf)

		const terStop = stopsById.get('StopArea:OCE87747006')
		assert(terStop !== undefined, 'TER stop should exist')
		assert(
			terStop.ter_id === '87747006',
			`ter_id should be "87747006", got "${terStop.ter_id}"`,
		)

		const otherStop = stopsById.get('StopArea:S2')
		assert(otherStop !== undefined, 'non-TER stop should exist')
		assert(
			otherStop.ter_id === undefined,
			`non-TER stop should have no ter_id, got "${otherStop.ter_id}"`,
		)
	})

	// ── runCSA ────────────────────────────────────────────────────────────────

	await test('runCSA: returns null path when no connections exist', () => {
		const result = runCSA([], ['A'], ['B'], 0)
		assert(result.path === null, 'path should be null')
	})

	await test('runCSA: finds a direct single-connection journey', () => {
		const conns = [
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_timestamp: 100,
				arr_timestamp: 200,
				trip_id: 1,
				type: '',
			},
		]
		const result = runCSA(conns, ['A'], ['B'], 0)
		assert(result.path !== null, 'should find a path')
		assert(result.path.length === 1, `expected 1 leg, got ${result.path.length}`)
		assert(result.departureTime === 100, `dep: ${result.departureTime}`)
		assert(result.arrivalTime === 200, `arr: ${result.arrivalTime}`)
	})

	await test('runCSA: compresses consecutive connections on the same trip into one leg', () => {
		// A→B and B→C are on trip 1 — should yield a single leg A→C
		const conns = [
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_timestamp: 100,
				arr_timestamp: 150,
				trip_id: 1,
				type: 'ter',
			},
			{
				dep_stop: 'B',
				arr_stop: 'C',
				dep_timestamp: 150,
				arr_timestamp: 200,
				trip_id: 1,
				type: 'ter',
			},
		]
		const result = runCSA(conns, ['A'], ['C'], 0)
		assert(result.path !== null, 'should find a path')
		assert(
			result.path.length === 1,
			`expected 1 compressed leg, got ${result.path.length}`,
		)
		assert(result.path[0].dep_stop === 'A', `dep_stop: ${result.path[0].dep_stop}`)
		assert(result.path[0].arr_stop === 'C', `arr_stop: ${result.path[0].arr_stop}`)
		assert(result.departureTime === 100, `dep: ${result.departureTime}`)
		assert(result.arrivalTime === 200, `arr: ${result.arrivalTime}`)
	})

	await test(`runCSA: allows transfer when gap >= MIN_CONNECTION_TIME_SECONDS (${MIN_CONNECTION_TIME_SECONDS}s)`, () => {
		// Transfer time: 200 → 600 = 400 s ≥ 300 s → allowed
		const conns = [
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_timestamp: 100,
				arr_timestamp: 200,
				trip_id: 1,
				type: '',
			},
			{
				dep_stop: 'B',
				arr_stop: 'C',
				dep_timestamp: 200 + MIN_CONNECTION_TIME_SECONDS + 100,
				arr_timestamp: 200 + MIN_CONNECTION_TIME_SECONDS + 300,
				trip_id: 2,
				type: '',
			},
		]
		const result = runCSA(conns, ['A'], ['C'], 0)
		assert(result.path !== null, 'should find a 2-leg path')
		assert(result.path.length === 2, `expected 2 legs, got ${result.path.length}`)
	})

	await test(`runCSA: rejects transfer when gap < MIN_CONNECTION_TIME_SECONDS (${MIN_CONNECTION_TIME_SECONDS}s)`, () => {
		// Transfer time: 200 → 400 = 200 s < 300 s → not allowed
		const conns = [
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_timestamp: 100,
				arr_timestamp: 200,
				trip_id: 1,
				type: '',
			},
			{
				dep_stop: 'B',
				arr_stop: 'C',
				dep_timestamp: 200 + MIN_CONNECTION_TIME_SECONDS - 100,
				arr_timestamp: 200 + MIN_CONNECTION_TIME_SECONDS + 200,
				trip_id: 2,
				type: '',
			},
		]
		const result = runCSA(conns, ['A'], ['C'], 0)
		assert(
			result.path === null,
			'should not find path when transfer time is too short',
		)
	})

	await test('runCSA: ignores connections departing before t0', () => {
		const conns = [
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_timestamp: 50,
				arr_timestamp: 200,
				trip_id: 1,
				type: '',
			},
		]
		const result = runCSA(conns, ['A'], ['B'], 100)
		assert(
			result.path === null,
			'connection at t=50 should be skipped when t0=100',
		)
	})

	await test('runCSA: departs exactly at t0 (boundary)', () => {
		const conns = [
			{
				dep_stop: 'A',
				arr_stop: 'B',
				dep_timestamp: 100,
				arr_timestamp: 200,
				trip_id: 1,
				type: '',
			},
		]
		const result = runCSA(conns, ['A'], ['B'], 100)
		assert(result.path !== null, 'exact t0 departure should be accepted')
		assert(result.departureTime === 100, `dep: ${result.departureTime}`)
	})

	// ── findTestDate ──────────────────────────────────────────────────────────

	await test('findTestDate: throws when servicesByDate is empty', () => {
		let threw = false
		try {
			findTestDate(new Map())
		} catch (e) {
			threw = true
		}
		assert(threw, 'should throw on empty map')
	})

	await test('findTestDate: returns a weekday when weekdays are available', () => {
		// 2026-07-06 = Monday, 2026-07-11 = Saturday, 2026-07-12 = Sunday
		const sbd = new Map([
			['20260706', new Set()], // Monday
			['20260711', new Set()], // Saturday
			['20260712', new Set()], // Sunday
		])
		const d = findTestDate(sbd)
		const day = new Date(
			+d.slice(0, 4),
			+d.slice(4, 6) - 1,
			+d.slice(6, 8),
		).getDay()
		assert(
			day >= 1 && day <= 5,
			`expected a weekday (1-5), got ${day} for date ${d}`,
		)
	})

	await test('findTestDate: falls back to any date when only weekends exist', () => {
		// 2026-07-11 = Saturday, 2026-07-12 = Sunday
		const sbd = new Map([
			['20260711', new Set()],
			['20260712', new Set()],
		])
		const d = findTestDate(sbd) // should not throw, returns one of the dates
		assert(
			d === '20260711' || d === '20260712',
			`expected one of the two weekend dates, got ${d}`,
		)
	})

	// ── i18n: t() / getLocale() ───────────────────────────────────────────────

	await test('i18n/getLocale: default locale is DEFAULT_LOCALE', () => {
		assert(
			getLocale() === DEFAULT_LOCALE,
			`expected "${DEFAULT_LOCALE}", got "${getLocale()}"`,
		)
	})

	await test('i18n/t: returns the translation string for a known key', () => {
		const dep = t('results.dep')
		assert(
			typeof dep === 'string' && dep.length > 0,
			`t('results.dep') should return a non-empty string, got "${dep}"`,
		)
	})

	await test('i18n/t: returns the key itself when the translation is missing', () => {
		const key = 'this.key.does.not.exist'
		assert(
			t(key) === key,
			`missing key should return itself, got "${t(key)}"`,
		)
	})

	await test('i18n/t: calls function-valued translations and passes args', () => {
		// 'status.found' is a function in both locales
		const zero = t('status.found', 0)
		const one = t('status.found', 1)
		const many = t('status.found', 5)
		assert(
			typeof zero === 'string' && zero.length > 0,
			`n=0 should yield a non-empty string, got "${zero}"`,
		)
		assert(
			typeof one === 'string' && one.length > 0,
			`n=1 should yield a non-empty string, got "${one}"`,
		)
		assert(
			typeof many === 'string' && many.includes('5'),
			`n=5 should include "5" in output, got "${many}"`,
		)
		// The three cases must return distinct strings
		assert(
			zero !== one && one !== many,
			`n=0, n=1, n=5 should return different strings`,
		)
	})
}
