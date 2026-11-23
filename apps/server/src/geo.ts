/**
 * Страна по адресу — для замера доступности (событие net_probe, docs/infra-plan.md › этап 0):
 * «скорее всего VPN» = зарубежный адрес у телефона с русским языком и часовым поясом России.
 * Сам адрес нигде не храним — только код страны.
 *
 * База — бесплатная DB-IP «IP to Country Lite» (CC BY 4.0, https://db-ip.com), формат MMDB, из npm-пакета
 * @ip-location-db/dbip-country-mmdb (db-ip.com из наших сред закрыт, npm — нет). Её привозит game-deploy,
 * путь — GEOIP_DB. Нет базы — страна неизвестна. Записи бывают двух видов: { country_code } (ip-location-db)
 * и { country: { iso_code } } (GeoLite2) — понимаем оба.
 */
import { readFileSync } from 'node:fs';
import { Reader } from 'mmdb-lib';

/** Запись базы: ip-location-db или GeoLite2. */
interface CountryRecord {
  country_code?: string;
  country?: { iso_code?: string };
}

export interface Geo {
  country(ip: string): string | null;
}

export function loadGeo(path: string | undefined, log?: (msg: string, f?: Record<string, unknown>) => void): Geo {
  if (!path) return { country: () => null };
  try {
    const reader = new Reader(readFileSync(path));
    log?.('geo_ready', { path });
    return {
      country(ip: string): string | null {
        try {
          const clean = ip.replace(/^::ffff:/, '');
          // типы библиотеки знают только GeoLite2 — запись ip-location-db читаем как свою
          const r = reader.get(clean) as CountryRecord | null;
          return r?.country_code ?? r?.country?.iso_code ?? null;
        } catch {
          return null;
        }
      },
    };
  } catch (e) {
    log?.('geo_unavailable', { path, err: String(e) });
    return { country: () => null };
  }
}
