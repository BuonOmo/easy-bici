#!/usr/bin/env ruby
# voyage-ter/scripts/extract_bike_friendly.rb
#
# Read GTFS `routes.txt` and `trips.txt` and remove non-bike-friendly entries in-place.
# Creates timestamped backups before modifying files.
#
# Heuristic:
#  - Any route whose `route_short_name`, `route_long_name` or `route_desc` contains
#    keywords for high-speed brands (TGV family: 'TGV', 'OUIGO', 'INOUI', ...) is
#    considered non-bike-friendly and will be removed.
#  - Trips referencing removed routes are removed as well.
#  - If a trip's route_id is not available or not classified, the trip fields
#    (`trip_headsign`, `trip_id`, `trip_short_name`) are checked with the same keywords.
#
# Usage:
#   ruby voyage-ter/scripts/extract_bike_friendly.rb       # apply changes in-place (creates backups)
#   ruby voyage-ter/scripts/extract_bike_friendly.rb --dry-run
#
# The script expects to be located at voyage-ter/scripts and GTFS files at ../data/gtfs/.
#
require 'csv'
require 'fileutils'
require 'time'
require 'optparse'

SCRIPT_DIR = File.expand_path(File.dirname(__FILE__))
GTFS_DIR = File.expand_path(File.join(SCRIPT_DIR, '..', 'data', 'gtfs'))

ROUTES_FILE = File.join(GTFS_DIR, 'routes.txt')
TRIPS_FILE  = File.join(GTFS_DIR, 'trips.txt')

options = {
  dry_run: false,
  backup_suffix: Time.now.utc.strftime('%Y%m%dT%H%M%SZ')
}

OptionParser.new do |opts|
  opts.banner = "Usage: #{$0} [options]"

  opts.on("-n", "--dry-run", "Do not modify files; just show what would be changed") do
    options[:dry_run] = true
  end

  opts.on("-bSUFFIX", "--backup-suffix=SUFFIX", "Custom backup suffix (default: timestamp)") do |s|
    options[:backup_suffix] = s
  end

  opts.on_tail("-h", "--help", "Show this help") do
    puts opts
    exit 0
  end
end.parse!

def abort_if_missing(path)
  unless File.exist?(path)
    STDERR.puts "Error: expected file not found: #{path}"
    exit 2
  end
end

abort_if_missing(ROUTES_FILE)
abort_if_missing(TRIPS_FILE)

# Keywords indicating non-bike-friendly trains (TGV family).
# This is a heuristic and can be adjusted.
NON_BIKE_KEYWORDS = %w[TGV OUIGO INOUIGO INOUI OUI].freeze

# Build a regex to match whole words (case-insensitive)
# Use word boundaries so we avoid matching substrings inside other words.
keyword_regex = /\b(?:#{NON_BIKE_KEYWORDS.join('|')})\b/i

# Helper to test a set of fields for any keyword
def contains_non_bike?(fields, regex)
  fields.any? do |f|
    next false if f.nil? || f.to_s.strip.empty?
    !!(f.to_s.upcase =~ regex)
  end
end

# Read routes
routes_table = nil
CSV.open(ROUTES_FILE, 'r:bom|utf-8') do |csv|
  routes_table = CSV::Table.new(csv.read.map { |r| CSV::Row.new(csv.headers, r) }, csv.headers)
end

# Next: some GTFS exports include a header line but CSV.read with headers:true is simpler.
# Use CSV.read(headers: true) — but ensure BOM handling and encoding.
begin
  routes_table = CSV.read(ROUTES_FILE, headers: true, encoding: 'bom|utf-8')
rescue => e
  STDERR.puts "Warning: fallback CSV read failed for routes: #{e.message}; attempting simpler parse."
  routes_table ||= CSV.read(ROUTES_FILE, headers: true)
end

# Map route_id -> route row
route_by_id = {}
routes_table.each do |row|
  route_id = row['route_id'] || row['route_id']
  route_by_id[route_id] = row if route_id
end

# Classify routes
route_classification = {} # route_id -> true if bike-friendly
removed_route_ids = []

route_by_id.each do |route_id, row|
  fields = [
    row['route_short_name'],
    row['route_long_name'],
    row['route_desc'],
    row['route_type']
  ].map { |v| v.to_s }
  if contains_non_bike?(fields, keyword_regex)
    route_classification[route_id] = false
    removed_route_ids << route_id
  else
    route_classification[route_id] = true
  end
end

# Read trips
begin
  trips_table = CSV.read(TRIPS_FILE, headers: true, encoding: 'bom|utf-8')
rescue => e
  STDERR.puts "Warning: fallback CSV read failed for trips: #{e.message}; attempting simpler parse."
  trips_table = CSV.read(TRIPS_FILE, headers: true)
end

# Decide which trips to keep
kept_trips = []
removed_trips = []
trips_table.each do |row|
  trip_id = row['trip_id'] || ''
  route_id = row['route_id'] || ''

  # If the trip references a route we classified non-bike -> remove
  if route_id && route_classification.key?(route_id) && route_classification[route_id] == false
    removed_trips << trip_id
    next
  end

  # If route_id unknown, fallback to checking trip-level fields
  if route_id.nil? || route_id.strip.empty? || !route_classification.key?(route_id)
    fields = [
      row['trip_headsign'],
      row['trip_id'],
      row['trip_short_name']
    ].map { |v| v.to_s }
    if contains_non_bike?(fields, keyword_regex)
      removed_trips << trip_id
      next
    else
      kept_trips << row
      next
    end
  end

  # Otherwise keep the trip
  kept_trips << row
end

# Also remove routes from routes file that are classified as non-bike
kept_routes = []
removed_routes = []
routes_table.each do |row|
  route_id = row['route_id'] || ''
  if route_classification.key?(route_id) && route_classification[route_id] == false
    removed_routes << route_id
    next
  end
  kept_routes << row
end

# Summary
puts "GTFS directory: #{GTFS_DIR}"
puts "Routes total: #{routes_table.size}"
puts " - Routes removed (non-bike): #{removed_routes.size}"
puts "Trips total: #{trips_table.size}"
puts " - Trips removed (non-bike or referencing removed routes): #{removed_trips.size}"

# Samples
if removed_routes.size > 0
  puts "\nSample removed route_ids (up to 20):"
  puts removed_routes.first(20).map { |r| "  - #{r}" }
end
if removed_trips.size > 0
  puts "\nSample removed trip_ids (up to 20):"
  puts removed_trips.first(20).map { |t| "  - #{t}" }
end

# Backups & writing
timestamp = options[:backup_suffix]
routes_backup = "#{ROUTES_FILE}.bak.#{timestamp}"
trips_backup  = "#{TRIPS_FILE}.bak.#{timestamp}"

if options[:dry_run]
  puts "\nDry run: no files were modified. To apply changes, re-run without --dry-run."
  exit 0
end

begin
  FileUtils.cp(ROUTES_FILE, routes_backup)
  FileUtils.cp(TRIPS_FILE, trips_backup)
  puts "\nBackups created:"
  puts " - #{routes_backup}"
  puts " - #{trips_backup}"
rescue => e
  STDERR.puts "Failed to create backups: #{e.message}"
  exit 3
end

# Helper to write CSV::Table-like array of rows back to file with original headers preserved
def write_csv(path, headers, rows)
  CSV.open(path, 'wb', write_headers: true, headers: headers, encoding: 'utf-8') do |csv|
    rows.each do |row|
      # row might be a CSV::Row or Hash-like; normalize
      if row.is_a?(CSV::Row)
        csv << row
      else
        csv << headers.map { |h| row[h] }
      end
    end
  end
end

# Prepare headers
routes_headers = routes_table.headers
trips_headers  = trips_table.headers

# Write kept routes and kept trips (preserve order of original files except removed lines)
write_csv(ROUTES_FILE, routes_headers, kept_routes)
write_csv(TRIPS_FILE,  trips_headers,  kept_trips)

puts "\nFiles updated in-place."
puts " - Updated #{ROUTES_FILE} (kept #{kept_routes.size} / removed #{removed_routes.size})"
puts " - Updated #{TRIPS_FILE}  (kept #{kept_trips.size} / removed #{removed_trips.size})"

puts "\nNote: This script uses keyword heuristics to identify non-bike services (TGV family)."
puts "If you need different rules (add/remove keywords), edit NON_BIKE_KEYWORDS in the script."

exit 0
