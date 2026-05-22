#!/usr/bin/env node
/**
 * CLI test runner for easy-bici.
 *
 * Reads data/timetable.bin directly from the filesystem (no HTTP server
 * needed) and delegates all test cases to test/tip-tests.js, which is
 * shared with the browser harness (test/index.html).
 *
 * Exit code: 0 — all tests pass  |  1 — at least one test failed.
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

import { readFileSync, appendFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

import { parseTimetable, materializeConnections } from '../src/gtfs-loader.js'
import { findTestDate, runTests } from './journey-tests.js'
import { runUnitTests } from './unit-tests.js'

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY
const c = (code) => (isTTY ? `\x1b[${code}m` : '')
const GREEN = c('32')
const RED = c('31')
const RESET = c('0')
const BOLD = c('1')
const DIM = c('2')

// ── Load timetable ────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const timetablePath = join(ROOT, 'data', 'timetable.bin')

let gtfs
try {
	const nodeBuffer = readFileSync(timetablePath)
	// Node Buffer may be a view into a shared pool; slice to get a standalone ArrayBuffer.
	const arrayBuffer = nodeBuffer.buffer.slice(
		nodeBuffer.byteOffset,
		nodeBuffer.byteOffset + nodeBuffer.byteLength,
	)
	gtfs = parseTimetable(arrayBuffer)
} catch (err) {
	console.error(`${RED}✗ Failed to load timetable: ${err.message}${RESET}`)
	process.exit(1)
}

const { rawConnections, stopsById, stopsByNorm, servicesByDate } = gtfs

// ── Build test context ────────────────────────────────────────────────────────

const dateStr = findTestDate(servicesByDate)
const connections = materializeConnections(
	rawConnections,
	servicesByDate,
	dateStr,
)

// t0: 08:00 local time on the chosen date (TZ should be Europe/Paris in CI)
const t0 = Math.floor(
	new Date(
		+dateStr.slice(0, 4),
		+dateStr.slice(4, 6) - 1,
		+dateStr.slice(6, 8),
		8,
		0,
		0,
	).getTime() / 1000,
)

console.log(
	`${DIM}timetable : ${rawConnections.length.toLocaleString()} raw connections${RESET}`,
)
console.log(
	`${DIM}test date : ${dateStr}  (${connections.length.toLocaleString()} active connections)${RESET}`,
)
console.log()

// ── Console harness ───────────────────────────────────────────────────────────

const results = []

function assert(condition, message) {
	if (!condition) throw new Error(message)
}

async function test(name, fn) {
	try {
		await fn()
		results.push({ name, passed: true })
		console.log(`${GREEN}✓${RESET}  ${name}`)
	} catch (err) {
		results.push({ name, passed: false, error: err.message })
		console.log(`${RED}✗${RESET}  ${name}`)
		for (const line of err.message.split('\n')) {
			console.log(`   ${DIM}${line}${RESET}`)
		}
	}
}

// ── Run unit tests (no timetable required) ────────────────────────────────────

await runUnitTests(test, assert)

console.log()

// ── Run all tests ─────────────────────────────────────────────────────────────

await runTests(test, assert, {
	connections,
	stopsById,
	stopsByNorm,
	dateStr,
	t0,
})

// ── Summary ───────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.passed).length
const failed = results.filter((r) => !r.passed).length

console.log()
if (failed === 0) {
	console.log(
		`${BOLD}${GREEN}✓ ${passed}/${results.length} tests passed${RESET}`,
	)
} else {
	console.log(
		`${BOLD}${RED}✗ ${failed}/${results.length} tests failed, ${passed} passed${RESET}`,
	)
}

// ── GitHub Actions step summary ───────────────────────────────────────────────

const summaryFile = process.env.GITHUB_STEP_SUMMARY
if (summaryFile) {
	const rows = results
		.map(
			(r, i) =>
				`| ${i + 1} | ${r.name} | ${r.passed ? '✅ pass' : `❌ fail — \`${(r.error ?? '').split('\n')[0]}\``} |`,
		)
		.join('\n')

	const md = [
		'## Test Results',
		'',
		'| # | Test | Status |',
		'|---|------|--------|',
		rows,
		'',
		failed === 0
			? `> ✅ **${passed} passed, 0 failed**`
			: `> ❌ **${passed} passed, ${failed} failed**`,
		'',
		`_Feed date used: \`${dateStr}\`_`,
	].join('\n')

	appendFileSync(summaryFile, md + '\n')
}

process.exit(failed > 0 ? 1 : 0)
