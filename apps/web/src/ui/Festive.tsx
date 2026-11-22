'use client';

import { PAL } from '@kto/assets';
import { useEffect, useState } from 'react';
import { newYearSeason } from '@/game/newyear';

/** Новогодний сезон (game/newyear.ts) — после монтирования: на сервере даты и ?season нет. */
export function useNewYear(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => setOn(newYearSeason()), []);
  return on;
}

const TILE_W = 1200;
const TILE_H = 1000;

/** Детерминированный «шум» — снежинки стоят одинаково при каждом открытии. */
function noise(i: number, k: number): number {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Тени-пиксели слоя снега: каждая снежинка дважды (y и y + высота плитки) — петля без шва. */
function flakes(n: number, seed: number, size: number, color: string): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = Math.floor(noise(i, seed) * TILE_W);
    const y = Math.floor(noise(i, seed + 1) * TILE_H);
    for (const dy of [0, TILE_H]) out.push(`${x}px ${y + dy}px 0 ${size - 1}px ${color}`);
  }
  return out.join(',');
}

const SMALL = flakes(220, 1, 1, PAL.mist);
const BIG = flakes(70, 7, 2, PAL.white);

/** Пиксельный снег поверх страницы (не ловит касания; при «уменьшить движение» — стоит). */
export function Snow() {
  return (
    <div className="snow" aria-hidden>
      <i style={{ boxShadow: SMALL, animationDuration: '16s' }} />
      <i style={{ boxShadow: BIG, animationDuration: '10s' }} />
    </div>
  );
}

/** Гирлянда из пиксельных лампочек: мигает по очереди. */
export function Garland() {
  return (
    <div className="garland" aria-hidden>
      {Array.from({ length: 13 }, (_, i) => (
        <i key={i} style={{ background: [PAL.amber, PAL.cyan, PAL.orchid, PAL.green, PAL.coral][i % 5], animationDelay: `${(i % 3) * 400}ms` }} />
      ))}
    </div>
  );
}
