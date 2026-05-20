# Design

This is a static front-end website, that is designed to
find the shortest path amongst bike friendly trains (usually TER).
It relies on web workers and the CSA algorithm[^1][^2].
Data are taken from SNCF GTFS[^3] feed and daily updated using
a Github Action.

# Caveats

- GTFS-RT is not used, and train schedules can be 1 day old. 

# TODO

- also filter stop_times in filter_bike_gtfs script
- later we should consider adding bike connection directly in
  the trip search, since we know user has a bike!
- we should also print results on a map rather than a list

[^1]: https://arxiv.org/pdf/1703.05997
[^2]: https://github.com/trainline-eu/csa-challenge
[^3]: https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip
