#!/usr/bin/env ruby
# frozen_string_literal: true

# ╭────────────────────────────────────────────────────────────────────────╮
# │ Copyright (C) 2026-present  Ulysse Buonomo                             │
# │                                                                        │
# │ This program is free software: you can redistribute it and/or modify   │
# │ it under the terms of the GNU General Public License as published by   │
# │ the Free Software Foundation, either version 3 of the License, or      │
# │  (at your option) any later version.                                   │
# │                                                                        │
# │ This program is distributed in the hope that it will be useful,        │
# │ but WITHOUT ANY WARRANTY; without even the implied warranty of         │
# │ MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the          │
# │ GNU General Public License for more details.                           │
# │                                                                        │
# │ You should have received a copy of the GNU General Public License      │
# │ along with this program.  If not, see <https://www.gnu.org/licenses/>. │
# ╰────────────────────────────────────────────────────────────────────────╯

# scripts/build_timetable.rb
#
# Pre-process filtered GTFS CSV files into a compact binary timetable.
#
# Run this script after `scripts/extract_bike_friendly.rb` whenever the
# underlying GTFS data changes. The browser then loads the resulting
# timetable.bin (~8 MB) instead of ~77 MB of raw CSV files.
#
# Inputs  (data/gtfs/):
#   feed_info.txt      — feed version for meta.json
#   stops.txt          — stop names and coordinates
#   trips.txt          — trip → service_id mapping
#   stop_times.txt     — per-trip stop times (parsed line-by-line, 400 K rows)
#   calendar_dates.txt — service active dates
#
# Outputs (data/):
#   timetable.bin      — VTER v1 binary timetable
#   meta.json          — {"version": "<feed_version>"}
#
# Binary format — VTER v1 (little-endian throughout):
#
#   Header (24 bytes):
#     [0-3]   ASCII "VTER"            magic
#     [4-7]   uint32  format_version  = 1
#     [8-9]   uint16  num_stops
#     [10-11] uint16  num_services
#     [12-13] uint16  num_trips       (count only; IDs not stored as strings)
#     [14-15] uint16  reserved        = 0
#     [16-19] uint32  num_connections
#     [20-23] uint32  num_calendar_entries
#
#   Stops section — num_stops records, sorted by stop_id:
#     uint16  stop_id byte length
#     N bytes stop_id (UTF-8)
#     uint16  stop_name byte length
#     M bytes stop_name (UTF-8)
#     float32 latitude  (IEEE 754 single, LE)
#     float32 longitude (IEEE 754 single, LE)
#
#   Services section — num_services records, sorted by service_id:
#     uint16  service_id byte length
#     N bytes service_id (UTF-8)
#
#   Calendar section — num_calendar_entries × 6 bytes, sorted by date:
#     uint32  date (YYYYMMDD integer)
#     uint16  service_idx (index into services array)
#     (only exception_type == "1" rows; only known service_ids)
#
#   Connections section — num_connections × 16 bytes, sorted by dep_secs:
#     uint16  dep_stop_idx  (index into stops array)
#     uint16  arr_stop_idx
#     uint32  dep_secs      (seconds since midnight, from departure_time)
#     uint32  arr_secs      (seconds since midnight, from next stop's arrival_time)
#     uint16  trip_idx      (index; trips sorted lexicographically by trip_id)
#     uint16  service_idx   (index into services array)
#
#   TER Stop Indices section (optional extension appended after Connections):
#     uint16  num_ter_stops
#     num_ter_stops × uint16  stop_idx  (index into the stops array)
#
#   Trip Types section (optional extension appended after TER Stop Indices):
#     num_trips × uint8  type_code  (indexed by trip_idx; no leading count)
#     type codes:  0=unknown  1=TER  2=IC  3=ICN  4=ICE  5=LYR
#                  6=OGO     7=OUI  8=TRN  9=NAV  10=TT
#
# Usage:
#   ruby scripts/build_timetable.rb

require 'csv'
require 'json'
require 'set'

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR = File.expand_path(__dir__)
DATA_DIR   = File.expand_path(File.join(SCRIPT_DIR, '..', 'data'))
GTFS_DIR   = File.join(DATA_DIR, 'gtfs')

FEED_INFO_FILE      = File.join(GTFS_DIR, 'feed_info.txt')
STOPS_FILE          = File.join(GTFS_DIR, 'stops.txt')
TRIPS_FILE          = File.join(GTFS_DIR, 'trips.txt')
STOP_TIMES_FILE     = File.join(GTFS_DIR, 'stop_times.txt')
CALENDAR_DATES_FILE = File.join(GTFS_DIR, 'calendar_dates.txt')

OUTPUT_BIN  = File.join(DATA_DIR, 'timetable.bin')
OUTPUT_META = File.join(DATA_DIR, 'meta.json')

FORMAT_VERSION = 1
MAX_UINT16     = 65_535

# Maps the GTFS trip_id service code (extracted from "_F:CODE:") to a uint8
# type code embedded in the Trip Types binary section.
SERVICE_CODE_MAP = {
  'TER' => 1,
  'IC'  => 2,
  'ICN' => 3,
  'ICE' => 4,
  'LYR' => 5,
  'OGO' => 6,
  'OUI' => 7,
  'TRN' => 8,
  'NAV' => 9,
  'TT'  => 10,
}.freeze

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Abort with a clear message if a required input file is missing.
def require_file!(path)
  return if File.exist?(path)

  warn "Error: required file not found: #{path}"
  exit 2
end

# Parse a GTFS "HH:MM:SS" time string to integer seconds since midnight.
# Hours can be >= 24 for services running past midnight.
def parse_gtfs_time(s)
  # Avoid String#split for hot-path performance; index directly.
  c1 = s.index(':')
  c2 = s.index(':', c1 + 1)
  s[0, c1].to_i * 3600 + s[c1 + 1, 2].to_i * 60 + s[c2 + 1, 2].to_i
end

# ---------------------------------------------------------------------------
# Validate inputs
# ---------------------------------------------------------------------------

puts "easy-bici / build_timetable — VTER v#{FORMAT_VERSION}"
puts

[FEED_INFO_FILE, STOPS_FILE, TRIPS_FILE, STOP_TIMES_FILE, CALENDAR_DATES_FILE].each do |f|
  require_file!(f)
end

# ---------------------------------------------------------------------------
# Step 1 — Read feed_info.txt → feed_version for meta.json
# ---------------------------------------------------------------------------

puts 'Step 1/7  Reading feed_info.txt …'

feed_version = nil
CSV.foreach(FEED_INFO_FILE, headers: true) do |row|
  feed_version = row['feed_version'].to_s.strip
  break # only the first data row is needed
end

raise 'feed_version not found in feed_info.txt' if feed_version.nil? || feed_version.empty?

puts "          feed_version = #{feed_version}"

# ---------------------------------------------------------------------------
# Step 2 — Read trips.txt
#
# Builds:
#   trip_service  Hash  trip_id → service_id
#   services_set  Set   all unique service_ids (for calendar filtering)
#   trips_array   Array sorted trip_ids (determines trip_idx in connections)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Step 2 — Build stop-point → stop-area parent map
#
# Each StopPoint row in stops.txt has a parent_station field pointing to its
# StopArea.  We normalise all stop IDs that appear in stop_times to their
# parent StopArea so that transfers between different operators at the same
# physical station (e.g. TER ↔ TGV INOUI at Lyon Part-Dieu) work
# transparently in the CSA algorithm.
# ---------------------------------------------------------------------------

puts 'Step 2/8  Reading stop parent map from stops.txt …'

stop_parent = {}  # stop_id → parent_station_id  (nil when no parent)
ter_stop_ids = Set.new  # numeric station IDs (String) with TER service

CSV.foreach(STOPS_FILE, headers: true, encoding: 'bom|utf-8') do |row|
  sid    = row['stop_id'].to_s.strip
  parent = row['parent_station'].to_s.strip
  stop_parent[sid] = parent.empty? ? nil : parent
  m = sid.match(/^StopPoint:OCETrain TER-(\d+)$/)
  ter_stop_ids << m[1] if m
end

# Return the canonical station ID: the parent StopArea when one exists, else self.
normalize_stop = ->(sid) { stop_parent.fetch(sid, nil) || sid }

puts "          #{stop_parent.count { |_, v| v }} stop points mapped to a parent area"
puts "          #{ter_stop_ids.size} TER stations found"

# ---------------------------------------------------------------------------
# Step 3 — Read trips.txt
#
# Builds:
#   trip_service  Hash  trip_id → service_id
#   services_set  Set   all unique service_ids (for calendar filtering)
#   trips_array   Array sorted trip_ids (determines trip_idx in connections)
# ---------------------------------------------------------------------------

puts 'Step 3/8  Reading trips.txt …'

trip_service    = {}  # trip_id (String) → service_id (String)
trip_type_code  = {}  # trip_id (String) → uint8 type code

CSV.foreach(TRIPS_FILE, headers: true, encoding: 'bom|utf-8') do |row|
  trip_id    = row['trip_id'].to_s.strip
  service_id = row['service_id'].to_s.strip
  next if trip_id.empty?

  trip_service[trip_id] = service_id
  m = trip_id.match(/_F:([A-Z]+):/)
  trip_type_code[trip_id] = SERVICE_CODE_MAP[m[1]] || 0 if m
end

# Sorted service_id list used for both the binary section and index lookup.
services_array = trip_service.values.uniq.sort  # Array<String>
service_idx    = {}                              # service_id → integer index
services_array.each_with_index { |s, i| service_idx[s] = i }

# Sorted trip_id list determines trip_idx used in the connections section.
trips_array = trip_service.keys.sort  # Array<String>
trip_idx    = {}                      # trip_id → integer index
trips_array.each_with_index { |t, i| trip_idx[t] = i }

type_counts = trip_type_code.values.tally
type_summary = SERVICE_CODE_MAP.filter_map { |name, code| "#{name}=#{type_counts[code] || 0}" }.join(' ')
puts "          #{trip_service.size} trips, #{services_array.size} unique services"
puts "          types: #{type_summary}"

# ---------------------------------------------------------------------------
# Step 3 — Read stop_times.txt line-by-line
#
# We intentionally avoid loading the entire 400 K-row / ~10 MB file into Ruby
# CSV objects.  Only the first 5 columns are needed:
#   0  trip_id
#   1  arrival_time
#   2  departure_time
#   3  stop_id
#   4  stop_sequence
#
# Builds:
#   trip_stops  Hash  trip_id → Array<{stop_id, arr_secs, dep_secs, stop_sequence}>
# ---------------------------------------------------------------------------

puts 'Step 4/8  Reading stop_times.txt (line-by-line) …'

trip_stops    = Hash.new { |h, k| h[k] = [] }  # trip_id → entries
st_rows_read  = 0
st_rows_skipped = 0

File.open(STOP_TIMES_FILE, 'r:bom|utf-8') do |f|
  f.each_line.with_index do |line, idx|
    next if idx.zero? # skip header

    # Strip CR+LF (handles both Unix and Windows line endings).
    line.chomp!
    line.delete_suffix!("\r")
    next if line.empty?

    # Split only up to 6 fields; we never need beyond stop_sequence (col 4).
    parts = line.split(',', 6)
    next if parts.size < 5

    trip_id        = parts[0]
    arrival_time   = parts[1]
    departure_time = parts[2]
    stop_id        = parts[3]
    stop_sequence  = parts[4].to_i

    # Skip rows whose trip_id is not present in trips.txt.
    unless trip_service.key?(trip_id)
      st_rows_skipped += 1
      next
    end

    trip_stops[trip_id] << {
      stop_id:       stop_id,
      arr_secs:      parse_gtfs_time(arrival_time),
      dep_secs:      parse_gtfs_time(departure_time),
      stop_sequence: stop_sequence
    }

    st_rows_read += 1
  end
end

puts "          #{st_rows_read} rows kept, #{st_rows_skipped} skipped (unknown trip_id)"
puts "          #{trip_stops.size} trips with stop_time data"

# ---------------------------------------------------------------------------
# Step 4 — Build raw connections from consecutive stop pairs within each trip
#
# Mirrors the JS gtfs-loader.js scanStopTimes + rawConnections logic exactly:
#   dep_secs = stops[i].dep_secs        (departure from current stop)
#   arr_secs = stops[i+1].arr_secs      (arrival at the NEXT stop)
# ---------------------------------------------------------------------------

puts 'Step 5/8  Building connections …'

raw_connections = []

trip_stops.each do |trip_id, stops|
  # Ensure stops are in timetable order before pairing.
  stops.sort_by! { |s| s[:stop_sequence] }

  service_id = trip_service[trip_id]

  (stops.size - 1).times do |i|
    raw_connections << {
      dep_stop:   normalize_stop.call(stops[i][:stop_id]),
      arr_stop:   normalize_stop.call(stops[i + 1][:stop_id]),
      dep_secs:   stops[i][:dep_secs],
      arr_secs:   stops[i + 1][:arr_secs],  # arrival time at the next stop
      trip_id:    trip_id,
      service_id: service_id
    }
  end
end

# Sort ascending by departure time — required by the CSA algorithm.
raw_connections.sort_by! { |c| c[:dep_secs] }

puts "          #{raw_connections.size} connections"

# We no longer need trip_stops; release the memory.
trip_stops = nil
GC.start

# ---------------------------------------------------------------------------
# Step 6 — Build stops index
#
# Only stops actually referenced by at least one connection are stored.
# Stops missing from stops.txt receive a graceful fallback (name=id, lat/lon=0).
# ---------------------------------------------------------------------------

puts 'Step 6/8  Reading stops.txt …'

# Collect the set of stop_ids that appear in connections.
used_stop_ids = Set.new
raw_connections.each do |c|
  used_stop_ids << c[:dep_stop]
  used_stop_ids << c[:arr_stop]
end

# Load metadata for every used stop from stops.txt.
stops_data = {}  # stop_id → {name:, lat:, lon:}

CSV.foreach(STOPS_FILE, headers: true, encoding: 'bom|utf-8') do |row|
  sid = row['stop_id'].to_s.strip
  next unless used_stop_ids.include?(sid)

  stops_data[sid] = {
    name: row['stop_name'].to_s.strip,
    lat:  row['stop_lat'].to_f,
    lon:  row['stop_lon'].to_f
  }
end

# Graceful fallback for any stop_id not found in stops.txt.
missing_stops = used_stop_ids - Set.new(stops_data.keys)
unless missing_stops.empty?
  missing_stops.each do |sid|
    warn "  Warning: stop_id not found in stops.txt — fallback used: #{sid}"
    stops_data[sid] = { name: sid, lat: 0.0, lon: 0.0 }
  end
end

# Build the stops array in a stable, sorted order (sort by stop_id string).
stops_array = stops_data.keys.sort.map { |sid| { stop_id: sid, **stops_data[sid] } }

# Build the stop_id → index lookup used when encoding connections.
stop_idx = {}
stops_array.each_with_index { |s, i| stop_idx[s[:stop_id]] = i }

puts "          #{stops_array.size} stops (#{missing_stops.size} fallback(s), " \
     "#{used_stop_ids.size - missing_stops.size} from stops.txt)"

# ---------------------------------------------------------------------------
# Step 7 — Read calendar_dates.txt
#
# Only rows with exception_type == "1" (service added) are retained.
# Rows whose service_id is not present in trips.txt are skipped.
# Result is sorted by date integer (ascending).
# ---------------------------------------------------------------------------

puts 'Step 7/8  Reading calendar_dates.txt …'

known_services  = Set.new(services_array)
calendar_entries = []  # Array<{date: Integer, service_idx: Integer}>
cal_skipped      = 0

CSV.foreach(CALENDAR_DATES_FILE, headers: true, encoding: 'bom|utf-8') do |row|
  # Only "service added" entries are meaningful for the journey planner.
  next unless row['exception_type'] == '1'

  sid = row['service_id'].to_s.strip

  # Ignore service_ids that don't appear in the (filtered) trips.txt.
  unless known_services.include?(sid)
    cal_skipped += 1
    next
  end

  calendar_entries << {
    date:        row['date'].to_i,           # YYYYMMDD as integer
    service_idx: service_idx[sid]
  }
end

calendar_entries.sort_by! { |e| e[:date] }

puts "          #{calendar_entries.size} entries kept, #{cal_skipped} skipped"

# ---------------------------------------------------------------------------
# Sanity checks — counts must fit in uint16 (max 65 535)
# ---------------------------------------------------------------------------

{
  'num_stops'    => stops_array.size,
  'num_services' => services_array.size,
  'num_trips'    => trips_array.size
}.each do |name, count|
  if count > MAX_UINT16
    raise "#{name} = #{count} exceeds uint16 maximum (#{MAX_UINT16}). " \
          'The VTER v1 format must be extended to uint32 for this dataset.'
  end
end

# ---------------------------------------------------------------------------
# Step 8 — Write outputs
# ---------------------------------------------------------------------------

puts 'Step 8/8  Writing binary output …'

File.open(OUTPUT_BIN, 'wb') do |f|
  # ---- Header (24 bytes) --------------------------------------------------

  f.write('VTER')                              # [0-3]  magic
  f.write([FORMAT_VERSION].pack('V'))          # [4-7]  format_version (uint32 LE)
  f.write([stops_array.size].pack('v'))        # [8-9]  num_stops      (uint16 LE)
  f.write([services_array.size].pack('v'))     # [10-11] num_services   (uint16 LE)
  f.write([trips_array.size].pack('v'))        # [12-13] num_trips      (uint16 LE)
  f.write([0].pack('v'))                       # [14-15] reserved       (uint16 LE)
  f.write([raw_connections.size].pack('V'))    # [16-19] num_connections (uint32 LE)
  f.write([calendar_entries.size].pack('V'))   # [20-23] num_calendar_entries (uint32 LE)

  # ---- Stops section (variable-length records) ----------------------------
  #
  # For each stop (sorted by stop_id):
  #   uint16  stop_id byte length
  #   N bytes stop_id (UTF-8)
  #   uint16  stop_name byte length
  #   M bytes stop_name (UTF-8)
  #   float32 latitude  (LE)
  #   float32 longitude (LE)

  stops_array.each do |stop|
    sid_bytes  = stop[:stop_id].encode('UTF-8')
    name_bytes = stop[:name].encode('UTF-8')

    f.write([sid_bytes.bytesize].pack('v'))
    f.write(sid_bytes)
    f.write([name_bytes.bytesize].pack('v'))
    f.write(name_bytes)
    f.write([stop[:lat]].pack('e'))   # float32 LE
    f.write([stop[:lon]].pack('e'))   # float32 LE
  end

  # ---- Services section (variable-length records) -------------------------
  #
  # For each service_id (sorted):
  #   uint16  service_id byte length
  #   N bytes service_id (UTF-8)

  services_array.each do |sid|
    sid_bytes = sid.encode('UTF-8')
    f.write([sid_bytes.bytesize].pack('v'))
    f.write(sid_bytes)
  end

  # ---- Calendar section (6 bytes × num_calendar_entries) ------------------
  #
  # For each calendar entry (sorted by date):
  #   uint32  date         (YYYYMMDD integer, LE)
  #   uint16  service_idx  (LE)

  calendar_entries.each do |entry|
    f.write([entry[:date], entry[:service_idx]].pack('Vv'))
  end

  # ---- Connections section (16 bytes × num_connections) -------------------
  #
  # For each connection (sorted by dep_secs ascending):
  #   uint16  dep_stop_idx  (LE)
  #   uint16  arr_stop_idx  (LE)
  #   uint32  dep_secs      (LE)
  #   uint32  arr_secs      (LE)
  #   uint16  trip_idx      (LE)
  #   uint16  service_idx   (LE)

  raw_connections.each do |conn|
    dep_si = stop_idx[conn[:dep_stop]]
    arr_si = stop_idx[conn[:arr_stop]]
    ti     = trip_idx[conn[:trip_id]]
    svi    = service_idx[conn[:service_id]]

    # All indices must have been resolved; nil here indicates a logic error.
    raise "Unresolved dep_stop: #{conn[:dep_stop]}"  if dep_si.nil?
    raise "Unresolved arr_stop: #{conn[:arr_stop]}"  if arr_si.nil?
    raise "Unresolved trip_id: #{conn[:trip_id]}"    if ti.nil?
    raise "Unresolved service_id: #{conn[:service_id]}" if svi.nil?

    f.write([dep_si, arr_si, conn[:dep_secs], conn[:arr_secs], ti, svi].pack('vvVVvv'))
  end

  # ---- TER Stop Indices section (appended after Connections) ---------------
  #
  # Stores the indices (into the stops array) of stops that have Train TER
  # service, so the JS parser can annotate them with ter_id without needing
  # a separate ter_stops.json fetch.
  #
  #   uint16 LE  num_ter_stops
  #   num_ter_stops × uint16 LE  stop_idx

  ter_stop_indices = ter_stop_ids.filter_map { |numeric_id| stop_idx["StopArea:OCE#{numeric_id}"] }.sort
  f.write([ter_stop_indices.size].pack('v'))
  ter_stop_indices.each { |idx| f.write([idx].pack('v')) }

  # ---- Trip Types section (appended after TER Stop Indices) ---------------
  #
  # Stores one uint8 type code per trip, indexed by trip_idx.  Trips whose
  # trip_id does not match any known service code receive code 0 (unknown).
  # See SERVICE_CODE_MAP for the full code → name mapping.

  trips_array.each { |tid| f.write([trip_type_code.fetch(tid, 0)].pack('C')) }
end

bin_size = File.size(OUTPUT_BIN)

# ---------------------------------------------------------------------------
# Write meta.json
# ---------------------------------------------------------------------------

File.write(OUTPUT_META, JSON.generate({ 'version' => feed_version }) + "\n")

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

puts
puts '=' * 62
puts '  Build complete!'
puts '=' * 62
puts format('  %-22s %s (%.2f MB)', 'timetable.bin', bin_size, bin_size / 1_048_576.0)
puts format('  %-22s %s', 'meta.json', JSON.generate({ 'version' => feed_version }))
puts format('  %-22s %s', '(trip types)', type_summary)
puts '  ' + '-' * 58
puts format('  %-22s %d', 'Stops',            stops_array.size)
puts format('  %-22s %d', 'Services',          services_array.size)
puts format('  %-22s %d', 'Trips',             trips_array.size)
puts format('  %-22s %d', 'Connections',       raw_connections.size)
puts format('  %-22s %d', 'Calendar entries',  calendar_entries.size)
puts '=' * 62
puts

exit 0
