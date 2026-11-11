# [FlightWeather](https://flightweather.org/)
This is an app that tells you about airport weather via METAR. It is designed to be a hosted weather lookup service for any airport.

## Airport movements

Recent arrivals and departures are provided by [adsb.lol](https://www.adsb.lol/), which exposes live ADS-B traffic around an airport. The app queries the airport neighborhood and classifies aircraft as arrivals or departures based on their movement vectors and recent position updates.

The app caches each airport movement result for two minutes to reduce unnecessary API calls. Credit for the live aircraft data belongs to [adsb.lol](https://www.adsb.lol/) under the ODbL 1.0 open-data license.

METAR data comes from the [Aviation Weather Center](https://aviationweather.gov/), airport reference data comes from [OurAirports](https://ourairports.com/data/), and the live flight map data is provided by [adsb.lol](https://www.adsb.lol/).

## Airport briefing

`GET /api/briefing/:icao` aggregates keyless METAR, TAF, PIREP, active Aviation Weather Center SIGMETs covering the airport, nearby ADS-B, Open-Meteo winds and daylight, and OurAirports runway data. U.S. airports also receive FAA NAS airport-event data, cached for 60 seconds. The endpoint resolves its airport coordinates server-side and fetches independent sources concurrently; partial source failures are reported in the response's `errors` object. FAA event data is informational; verify operational restrictions on the [official FAA NAS Status dashboard](https://nasstatus.faa.gov/).

METAR, TAF, PIREP, and SIGMET responses are cached for 60 seconds, ADS-B for 15 seconds, Open-Meteo for 15 minutes, and runway CSV data for 24 hours. Provider requests are proxied by the server/Worker and require no browser API keys.

Open-Meteo's free API is for non-commercial use only; commercial use requires an appropriate subscription. See [Open-Meteo's terms](https://open-meteo.com/en/terms) before operating this site. Standard OpenStreetMap tiles are community-funded and subject to the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/); use a suitable tile provider for sustained commercial traffic.

## Running and testing

`npm start` runs the Cloudflare Worker locally. `node server.js` runs the standalone Node server. They intentionally keep parallel request logic because the two environments handle HTTP requests, static assets, and caching differently; update both when changing provider behavior. Run `npm test` for the Node server's HTTP regression checks.

The field-conditions summary shows both customary and metric values together. The arrivals, departures, and all-flights tabs use one cached ADS-B snapshot per airport. Cloudflare also keeps a shared edge copy for two minutes and retains it for up to ten minutes to serve during temporary ADS-B rate limits.
