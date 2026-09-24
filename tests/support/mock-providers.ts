import { createServer, type IncomingMessage, type Server } from 'node:http';

/**
 * Mock of the external provider APIs (Google Places v1, Nominatim, Overpass, Brave) that
 * returns a small, deterministic dental-clinic dataset pointing at the local fixture websites.
 * Used by integration and E2E tests so no network access or API keys are needed.
 */
export interface MockProviders {
  url: string;
  calls: Array<{ path: string; body?: string }>;
  failGoogle: boolean;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function googlePlaces(sites: Record<string, string>) {
  const comp = (street: string, no: string, postal: string) => [
    { longText: street, shortText: street, types: ['route'] },
    { longText: no, shortText: no, types: ['street_number'] },
    { longText: postal, shortText: postal, types: ['postal_code'] },
    { longText: 'Warszawa', shortText: 'Warszawa', types: ['locality'] },
    { longText: 'Poland', shortText: 'PL', types: ['country'] },
  ];
  return [
    {
      id: 'gp_smile',
      displayName: { text: 'Smile Dental Stomatologia' },
      formattedAddress: 'Marszałkowska 10, 00-001 Warszawa, Poland',
      addressComponents: comp('Marszałkowska', '10', '00-001'),
      location: { latitude: 52.2297, longitude: 21.0122 },
      types: ['dentist', 'health'],
      primaryTypeDisplayName: { text: 'Dentist' },
      internationalPhoneNumber: '+48 22 123 45 67',
      websiteUri: sites['smile-dental'],
      businessStatus: 'OPERATIONAL',
      rating: 4.2,
      userRatingCount: 87,
      priceLevel: 'PRICE_LEVEL_MODERATE',
      googleMapsUri: 'https://maps.google.com/?cid=1',
    },
    {
      id: 'gp_nova',
      displayName: { text: 'Nova Dental Clinic' },
      formattedAddress: 'Puławska 100, 02-620 Warszawa, Poland',
      addressComponents: comp('Puławska', '100', '02-620'),
      location: { latitude: 52.1934, longitude: 21.0182 },
      types: ['dentist'],
      primaryTypeDisplayName: { text: 'Dentist' },
      internationalPhoneNumber: '+48 22 555 11 22',
      websiteUri: sites['modern-clinic'],
      businessStatus: 'OPERATIONAL',
      rating: 4.9,
      userRatingCount: 412,
      priceLevel: 'PRICE_LEVEL_EXPENSIVE',
    },
    {
      id: 'gp_kowalski',
      displayName: { text: 'Gabinet Stomatologiczny Kowalski' },
      formattedAddress: 'Grójecka 50, 02-001 Warszawa, Poland',
      addressComponents: comp('Grójecka', '50', '02-001'),
      location: { latitude: 52.2201, longitude: 20.9855 },
      types: ['dentist'],
      internationalPhoneNumber: '+48 601 111 222',
      businessStatus: 'OPERATIONAL',
      rating: 4.7,
      userRatingCount: 23,
    },
    {
      id: 'gp_closed',
      displayName: { text: 'Old Dental Office' },
      formattedAddress: 'Nowy Świat 5, 00-002 Warszawa, Poland',
      addressComponents: comp('Nowy Świat', '5', '00-002'),
      location: { latitude: 52.233, longitude: 21.018 },
      types: ['dentist'],
      internationalPhoneNumber: '+48 22 999 00 11',
      businessStatus: 'CLOSED_PERMANENTLY',
    },
    {
      id: 'gp_biale',
      displayName: { text: 'Białe Zęby Centrum' },
      formattedAddress: 'Wola 12, 01-001 Warszawa, Poland',
      addressComponents: comp('Wolska', '12', '01-001'),
      location: { latitude: 52.236, longitude: 20.96 },
      types: ['dentist'],
      internationalPhoneNumber: '+48 22 333 44 55',
      websiteUri: 'https://booksy.com/pl-pl/12345_biale-zeby',
      businessStatus: 'OPERATIONAL',
      rating: 4.5,
      userRatingCount: 150,
    },
  ];
}

export function overpassPois(sites: Record<string, string>) {
  return [
    // duplicate of Google "Smile Dental Stomatologia": same phone + website, slightly different name
    { type: 'node', id: 101, lat: 52.22972, lon: 21.01221, tags: { amenity: 'dentist', name: 'Smile Dental', phone: '+48 22 123 45 67', website: sites['smile-dental'], 'addr:street': 'Marszałkowska', 'addr:housenumber': '10', 'addr:city': 'Warszawa', 'addr:postcode': '00-001' } },
    // only in OSM; website verified through the phone number on the page
    { type: 'node', id: 102, lat: 52.2, lon: 21.02, tags: { healthcare: 'dentist', name: 'Uśmiech Mokotów', phone: '+48 601 234 567', website: sites['bella-beauty'], 'addr:street': 'Racławicka', 'addr:housenumber': '3', 'addr:city': 'Warszawa' } },
    // conflicting phone for Nova (discrepancy must be shown)
    { type: 'way', id: 103, center: { lat: 52.19341, lon: 21.01822 }, tags: { amenity: 'dentist', name: 'Nova Dental Clinic', phone: '+48 22 555 11 99', website: sites['modern-clinic'], 'addr:street': 'Puławska', 'addr:housenumber': '100' } },
  ];
}

export async function startMockProviders(sites: Record<string, string>): Promise<MockProviders> {
  const state: MockProviders = { url: '', calls: [], failGoogle: false, close: async () => undefined };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const b = req.method === 'POST' ? await body(req) : undefined;
    state.calls.push({ path: url.pathname, body: b });
    const json = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (url.pathname === '/v1/places:searchText') {
      if (req.headers['x-goog-api-key'] !== 'test-google-key') return json(403, { error: { message: 'bad key' } });
      if (state.failGoogle) return json(503, { error: { message: 'unavailable' } });
      return json(200, { places: googlePlaces(sites) });
    }
    if (url.pathname.startsWith('/v1/places/')) {
      const id = url.pathname.split('/').pop();
      const p = googlePlaces(sites).find((x) => x.id === id);
      return p ? json(200, p) : json(404, { error: { message: 'not found' } });
    }
    if (url.pathname === '/search') {
      return json(200, [{ osm_type: 'relation', osm_id: 336075, lat: '52.2319581', lon: '21.0067249', boundingbox: ['52.0978', '52.3681', '20.8516', '21.2711'], display_name: 'Warszawa, województwo mazowieckie, Polska', address: { city: 'Warszawa', country_code: 'pl' } }]);
    }
    if (url.pathname === '/interpreter') {
      const q = new URLSearchParams(b ?? '').get('data') ?? '';
      if (q.includes('boundary')) {
        return json(200, { elements: ['Śródmieście', 'Mokotów', 'Wola', 'Ochota'].map((name, i) => ({ type: 'relation', id: 900 + i, tags: { name, admin_level: '9', boundary: 'administrative' } })) });
      }
      return json(200, { elements: overpassPois(sites) });
    }
    if (url.pathname === '/res/v1/web/search') {
      return json(200, { web: { results: [] } });
    }
    json(404, { error: 'unknown mock endpoint' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  state.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}

/** Environment that points every provider at the mock server. */
export function mockProviderEnv(mockUrl: string): Record<string, string> {
  return {
    GOOGLE_PLACES_API_KEY: 'test-google-key',
    GOOGLE_PLACES_BASE_URL: mockUrl,
    NOMINATIM_BASE_URL: mockUrl,
    OVERPASS_BASE_URL: mockUrl,
    OSM_ENABLED: 'true',
    FOURSQUARE_API_KEY: '',
    YELP_API_KEY: '',
    BRAVE_SEARCH_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    AI_PROVIDER: 'none',
  };
}
