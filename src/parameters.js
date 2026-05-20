/**
 * Global parameters for the voyage-ter project.
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
