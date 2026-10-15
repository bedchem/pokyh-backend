import { feature } from 'topojson-client';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { GeometryCollection, Topology } from 'topojson-specification';
// The world at 1:110 million from Natural Earth (public domain), fetched as a
// file of its own when the visitor map first opens and cached by the browser.
import atlasUrl from 'world-atlas/countries-110m.json?url';

// ISO 3166-1 numeric (the atlas' feature ids) → alpha-2 (what the edge
// reports), for every country the atlas draws. Kosovo has no numeric code and
// is matched by name below.
const NUMERIC_TO_ALPHA2: Record<string, string> = Object.fromEntries(
  ('4AF 8AL 10AQ 12DZ 24AO 31AZ 32AR 36AU 40AT 44BS 50BD 51AM 56BE 64BT 68BO 70BA 72BW 76BR 84BZ 90SB 96BN 100BG 104MM '
    + '108BI 112BY 116KH 120CM 124CA 140CF 144LK 148TD 152CL 156CN 158TW 170CO 178CG 180CD 188CR 191HR 192CU 196CY 203CZ '
    + '204BJ 208DK 214DO 218EC 222SV 226GQ 231ET 232ER 233EE 238FK 242FJ 246FI 250FR 260TF 262DJ 266GA 268GE 270GM 275PS '
    + '276DE 288GH 300GR 304GL 320GT 324GN 328GY 332HT 340HN 348HU 352IS 356IN 360ID 364IR 368IQ 372IE 376IL 380IT 384CI '
    + '388JM 392JP 398KZ 400JO 404KE 408KP 410KR 414KW 417KG 418LA 422LB 426LS 428LV 430LR 434LY 440LT 442LU 450MG 454MW '
    + '458MY 466ML 478MR 484MX 496MN 498MD 499ME 504MA 508MZ 512OM 516NA 524NP 528NL 540NC 548VU 554NZ 558NI 562NE 566NG '
    + '578NO 586PK 591PA 598PG 600PY 604PE 608PH 616PL 620PT 624GW 626TL 630PR 634QA 642RO 643RU 646RW 682SA 686SN 688RS '
    + '694SL 703SK 704VN 705SI 706SO 710ZA 716ZW 724ES 728SS 729SD 732EH 740SR 748SZ 752SE 756CH 760SY 762TJ 764TH 768TG '
    + '780TT 784AE 788TN 792TR 795TM 800UG 804UA 807MK 818EG 826GB 834TZ 840US 854BF 858UY 860UZ 862VE 887YE 894ZM')
    .split(' ')
    .map((entry) => [entry.slice(0, -2).padStart(3, '0'), entry.slice(-2)]),
);

export interface CountryShape {
  // Alpha-2, or "" for land the edge never reports on its own.
  code: string;
  feature: Feature<Geometry>;
}

let shapes: Promise<CountryShape[]> | null = null;

/** The countries of the world map, loaded once per page. Antarctica is left out. */
export function loadCountryShapes(): Promise<CountryShape[]> {
  shapes ??= fetch(atlasUrl)
    .then((res) => {
      if (!res.ok) throw new Error(`Karte nicht geladen (${res.status})`);
      return res.json() as Promise<Topology<{ countries: GeometryCollection<{ name: string }> }>>;
    })
    .then((topology) => {
      const collection = feature(topology, topology.objects.countries) as FeatureCollection<Geometry, { name: string }>;
      return collection.features
        .map((shape) => ({
          code: shape.id !== undefined ? NUMERIC_TO_ALPHA2[String(shape.id)] ?? '' : shape.properties?.name === 'Kosovo' ? 'XK' : '',
          feature: shape as Feature<Geometry>,
        }))
        .filter((shape) => shape.code !== 'AQ');
    })
    .catch((err: unknown) => {
      shapes = null;
      throw err;
    });
  return shapes;
}
