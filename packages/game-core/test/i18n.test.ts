import { describe, expect, it } from 'vitest';
import { DICTS, LANGS, THEME_COUNT, fmt, pickLang, tp } from '../src';
import type { Dict, Lang } from '../src';

function shape(o: unknown): unknown {
  if (Array.isArray(o)) return 'array';
  if (o && typeof o === 'object') {
    // формы множественного числа у языков разные — сравниваем только «это plural»
    if ('other' in o && 'one' in o) return 'plural';
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)]));
  }
  return 'string';
}

describe('i18n', () => {
  it('ru и en одной структуры', () => {
    expect(shape(DICTS.en)).toEqual(shape(DICTS.ru));
  });

  it('множественное число', () => {
    const p = DICTS.ru.awards.paranoid.text;
    expect(tp('ru', p, 1)).toBe('1 удар по боту');
    expect(tp('ru', p, 3)).toBe('3 удара по ботам');
    expect(tp('ru', p, 5)).toBe('5 ударов по ботам');
    expect(tp('en', DICTS.en.awards.paranoid.text, 1)).toBe('1 bot hit');
    expect(tp('en', DICTS.en.awards.paranoid.text, 2)).toBe('2 bot hits');
  });

  it('строки для canvas помещаются в 180 пикс. (≤ 21 символа)', () => {
    for (const lang of LANGS as Lang[]) {
      const t: Dict = DICTS[lang];
      const g = t.game;
      const flat: string[] = [
        g.soundOffHint, g.soundOn, g.soundOff, g.outSub, g.outHint, g.ghost, g.ghostHint, g.hedge, ...Object.values(g.denied),
        ...Object.values(g.crowd), g.crowdVote, g.voteMajority, g.voteMinority, g.spotted, g.spottedMe, g.clapHint, g.clapDone, g.cutByCrowd, g.modTitle,
        ...Object.values(t.mods).flatMap((m) => [m.name, m.desc]), g.withCrowd, g.late, g.watchLate, g.findYourself, g.accuseTitle, g.accuseSub,
        g.accuseChange, g.spectator, g.spectatorLive, g.spectatorWait, g.spectatorDelay.replace('{n}', '10'), g.reveal, g.revealReplay, g.revealFinal, g.guessed, g.missed, g.caught, g.killedBy, g.noAccuse,
        tp(lang, g.resultsTitle, 5), ...Object.values(g.endReason), g.noAwards, tp(lang, g.nextIn, 10),
        g.youWon, g.winner, g.tooAlive, tp(lang, g.roundTheme, 5, { theme: t.themes.reduce((a, b) => (a.length > b.length ? a : b)) }),
        ...Object.values(t.themeText).flatMap((x) =>
          Object.values(x ?? {}).flatMap((v) => (typeof v === 'string' ? [v] : (Object.values(v ?? {}) as string[]))),
        ),
      ];
      // подписи призрака рядом с «Хлопушкой» — до 9 знаков (x 25…94)
      for (const x of [g.ghostShort, g.ghostHintShort]) expect(x.length, x).toBeLessThanOrEqual(9);
      // пробный дубль и подсказки: пары строк на поле
      const tut = t.tutorial;
      expect(tut.doneTitle.length).toBeLessThanOrEqual(21);
      const pairs = [tut.me, tut.crowd, tut.bots, tut.move, tut.crowdSoon, tut.crowdNow, tut.crowdOk, tut.crowdMiss, tut.spot, tut.actor, tut.hunt, tut.huntBot, tut.cut, tut.fists, tut.star, tut.starHud, tut.voteSoon, tut.voteNow, tut.voteOk, tut.voteMiss, tut.ghost, tut.accuse, tut.accuseOk, ...Object.values(tut.tips)];
      expect(tut.tapNext.length).toBeLessThanOrEqual(21);
      for (const pr of pairs) {
        expect(pr.length).toBe(2);
        for (const x of pr) expect(x.length, `${lang}: «${x}»`).toBeLessThanOrEqual(21);
      }
      // у каждой темы есть название
      expect(t.themes.length).toBe(THEME_COUNT);
      for (const s of flat) expect(s.length, `${lang}: «${s}»`).toBeLessThanOrEqual(21);
      // заголовок выбывания рисуется вдвое крупнее
      expect(g.outTitle.length * 16, g.outTitle).toBeLessThanOrEqual(176);
      expect(g.action.length * 16, g.action).toBeLessThanOrEqual(176);
      for (const a of Object.values(t.awards)) {
        expect(a.title.length, `${lang}: ${a.title}`).toBeLessThanOrEqual(16);
        expect(tp(lang, a.text, 12).length, `${lang}: ${tp(lang, a.text, 12)}`).toBeLessThanOrEqual(18);
      }
      for (const s of [g.share, g.next, g.rematch]) expect(s.length * 8).toBeLessThanOrEqual(80);
      // клип и карточка рисуются тем же шрифтом 8 пикс. на ширине 180
      const c = t.clip;
      for (const s of [c.button, fmt(c.making, { n: 100 }), c.ready, c.failed, c.find, c.reveal, fmt(c.round, { n: 7 }), ...Object.values(c.kinds), c.cta, ...Object.values(t.card), c.findMe, c.thatWasMe, c.gotMe, c.whoGotMe, c.deathBtnLong, fmt(c.watch, { name: 'Ш'.repeat(12) }), fmt(c.koOf, { name: 'Ш'.repeat(11) }), c.star3Of, c.botOf]) {
        expect(s.length, `${lang}: «${s}»`).toBeLessThanOrEqual(21);
      }
      for (const s of [c.send, c.save, c.close]) expect(s.length).toBeLessThanOrEqual(10);
      // кнопка клипа призрака: 80 пикс. — до 9 знаков (и «100%»)
      for (const s of [c.deathBtn, c.send]) expect(s.length).toBeLessThanOrEqual(9);
    }
  });

  it('язык устройства', () => {
    expect(pickLang(['ru-RU'])).toBe('ru');
    expect(pickLang(['uk'])).toBe('ru');
    expect(pickLang(['en-GB'])).toBe('en');
    expect(pickLang(['de-DE', 'ru'])).toBe('ru');
    expect(pickLang(['fr'])).toBe('en');
  });
});
