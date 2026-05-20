.PHONY: serve test build clean

serve:
	open http://localhost:8000
	python -m http.server 8000

test:
	open http://localhost:8000/test

build:
	ruby scripts/filter_bike_gtfs.rb
	ruby scripts/build_timetable.rb

clean:
	rm -rf data/**/*.bak*
