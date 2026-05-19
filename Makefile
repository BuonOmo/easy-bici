.PHONY: serve build clean

serve:
	python -m http.server 8000

build:
	ruby scripts/extract_bike_friendly.rb
	ruby scripts/build_timetable.rb

clean:
	rm -rf data/**/*.bak*
