<a id="README"></a>

![Easy Bici — Voyager en train avec mon vélo](assets/logo-with-name.svg)

[![Tests](https://github.com/BuonOmo/easy-bici/actions/workflows/test.yml/badge.svg)](https://github.com/BuonOmo/easy-bici/actions/workflows/test.yml)

# Train rules for bikes

- [Lyria require dismantled bikes](https://www.tgv-lyria.com/fr/en/train-travel/onboard-services/luggage-bicycles)
- [Conditions for TRGV INOUI, INTERCITÉS, TER and Transilien](https://www.sncf-voyageurs.com/fr/voyagez-avec-nous/train-et-velo/votre-velo-a-bord/)

# Design

This is a static front-end website, that is designed to
find the shortest path amongst bike friendly trains (usually TER).
It relies on web workers and the CSA algorithm[^1][^2].
Data are taken from SNCF GTFS[^3] feed and daily updated using
a Github Action.

## Tests

There are two test harnesses available, one in the browser and
the other requiring nodejs installed.

# Roadmap

- later we should consider adding bike connection directly in
  the trip search, since we know user has a bike!
- we should also print results on a map rather than a list
- make trips easy to buy afterwards with link to the corresponding train search:
  - [x] TER
  - [ ] intercité
  - [ ] ...
- Check for train prices somehow, and show them.
- Contact 1.2.Train to see if there is a way to generate
  links with prepopulated urls.
- check some route types (it seems that there are some bus routes: do we want them?):
  ```bash
	$ cat data/gtfs/routes.txt | cut -d, -f6 | sort | uniq --count
      4 0 # Tram, Streetcar, Light rail
    558 2 # rail
    172 3 # bus
  ```
- Include cards in the search to apply reductions directly if possible.
  This should be done once we have a better way to link to buy trains,
  since it looks like the current ter.sncf.com link would need an
  authenticated user to apply reductions anyway.

## Facilitate buying trip for a user

Some pricings are available on sncf open-data: https://data.sncf.com/explore/dataset/tarifs-intercites/information/
Some websites seems easier than others to prefill such as 12train.com

[^1]: https://arxiv.org/pdf/1703.05997
[^2]: https://github.com/trainline-eu/csa-challenge
[^3]: https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip
