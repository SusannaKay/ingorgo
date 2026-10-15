// Mondi a tema: cambiano ogni 10 livelli e poi ricominciano dal primo.
export type Deco = 'city' | 'snow' | 'beach' | 'night' | 'desert' | 'autumn';

export interface Theme {
  id: Deco;
  name: string;
  ground: string;
  groundSpeck: [string, string];
  asphalt: string;
  lot: string;
  lotAlt: string;
  plaza: string;
  curb: string;
  platform: string;
  sidewalk: string;
  sky: string;
  hemiSky: string;
  hemiGround: string;
  hemi: number;
  sun: string;
  sunPower: number;
  night: boolean;
  /** colori per l'interfaccia (sfondo della pagina dietro al canvas) */
  page: string;
}

export const THEMES: Theme[] = [
  {
    id: 'city',
    name: 'Città',
    ground: '#8fd16a',
    groundSpeck: ['#6fb553', '#b4e58f'],
    asphalt: '#4a5175',
    lot: '#a3aac7',
    lotAlt: '#959cbc',
    plaza: '#d5d9e8',
    curb: '#f1f2f7',
    platform: '#f3ecdc',
    sidewalk: '#e7dfcc',
    sky: '#9fd8f0',
    hemiSky: '#e8f4ff',
    hemiGround: '#7a9a5a',
    hemi: 1.15,
    sun: '#fff3dc',
    sunPower: 2.1,
    night: false,
    page: '#8fd16a',
  },
  {
    id: 'snow',
    name: 'Neve',
    ground: '#eef4fb',
    groundSpeck: ['#d6e3f2', '#ffffff'],
    asphalt: '#556080',
    lot: '#b4c2db',
    lotAlt: '#a7b6d2',
    plaza: '#e2eaf5',
    curb: '#ffffff',
    platform: '#eef1f7',
    sidewalk: '#dfe6f0',
    sky: '#cfe4f7',
    hemiSky: '#f2f8ff',
    hemiGround: '#b8c8de',
    hemi: 1.2,
    sun: '#ffffff',
    sunPower: 1.8,
    night: false,
    page: '#eef4fb',
  },
  {
    id: 'beach',
    name: 'Spiaggia',
    ground: '#f2dc9e',
    groundSpeck: ['#e3c784', '#fbecc2'],
    asphalt: '#4f5677',
    lot: '#a9b4cc',
    lotAlt: '#9ba7c2',
    plaza: '#f6ecd2',
    curb: '#ffffff',
    platform: '#fff5e0',
    sidewalk: '#f0e2bf',
    sky: '#8fd8f2',
    hemiSky: '#ffffff',
    hemiGround: '#d9c08a',
    hemi: 1.2,
    sun: '#fff1cf',
    sunPower: 2.2,
    night: false,
    page: '#f2dc9e',
  },
  {
    id: 'night',
    name: 'Notte',
    ground: '#28453a',
    groundSpeck: ['#1f382f', '#33584a'],
    asphalt: '#262b40',
    lot: '#6a7296',
    lotAlt: '#5f678a',
    plaza: '#3d4462',
    curb: '#8a91ad',
    platform: '#5d6380',
    sidewalk: '#4a5069',
    sky: '#141a2e',
    hemiSky: '#6f84c8',
    hemiGround: '#1b2a24',
    hemi: 1.35,
    sun: '#b8c8ff',
    sunPower: 1.3,
    night: true,
    page: '#1d2a33',
  },
  {
    id: 'desert',
    name: 'Deserto',
    ground: '#e8b46e',
    groundSpeck: ['#d89e58', '#f3c98d'],
    asphalt: '#5a4f57',
    lot: '#c2b2a0',
    lotAlt: '#b6a592',
    plaza: '#f0d9b5',
    curb: '#fff4e2',
    platform: '#f6e6cb',
    sidewalk: '#ead1a9',
    sky: '#f6d7a0',
    hemiSky: '#fff2d8',
    hemiGround: '#c98f4e',
    hemi: 1.1,
    sun: '#ffe0b0',
    sunPower: 2.3,
    night: false,
    page: '#e8b46e',
  },
  {
    id: 'autumn',
    name: 'Autunno',
    ground: '#b9c46a',
    groundSpeck: ['#d39b45', '#9fae55'],
    asphalt: '#4d5070',
    lot: '#aeaabe',
    lotAlt: '#a19db3',
    plaza: '#e6dccb',
    curb: '#f4efe6',
    platform: '#f2e6d2',
    sidewalk: '#e2d2b6',
    sky: '#f2d3a6',
    hemiSky: '#fff1dd',
    hemiGround: '#8f7d48',
    hemi: 1.1,
    sun: '#ffdcae',
    sunPower: 2.0,
    night: false,
    page: '#b9c46a',
  },
];

export function themeForLevel(n: number): Theme {
  return THEMES[Math.floor((n - 1) / 10) % THEMES.length];
}
