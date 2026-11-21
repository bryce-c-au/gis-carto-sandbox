import * as Astronomy from 'astronomy-engine';
import { skyLocations } from '../data/sky-locations';

type Forecast = {
  hourly: {
    time: string[];
    cloud_cover: (number | null)[];
    cloud_cover_low: (number | null)[];
    cloud_cover_mid: (number | null)[];
    cloud_cover_high: (number | null)[];
  };
};

export function initTonightConditions() {
  const locationInput = document.querySelector<HTMLSelectElement>('#conditions-location')!;
  const timeInput = document.querySelector<HTMLInputElement>('#conditions-time')!;
  const status = document.querySelector<HTMLElement>('#conditions-status')!;
  const moonValue = document.querySelector<HTMLElement>('#moon-value')!;
  const moonDetail = document.querySelector<HTMLElement>('#moon-detail')!;
  const riseSet = document.querySelector<HTMLElement>('#moon-rise-set')!;
  const skyState = document.querySelector<HTMLElement>('#sky-state')!;
  const skyLink = document.querySelector<HTMLAnchorElement>('#sky-link')!;
  const cloudValue = document.querySelector<HTMLElement>('#cloud-value')!;
  const cloudDetail = document.querySelector<HTMLElement>('#cloud-detail')!;
  const formatter = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit', hour12: true });
  const cache = new Map<string, { forecast: Forecast; fetchedAt: number }>();
  let requestId = 0;

  const brisbaneDate = (dayOffset: number) => new Date(Date.now() + (10 * 60 * 60 * 1000) + dayOffset * 86400000).toISOString().slice(0, 10);
  const nowHour = Number(new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(11, 13));
  timeInput.min = brisbaneDate(0) + 'T00:00';
  timeInput.max = brisbaneDate(6) + 'T23:00';
  timeInput.value = brisbaneDate(nowHour >= 21 ? 1 : 0) + 'T21:00';

  const percentage = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value)}%`;
  const timeOf = (event: Astronomy.AstroTime | null) => event ? formatter.format(event.date) : '—';

  function updateMoon() {
    const [, latitude, longitude] = skyLocations[locationInput.value];
    const when = new Date(timeInput.value + ':00+10:00');
    if (Number.isNaN(when.getTime())) return;
    const observer = new Astronomy.Observer(latitude, longitude, 0);
    const illumination = Astronomy.Illumination(Astronomy.Body.Moon, when).phase_fraction;
    const moon = Astronomy.Equator(Astronomy.Body.Moon, when, observer, true, true);
    const moonAltitude = Astronomy.Horizon(when, observer, moon.ra, moon.dec, 'normal').altitude;
    const sun = Astronomy.Equator(Astronomy.Body.Sun, when, observer, true, true);
    const sunAltitude = Astronomy.Horizon(when, observer, sun.ra, sun.dec, 'normal').altitude;
    const dayStart = new Date(timeInput.value.slice(0, 10) + 'T00:00:00+10:00');
    const moonrise = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, 1, dayStart, 1);
    const moonset = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, -1, dayStart, 1);
    moonValue.textContent = `${Math.round(illumination * 100)}% illuminated`;
    moonDetail.textContent = moonAltitude >= 0
      ? `Moon ${Math.round(moonAltitude)}° above the horizon at the selected time`
      : `Moon ${Math.round(Math.abs(moonAltitude))}° below the horizon at the selected time`;
    riseSet.textContent = `Moonrise ${timeOf(moonrise)} · moonset ${timeOf(moonset)} (selected date)`;
    skyState.textContent = sunAltitude < -18 ? 'Astronomical night' : sunAltitude < 0 ? 'Twilight' : 'Daylight';
  }

  function updateCloud(forecast: Forecast) {
    const hour = timeInput.value.slice(0, 13) + ':00';
    const index = forecast.hourly.time.indexOf(hour);
    if (index < 0) {
      cloudValue.textContent = 'Outside forecast';
      cloudDetail.textContent = 'Choose an hour within the next seven days.';
      return;
    }
    const data = forecast.hourly;
    cloudValue.textContent = percentage(data.cloud_cover[index]);
    cloudDetail.textContent = `Low ${percentage(data.cloud_cover_low[index])} · mid ${percentage(data.cloud_cover_mid[index])} · high ${percentage(data.cloud_cover_high[index])}`;
  }

  async function update() {
    updateMoon();
    const skyUrl = new URL(skyLink.href);
    skyUrl.searchParams.set('location', locationInput.value);
    skyUrl.searchParams.set('time', timeInput.value);
    skyLink.href = skyUrl.toString();
    const id = ++requestId;
    const key = locationInput.value;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < 30 * 60 * 1000) {
      updateCloud(cached.forecast);
      status.textContent = `Open-Meteo forecast · fetched ${formatter.format(cached.fetchedAt)}`;
      return;
    }
    const [, latitude, longitude] = skyLocations[key];
    cloudValue.textContent = 'Loading…';
    cloudDetail.textContent = 'Fetching hourly cloud forecast';
    status.textContent = 'Loading forecast…';
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(latitude));
    url.searchParams.set('longitude', String(longitude));
    url.searchParams.set('hourly', 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high');
    url.searchParams.set('timezone', 'Australia/Brisbane');
    url.searchParams.set('forecast_days', '7');
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Forecast HTTP ${response.status}`);
      const forecast = await response.json() as Forecast;
      const fetchedAt = Date.now();
      cache.set(key, { forecast, fetchedAt });
      if (id !== requestId) return;
      updateCloud(forecast);
      status.textContent = `Open-Meteo forecast · fetched ${formatter.format(fetchedAt)}`;
    } catch {
      if (id !== requestId) return;
      cloudValue.textContent = 'Unavailable';
      cloudDetail.textContent = 'The cloud forecast could not be loaded.';
      status.textContent = 'Moon calculations remain available offline';
    }
  }

  locationInput.addEventListener('change', update);
  timeInput.addEventListener('change', update);
  update();
  return {
    selectLocation(id: string) {
      locationInput.value = skyLocations[id] ? id : 'brisbane';
      update();
    },
  };
}
