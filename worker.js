/**
 * voyage-ter/worker.js
 *
 * Web Worker that responds to search requests with mock connection data.
 *
 * Message contract (incoming):
 *   { type: 'search', query: { departure, arrival, datetime }, requestId }
 *
 * Response:
 *   { type: 'results', results: [ { duration, connexions: [{ from, to, start, duration }, ...] }, ... ], requestId }
 *
 * The worker simulates latency and generates several plausible connection options.
 */

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  const { type, query, requestId } = msg;

  if (type === 'search') {
    // simulate async work / computation latency
    const latency = 250 + Math.floor(Math.random() * 700); // 250-950ms
    setTimeout(() => {
      try {
        const results = generateMockResults(query || {});
        self.postMessage({ type: 'results', results, requestId });
      } catch (err) {
        // If something goes wrong, still reply with an empty result set
        self.postMessage({ type: 'results', results: [], requestId, error: String(err) });
      }
    }, latency);
  } else if (type === 'ping') {
    // simple ping for health checks
    self.postMessage({ type: 'pong', requestId });
  } else {
    // unknown message - ignore or echo back
    self.postMessage({ type: 'error', message: 'unknown message type', requestId });
  }
});

/**
 * Generate a mock list of connection options.
 * Each option has:
 *  - duration: total minutes (number)
 *  - connexions: array of legs { from, to, start (ISO), duration (minutes) }
 */
function generateMockResults(query) {
  const departure = (query.departure || 'Station A').trim() || 'Station A';
  const arrival = (query.arrival || 'Station B').trim() || 'Station B';
  const baseTime = parseDateOrNow(query.datetime);

  // normalize to next quarter-hour for nicer mock times
  const normalized = roundUpToQuarter(baseTime);

  const optionsCount = 3;
  const options = [];

  for (let i = 0; i < optionsCount; i++) {
    // Stagger start times slightly for variety
    const startTime = new Date(normalized.getTime() + i * 15 * 60 * 1000);

    // create 2 or 3 legs
    const legCount = 2 + (i % 2); // 2,3,2 ...
    const legs = [];
    let cursor = new Date(startTime.getTime());
    let totalDuration = 0;

    for (let legIdx = 0; legIdx < legCount; legIdx++) {
      const legDuration = 15 + Math.floor(Math.random() * 50); // 15-64 minutes
      const from = (legIdx === 0) ? departure : `${departure} (via ${legIdx})`;
      const to = (legIdx === legCount - 1) ? arrival : `${departure} ↔ ${arrival} (${legIdx})`;

      legs.push({
        from,
        to,
        start: cursor.toISOString(),
        duration: legDuration
      });

      totalDuration += legDuration;

      // Advance cursor: leg duration + transfer (5-12 minutes)
      const transfer = 5 + Math.floor(Math.random() * 8);
      cursor = new Date(cursor.getTime() + (legDuration + transfer) * 60 * 1000);
    }

    options.push({
      duration: totalDuration,
      connexions: legs
    });
  }

  // sort by total duration ascending (best first)
  options.sort((a, b) => a.duration - b.duration);

  return options;
}

function parseDateOrNow(value) {
  if (!value) return new Date();
  // Accept either an ISO string, or a datetime-local string, or a Date object
  try {
    if (value instanceof Date) return new Date(value.getTime());
    // Some browsers feed `datetime-local` as "YYYY-MM-DDTHH:mm" (no timezone).
    // Date constructor will treat that as local, which is fine for mock data.
    const d = new Date(value);
    if (isNaN(d.getTime())) {
      return new Date();
    }
    return d;
  } catch {
    return new Date();
  }
}

function roundUpToQuarter(date) {
  const d = new Date(date.getTime());
  d.setSeconds(0, 0);
  const mins = d.getMinutes();
  const remainder = mins % 15;
  if (remainder !== 0) {
    d.setMinutes(mins + (15 - remainder));
  }
  return d;
}
