/**
 * Global parameters for the easy-bici project.
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
 * MIN_CONNECTION_TIME_SECONDS:
 *   Minimum required connection time between trains, expressed in seconds.
 *   The Connection Scan Algorithm (csa.js) in this project uses Unix timestamps
 *   in seconds, so this value is provided in seconds for direct use.
 *
 * Default: 5 minutes (300 seconds).
 */

export const MIN_CONNECTION_TIME_SECONDS = 5 * 60

// Optional convenience export (named) in case milliseconds are needed elsewhere.
export const MIN_CONNECTION_TIME_MS = MIN_CONNECTION_TIME_SECONDS * 1000

/**
 * Train types that require a paid bike reservation (bike fee).
 * These trains allow bikes but charge an extra fee.
 */
export const FEE_TYPES = new Set(['tgv', 'ic', 'icn', 'ice'])

/**
 * Train types that require the bike to be dismantled / bagged.
 * No assembled bike is allowed on these services.
 */
export const DISMANTLE_TYPES = new Set(['ouigo', 'lyr'])
