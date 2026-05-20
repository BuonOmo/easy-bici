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
