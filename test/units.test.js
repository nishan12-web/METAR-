const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { test } = require("node:test");

function createElement() {
  return {
    addEventListener() {},
    append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); },
    classList: { add() {}, remove() {}, toggle() {} },
    children: [],
    replaceChildren(...items) { this.children = items; },
    setAttribute() {},
    style: {},
    textContent: ""
  };
}

function loadPageFunctions(fetch = async () => ({ ok: true, json: async () => ({}) })) {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const pageScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const getElement = selector => {
    if (!elements.has(selector)) elements.set(selector, createElement());
    return elements.get(selector);
  };
  const document = {
    addEventListener() {},
    createElement,
    createTextNode: text => ({ textContent: text }),
    querySelector: getElement,
    querySelectorAll: () => []
  };
  const leafletMap = { setView() {}, flyTo() {} };
  const context = {
    document,
    window: { location: { protocol: "https:" } },
    L: {
      map: () => leafletMap,
      tileLayer: () => ({ addTo() {} })
    },
    fetch,
    console
  };

  vm.runInNewContext(`${pageScript}
    globalThis.unitTestHooks = {
      parseMetarData,
      renderWeatherValues,
      determineFlightCategory,
      updateMetricContext,
      loadSchedule,
      setScheduleIcao(value) { scheduleIcao = value; }
    };
  `, context);

  return { ...context.unitTestHooks, elements };
}

test("weather metrics show customary and metric values together", () => {
  const app = loadPageFunctions();
  const metar = app.parseMetarData("METAR TEST 27010G15KT 1 1/2SM BKN005", {
    temp: 20,
    dewp: 18,
    wdir: 270,
    wspd: 10,
    wgst: 15,
    visib: "1 1/2",
    clouds: [{ cover: "BKN", base: 500 }],
    altim: 29.92
  });

  app.renderWeatherValues(metar);
  app.updateMetricContext(metar);

  assert.equal(metar.tempC, 20);
  assert.equal(metar.visibilitySm, 1.5);
  assert.equal(metar.ceilingFt, 500);
  assert.equal(app.elements.get("#temp").textContent, "20°C / 68°F");
  assert.equal(app.elements.get("#dewpoint").textContent, "18°C / 64°F");
  assert.equal(app.elements.get("#wind").textContent, "270° @ 10kt / 12mph / 19km/h G15kt / G17mph / G28km/h");
  assert.equal(app.elements.get("#visibility").textContent, "1.5mi / 2.4km");
  assert.equal(app.elements.get("#ceiling").textContent, "500ft / 152m");
  assert.equal(app.elements.get("#altimeter").textContent, "29.92inHg / 1013hPa");
  assert.match(app.elements.get("#dewpointContext").textContent, /2\.0 °C \/ 3\.6 °F/);
  assert.equal(app.elements.get("#flightCategory").textContent, "IFR");
  assert.equal(app.determineFlightCategory(500, 0).category, "LIFR");
});

test("weather context handles reports without temperature or dew point", () => {
  const app = loadPageFunctions();
  app.updateMetricContext({
    tempC: null,
    dewpointC: null,
    windSpeedKt: null,
    visibilitySm: null,
    ceilingFt: null,
    altimeterInHg: null
  });

  assert.equal(app.elements.get("#tempContext").textContent, "Air temperature at the field.");
  assert.match(app.elements.get("#dewpointContext").textContent, /close temperature spread/);
});

test("all, arrivals, and departures use one combined movement request", async () => {
  const requests = [];
  const flights = [
    { movementType: "arrival", flight: { number: "ARR1", callsign: "ARR1" }, observedAt: null },
    { movementType: "departure", flight: { number: "DEP1", callsign: "DEP1" }, observedAt: null }
  ];
  const app = loadPageFunctions(async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ flights }) };
  });
  app.setScheduleIcao("TEST");

  await app.loadSchedule("schedule");
  assert.equal(app.elements.get("#scheduleList").children.length, 2);
  await app.loadSchedule("arrival");
  assert.equal(app.elements.get("#scheduleList").children.length, 1);
  await app.loadSchedule("departure");
  assert.equal(app.elements.get("#scheduleList").children.length, 1);
  assert.deepEqual(requests, ["/api/schedule/TEST/all"]);
});
