# Design

This is a static front-end website, that is designed to
find the shortest path amongst bike friendly trains (usually TER).
It relies on web workers and the CSA algorithm[^1][^2].
Data are taken from SNCF GTFS[^3] feed and daily updated using
a Github Action.

# Caveats

- GTFS-RT is not used, and train schedules can be 1 day old. 


[^1]: https://arxiv.org/pdf/1703.05997
[^2]: https://github.com/trainline-eu/csa-challenge
[^3]: https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip
