# [FlightWeather](https://flightweather.org/)
This is an app that tells you about airport weather via METAR. It is designed to be a hosted weather lookup service for any airport.

## Airport movements

Recent arrivals and departures are provided by [The OpenSky Network](https://opensky-network.org/), using its airport flight endpoints and a two-hour lookback window. These are observed movements, not guaranteed future schedules.

OpenSky may rate-limit anonymous API requests. For Cloudflare, add an OpenSky account as secrets before deploying:

```bash
npx wrangler secret put OPENSKY_USERNAME
npx wrangler secret put OPENSKY_PASSWORD
```

For local Node development, set `OPENSKY_USERNAME` and `OPENSKY_PASSWORD` in the environment before starting the server. The app uses these credentials for authenticated OpenSky requests and asks OpenSky for aircraft registration and model metadata when available.

METAR data comes from the [Aviation Weather Center](https://aviationweather.gov/), and airport reference data comes from [OurAirports](https://ourairports.com/data/).
