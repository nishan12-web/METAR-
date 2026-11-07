# [FlightWeather](https://flightweather.org/)
This is an app that tells you about airport weather via METAR. It is designed to be a hosted weather lookup service for any airport.

## Airport movements

Recent arrivals and departures are provided by [adsb.lol](https://www.adsb.lol/), which exposes live ADS-B traffic around an airport. The app queries the airport neighborhood and classifies aircraft as arrivals or departures based on their movement vectors and recent position updates.

The app caches each airport movement result for two minutes to reduce unnecessary API calls. Credit for the live aircraft data belongs to [adsb.lol](https://www.adsb.lol/) under the ODbL 1.0 open-data license.

METAR data comes from the [Aviation Weather Center](https://aviationweather.gov/), airport reference data comes from [OurAirports](https://ourairports.com/data/), and the live flight map data is provided by [adsb.lol](https://www.adsb.lol/).
