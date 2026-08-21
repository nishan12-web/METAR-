# [FlightWeather](https://flightweather.org/)
This is an app that tells you about airport weather via METAR. It is designed to be a hosted weather lookup service for any airport.

## Airport schedules

Schedule data is provided by Aviation Edge. For local Wrangler development, create a `.dev.vars` file with:

```text
AVIATION_EDGE_API_KEY=your_key_here
```

For the standalone Node server (`node server.js`), configure the API key before starting:

```bash
AVIATION_EDGE_API_KEY=your_key_here npm start
```

For Cloudflare, store it as a secret:

```bash
npx wrangler secret put AVIATION_EDGE_API_KEY
```

If no Aviation Edge key is configured, the app automatically falls back to ADSB.lol and ADSBdb, free no-key live ADS-B services. The fallback enriches recognized callsigns with airline and route details, then estimates arrivals from descending aircraft and departures from climbing aircraft within 50 nautical miles. It shows observed times, not guaranteed scheduled times.
