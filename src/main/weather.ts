// Round 7: weather without a backend round-trip. Open-Meteo (free, no key)
// geocoding + forecast. The location is the user's "Your location" setting (a
// city they typed or said) — never guessed from the IP address. Only the city
// name and coordinates go to Open-Meteo.

export const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

export type WeatherDay = 'now' | 'today' | 'tonight' | 'tomorrow' | 'weekend' | 'week';
export type Units = 'us' | 'metric';

export interface Place {
  name: string;
  admin1?: string;
  country?: string;
  countryCode?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
}

export interface WeatherQuery {
  day: WeatherDay;
  /** "in Seattle" when the user named a place. */
  city?: string;
}

const DAY_WORDS: [RegExp, WeatherDay][] = [
  [/\b(next week|this week|the week|coming week|7[- ]day|seven[- ]day)\b/, 'week'],
  [/\b(this )?weekend\b/, 'weekend'],
  [/\btomorrow\b/, 'tomorrow'],
  [/\btonight\b/, 'tonight'],
  [/\b(right now|now|currently|at the moment|outside)\b/, 'now'],
  [/\btoday\b/, 'today'],
];

/**
 * "what's the weather", "weather tomorrow in Portland", "will it rain this
 * weekend", "how hot is it outside", "do I need an umbrella today".
 * Returns null for anything that isn't a plain weather question.
 */
export function parseWeatherQuery(raw: string, wakeWord = 'cadabra'): WeatherQuery | null {
  const esc = wakeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const t = raw
    .toLowerCase()
    .replace(/[?!.]+$/g, '')
    // Only the wake word is stripped ("Cadabra, …"); "Seattle, Washington weather" keeps its city.
    .replace(new RegExp(`^(hey |ok |okay )?(${esc}|kadabra)[,\\s]+`), '')
    .trim();
  const weathery = /\b(weather|forecast|rain(ing|y)?|snow(ing|y)?|temperature|how (hot|cold|warm) (is it|will it be)|umbrella|sunny|cloudy|windy)\b/.test(t);
  if (!weathery) return null;
  // REVIEW-7 W7-7: songs, films, books, sounds and definitions are not weather questions.
  if (/\b(who|song|sang|sing|singer|album|lyrics|movie|film|book|wrote|author|play|sounds?|music|playlist|balloon|channel|app|website|meaning|define|definition|spell)\b/.test(t)) return null;
  if (/^(what|who) (is|was) (a|an|the) /.test(t) && !/\b(weather|forecast|temperature)\b (like |today|tomorrow|tonight|in |for |this |next |outside|now)/.test(t)) return null;
  if (/\b(open|launch|start|search|google|email|send|type|click)\b/.test(t)) return null;
  // A weather QUESTION shape (or a bare "weather …" request).
  const shaped =
    /^(what'?s|what is|what will|how'?s|how is|how will|how (hot|cold|warm)|will it|is it|is there|do i need|should i|any|forecast|weather|temperature|rain|snow)\b/.test(t) ||
    /\b(weather|forecast)\b/.test(t.split(/\s+/).slice(0, 4).join(' '));
  if (!shaped) return null;
  if (t.split(/\s+/).length > 14) return null;
  let day: WeatherDay = 'today';
  for (const [re, d] of DAY_WORDS) if (re.test(t)) {
    day = d;
    break;
  }
  if (/how (hot|cold|warm) is it|what('?s| is) the temperature/.test(t) && !/tomorrow|weekend|tonight|week/.test(t)) day = 'now';
  const when = '(?:\\s+(?:today|tomorrow|tonight|this weekend|next week|this week|right now|now))?';
  const m = new RegExp(`\\b(?:in|for|at|near)\\s+([a-z][a-z .,'-]{1,40}?)${when}$`).exec(t) ?? new RegExp(`^([a-z][a-z .,'-]{1,40}?)\\s+(?:weather|forecast)\\b`).exec(t);
  const city = m?.[1]?.replace(/\b(the|my area)\b/g, '').replace(/[,\s]+$/, '').trim();
  const notPlace = /^(the )?(morning|afternoon|evening|weekend|week|outside|here|today|tomorrow|what|what'?s the|how'?s the|is the)$/;
  const questionWord = /^(what|what'?s|how|how'?s|is|will|any|do|does|should|tell|give|whats)\b/;
  // "how cold is it in space": a named non-place → not a weather question for us.
  if (city && /^(space|the sun|the moon|mars|heaven|hell|the shade|the fridge|the freezer|the oven)$/.test(city)) return null;
  return { day, ...(city && !notPlace.test(city) && !questionWord.test(city) ? { city } : {}) };
}

/** REVIEW-7 W7-8: units follow the USER (their Windows locale), not the place asked about. */
export function unitsFor(locale: string): Units {
  const cc = (locale.split(/[-_]/)[1] ?? '').toUpperCase();
  return ['US', 'LR', 'MM', 'PR', 'GU', 'VI'].includes(cc) ? 'us' : 'metric';
}

/** WMO weather codes → plain words. */
export function describeCode(code: number): string {
  if (code === 0) return 'clear skies';
  if (code === 1) return 'mostly clear';
  if (code === 2) return 'partly cloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'foggy';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code >= 61 && code <= 67) return code >= 65 ? 'heavy rain' : 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain showers';
  if (code === 85 || code === 86) return 'snow showers';
  if (code >= 95) return 'thunderstorms';
  return 'mixed weather';
}

export interface WeatherDeps {
  fetchImpl?: typeof fetch;
  geoUrl?: string;
  forecastUrl?: string;
  timeoutMs?: number;
}

async function getJson(url: string, d: WeatherDeps): Promise<any> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), d.timeoutMs ?? 6000);
  try {
    const r = await (d.fetchImpl ?? fetch)(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`weather service error (HTTP ${r.status})`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function geocode(city: string, d: WeatherDeps = {}): Promise<Place | null> {
  // "Seattle, Washington" → name "Seattle" (Open-Meteo matches the place name), region used to pick.
  const [name, region] = city.split(',').map((x) => x.trim());
  const j = await getJson(`${d.geoUrl ?? GEO_URL}?name=${encodeURIComponent(name)}&count=5&language=en&format=json`, d);
  const rs: any[] = Array.isArray(j?.results) ? j.results : [];
  if (!rs.length) return null;
  const pick = (region && rs.find((r) => `${r.admin1 ?? ''} ${r.country ?? ''} ${r.country_code ?? ''}`.toLowerCase().includes(region.toLowerCase()))) || rs[0];
  return { name: pick.name, admin1: pick.admin1, country: pick.country, countryCode: pick.country_code, latitude: pick.latitude, longitude: pick.longitude, timezone: pick.timezone };
}

export interface Forecast {
  place: Place;
  units: Units;
  current: { temp: number; code: number; wind: number };
  days: { date: string; max: number; min: number; code: number; rain: number }[];
  /** Hourly temperatures (local time), for "tonight". */
  hourly?: { time: string[]; temp: number[]; rain: number[] };
}

export async function forecast(place: Place, units: Units, d: WeatherDeps = {}): Promise<Forecast> {
  const q = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'temperature_2m,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
    hourly: 'temperature_2m,precipitation_probability',
    forecast_days: '8',
    timezone: 'auto',
    ...(units === 'us' ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph' } : { wind_speed_unit: 'kmh' }),
  });
  const j = await getJson(`${d.forecastUrl ?? FORECAST_URL}?${q}`, d);
  const dl = j?.daily ?? {};
  const days = (dl.time ?? []).map((date: string, i: number) => ({ date, max: dl.temperature_2m_max?.[i], min: dl.temperature_2m_min?.[i], code: dl.weather_code?.[i], rain: dl.precipitation_probability_max?.[i] ?? 0 }));
  const hr = j?.hourly;
  return {
    place,
    units,
    current: { temp: j?.current?.temperature_2m, code: j?.current?.weather_code, wind: j?.current?.wind_speed_10m },
    days,
    ...(hr?.time ? { hourly: { time: hr.time, temp: hr.temperature_2m ?? [], rain: hr.precipitation_probability ?? [] } } : {}),
  };
}

const deg = (n: number) => `${Math.round(n)}°`;

/** One or two short spoken sentences. */
export function weatherSentence(f: Forecast, day: WeatherDay): string {
  const where = f.place.name;
  const rain = (p: number) => (p >= 60 ? ` and a ${Math.round(p / 10) * 10}% chance of rain` : p >= 30 ? `, with some chance of rain` : '');
  const d0 = f.days[0];
  if (day === 'now') return `It's ${deg(f.current.temp)} and ${describeCode(f.current.code)} in ${where} right now.`;
  if (day === 'today' || day === 'tonight') {
    if (!d0) return `It's ${deg(f.current.temp)} in ${where} right now.`;
    if (day === 'tonight') {
      // REVIEW-7: tonight = 18:00 today → 06:00 tomorrow (the daily minimum is usually THIS morning).
      const h = f.hourly;
      if (h?.time.length) {
        const from = `${d0.date}T18:00`;
        const next = f.days[1]?.date;
        const to = next ? `${next}T06:00` : `${d0.date}T23:59`;
        const idx = h.time.map((t, i) => (t >= from && t <= to ? i : -1)).filter((i) => i >= 0);
        if (idx.length) {
          const low = Math.min(...idx.map((i) => h.temp[i]));
          const pr = Math.max(...idx.map((i) => h.rain[i] ?? 0));
          return `Tonight in ${where}: down to about ${deg(low)}${rain(pr)}.`;
        }
      }
      return `Tonight in ${where}: ${describeCode(d0.code)}, down to about ${deg(d0.min)}${rain(d0.rain)}.`;
    }
    return `Today in ${where}: ${describeCode(d0.code)}, a high of ${deg(d0.max)} and a low of ${deg(d0.min)}${rain(d0.rain)}. It's ${deg(f.current.temp)} now.`;
  }
  if (day === 'tomorrow') {
    const d1 = f.days[1];
    if (!d1) return `I don't have tomorrow's forecast for ${where} yet.`;
    return `Tomorrow in ${where}: ${describeCode(d1.code)}, a high of ${deg(d1.max)} and a low of ${deg(d1.min)}${rain(d1.rain)}.`;
  }
  if (day === 'week') {
    const ds = f.days.slice(1, 8);
    if (!ds.length) return `I don't have next week's forecast for ${where} yet.`;
    const hi = ds.map((x) => x.max);
    const wet = ds.filter((x) => x.rain >= 50).map((x) => new Date(`${x.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' }));
    return `The week ahead in ${where}: highs from ${deg(Math.min(...hi))} to ${deg(Math.max(...hi))}${wet.length ? `, rain likely on ${wet.slice(0, 2).join(' and ')}` : ', mostly dry'}.`;
  }
  // weekend: the coming Saturday and Sunday (on a Sunday, just today).
  const today = f.days[0] ? new Date(`${f.days[0].date}T12:00:00`).getDay() : -1;
  const wk = f.days.filter((x, i) => {
    const wd = new Date(`${x.date}T12:00:00`).getDay();
    if (today === 0) return i === 0;
    return (wd === 6 || wd === 0) && i <= 7 && (wd !== 0 || f.days.slice(0, i).some((y) => new Date(`${y.date}T12:00:00`).getDay() === 6) || i < 7);
  }).slice(0, 2);
  if (!wk.length) return `I don't have the weekend forecast for ${where} yet.`;
  const parts = wk.slice(0, 2).map((x) => `${new Date(`${x.date}T12:00:00`).getDay() === 6 ? 'Saturday' : 'Sunday'} ${describeCode(x.code)}, high ${deg(x.max)}${x.rain >= 50 ? `, ${Math.round(x.rain / 10) * 10}% rain` : ''}`);
  return `This weekend in ${where}: ${parts.join('; ')}.`;
}

/** Everything in one call: geocode (cached per city) + forecast + sentence. */
export class WeatherService {
  private geoCache = new Map<string, Place>();
  constructor(
    private readonly deps: WeatherDeps & { locale: () => string } = { locale: () => 'en-US' },
  ) {}

  async lookup(city: string, day: WeatherDay): Promise<{ text: string; forecast: Forecast } | { error: string; notFound?: boolean }> {
    const key = city.trim().toLowerCase();
    try {
      let place = this.geoCache.get(key) ?? null;
      if (!place) {
        place = await geocode(city, this.deps);
        if (place) this.geoCache.set(key, place);
      }
      if (!place) return { error: `I couldn't find a place called ${city}.`, notFound: true } as { error: string; notFound?: boolean };
      const f = await forecast(place, unitsFor(this.deps.locale()), this.deps);
      return { text: weatherSentence(f, day), forecast: f };
    } catch (e) {
      return { error: `The weather service didn't answer (${(e as Error).message}).` };
    }
  }
}
