#!/usr/bin/env ruby

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

# voyage-ter/scripts/filter_bike_gtfs.rb
#
# Read GTFS files and remove non-bike-friendly entries in-place.
# Creates timestamped backups before modifying files.
#
# Files processed:
#   routes.txt     — removes non-bike routes
#   trips.txt      — removes trips referencing non-bike routes (or matching keywords)
#   stop_times.txt — removes stop_times referencing removed trips
#
# Heuristic:
#   A route is non-bike-friendly if its short_name, long_name, or desc contains
#   a high-speed brand keyword: TGV, OUIGO, INOUIGO, INOUI, OUI.
#   Trips are also checked via trip_id / trip_headsign as a fallback.
#
# Usage:
#   ruby scripts/filter_bike_gtfs.rb            # apply in-place
#   ruby scripts/filter_bike_gtfs.rb --dry-run  # preview only

require 'csv'
require 'fileutils'
require 'set'
require 'time'
require 'optparse'

SCRIPT_DIR = File.expand_path(File.dirname(__FILE__))
GTFS_DIR   = File.expand_path(File.join(SCRIPT_DIR, '..', 'data', 'gtfs'))

ROUTES_FILE     = File.join(GTFS_DIR, 'routes.txt')
TRIPS_FILE      = File.join(GTFS_DIR, 'trips.txt')
STOP_TIMES_FILE = File.join(GTFS_DIR, 'stop_times.txt')

# ---------------------------------------------------------------------------
# Option parsing
# ---------------------------------------------------------------------------

options = {
  dry_run:       false,
  backup_suffix: Time.now.utc.strftime('%Y%m%dT%H%M%SZ')
}

OptionParser.new do |opts|
  opts.banner = "Usage: #{$PROGRAM_NAME} [options]"

  opts.on('-n', '--dry-run', 'Preview changes without modifying any file') do
    options[:dry_run] = true
  end

  opts.on('-bSUFFIX', '--backup-suffix=SUFFIX',
          'Suffix appended to backup filenames (default: UTC timestamp)') do |s|
    options[:backup_suffix] = s
  end

  opts.on_tail('-h', '--help', 'Show this help') do
    puts opts
    exit 0
  end
end.parse!

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def abort_if_missing(path)
  return if File.exist?(path)

  warn "Error: expected file not found: #{path}"
  exit 2
end

# Keywords identifying non-bike-friendly high-speed services.
NON_BIKE_KEYWORDS = %w[TGV OUIGO INOUIGO INOUI OUI].freeze

# Whole-word, case-insensitive match for any keyword.
KEYWORD_REGEX = /\b(?:#{NON_BIKE_KEYWORDS.join('|')})\b/i

def non_bike?(fields)
  fields.any? { |f| f.to_s.match?(KEYWORD_REGEX) }
end

# ---------------------------------------------------------------------------
# Read CSV files
# ---------------------------------------------------------------------------

abort_if_missing(ROUTES_FILE)
abort_if_missing(TRIPS_FILE)
abort_if_missing(STOP_TIMES_FILE)

def read_csv(path)
  CSV.read(path, headers: true, encoding: 'bom|utf-8')
rescue StandardError => e
  warn "Warning: retrying #{File.basename(path)} without BOM flag (#{e.message})"
  CSV.read(path, headers: true)
end

routes_table = read_csv(ROUTES_FILE)
trips_table  = read_csv(TRIPS_FILE)

# ---------------------------------------------------------------------------
# Classify routes
# ---------------------------------------------------------------------------

non_bike_route_ids = Set.new

routes_table.each do |row|
  fields = [row['route_short_name'], row['route_long_name'], row['route_desc']]
  non_bike_route_ids << row['route_id'] if non_bike?(fields)
end

kept_routes   = routes_table.reject { |r| non_bike_route_ids.include?(r['route_id']) }
removed_routes = routes_table.size - kept_routes.size

# ---------------------------------------------------------------------------
# Classify trips
# ---------------------------------------------------------------------------

bike_trip_ids  = Set.new
removed_trip_ids = Set.new

trips_table.each do |row|
  trip_id  = row['trip_id'].to_s
  route_id = row['route_id'].to_s

  if non_bike_route_ids.include?(route_id)
    removed_trip_ids << trip_id
    next
  end

  # Fallback: inspect trip-level fields when route is unknown or unclassified
  if route_id.empty? || !routes_table.any? { |r| r['route_id'] == route_id }
    fields = [row['trip_id'], row['trip_headsign'], row['trip_short_name']]
    if non_bike?(fields)
      removed_trip_ids << trip_id
      next
    end
  end

  bike_trip_ids << trip_id
end

kept_trips    = trips_table.select { |r| bike_trip_ids.include?(r['trip_id'].to_s) }
removed_trips = trips_table.size - kept_trips.size

# ---------------------------------------------------------------------------
# Count stop_times that would be removed
# (line-by-line scan — avoids loading 69 MB into Ruby objects)
# ---------------------------------------------------------------------------

# stop_times.txt column 0 is trip_id; we only need that to decide.
st_total   = 0
st_removed = 0

puts "Scanning #{STOP_TIMES_FILE} …"

File.open(STOP_TIMES_FILE, 'r:bom|utf-8') do |f|
  f.each_line.with_index do |line, idx|
    next if idx.zero? # header

    st_total += 1
    comma = line.index(',')
    trip_id = comma ? line[0, comma] : line.chomp
    st_removed += 1 unless bike_trip_ids.include?(trip_id)
  end
end

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

puts
puts "GTFS directory : #{GTFS_DIR}"
puts
puts "routes.txt     : #{routes_table.size} rows  →  #{removed_routes} removed"
puts "trips.txt      : #{trips_table.size} rows  →  #{removed_trips} removed"
puts "stop_times.txt : #{st_total} rows  →  #{st_removed} removed"
puts

if removed_trip_ids.size > 0
  puts 'Sample removed trip_ids (first 10):'
  removed_trip_ids.first(10).each { |id| puts "  #{id}" }
  puts
end

# ---------------------------------------------------------------------------
# Dry-run exit
# ---------------------------------------------------------------------------

if options[:dry_run]
  puts 'Dry run — no files were modified. Re-run without --dry-run to apply.'
  exit 0
end

# ---------------------------------------------------------------------------
# Backup originals
# ---------------------------------------------------------------------------

timestamp = options[:backup_suffix]

[ROUTES_FILE, TRIPS_FILE, STOP_TIMES_FILE].each do |path|
  backup = "#{path}.bak.#{timestamp}"
  FileUtils.cp(path, backup)
  puts "Backup: #{backup}"
end

# ---------------------------------------------------------------------------
# Write filtered routes.txt and trips.txt (via CSV)
# ---------------------------------------------------------------------------

def write_csv(path, headers, rows)
  CSV.open(path, 'wb', write_headers: true, headers: headers, encoding: 'utf-8') do |csv|
    rows.each { |row| csv << row }
  end
end

write_csv(ROUTES_FILE, routes_table.headers, kept_routes)
puts "Updated #{ROUTES_FILE}  (kept #{kept_routes.size} / removed #{removed_routes})"

write_csv(TRIPS_FILE, trips_table.headers, kept_trips)
puts "Updated #{TRIPS_FILE}   (kept #{kept_trips.size} / removed #{removed_trips})"

# ---------------------------------------------------------------------------
# Filter stop_times.txt in-place
# Line-by-line: read from backup, write kept lines to original path.
# This avoids holding the entire 69 MB file in memory as Ruby objects.
# ---------------------------------------------------------------------------

stop_times_backup = "#{STOP_TIMES_FILE}.bak.#{timestamp}"
lines_written = 0

File.open(STOP_TIMES_FILE, 'w:utf-8') do |out|
  File.open(stop_times_backup, 'r:bom|utf-8') do |src|
    src.each_line.with_index do |line, idx|
      if idx.zero?
        # Always keep the header; strip BOM if present
        out.write(line.sub("\xEF\xBB\xBF", ''))
        lines_written += 1
        next
      end

      comma   = line.index(',')
      trip_id = comma ? line[0, comma] : line.chomp
      next unless bike_trip_ids.include?(trip_id)

      out.write(line)
      lines_written += 1
    end
  end
end

puts "Updated #{STOP_TIMES_FILE}  (kept #{lines_written - 1} data rows / removed #{st_removed})"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

puts
puts 'All files updated in-place. Originals preserved with suffix: ' \
     ".bak.#{timestamp}"
puts
puts 'Note: re-run with --dry-run at any time to preview what the current'
puts 'GTFS files would produce without making changes.'

exit 0
