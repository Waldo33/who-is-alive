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
    expect(tp('ru', p, 1)).toBe('1 удар мимо');
    expect(tp('ru', p, 3)).toBe('3 удара мимо');
    expect(tp('ru', p, 5)).toBe('5 ударов мимо');
    expect(tp('en', DICTS.en.awards.paranoid.text, 1)).toBe('1 bot hit');
    expect(tp('en', DICTS.en.awards.paranoid.text, 2)).toBe('2 bot hits');
  });

  it('строки для canvas помещаются в 180 пикс. (≤ 21 символа)', () => {
    for (const lang of LANGS as Lang[]) {
      const t: Dict = DICTS[lang];
      const g = t.game;
      const flat: string[] = [
        g.soundOffHint, g.soundOn, g.soundOff, g.outSub, g.outHint, g.ghost, g.ghostHint, g.hedge, ...Object.values(g.denied),
        ...Object.values(g.crowd), g.crowdVote, g.crowdGhost, g.voteMajority, g.voteMinority, g.spotted, g.spottedMe, g.clapHint, g.clapDone, g.cutByCrowd, g.modTitle,
        ...Object.values(t.mods).flatMap((m) => [m.name, m.desc]), g.withCrowd, g.late, g.watchLate, g.findYourself,
        g.spectator, g.spectatorLive, g.spectatorWait, g.spectatorDelay.replace('{n}', '10'), g.reveal, g.revealReplay, g.revealFinal, g.guessed, g.missed, g.caught, g.killedBy, g.noAccuse,
        tp(lang, g.resultsTitle, 5), ...Object.values(g.endReason), g.starsBurned, g.noAwards, tp(lang, g.nextIn, 10), fmt(g.nextTake, { n: 12, s: 10 }), fmt(g.toWin, { n: 12 }),
        g.youWon, g.winner, g.tooAlive, g.withFriends, tp(lang, g.roundTheme, 5, { theme: t.themes.reduce((a, b) => (a.length > b.length ? a : b)) }),
        ...Object.values(t.themeText).flatMap((x) =>
          Object.values(x ?? {}).flatMap((v) => (typeof v === 'string' ? [v] : (Object.values(v ?? {}) as string[]))),
        ),
      ];
      // подписи призрака рядом с «Хлопушкой» — до 9 знаков (x 25…94)
      for (const x of [g.ghostShort, g.ghostHintShort]) expect(x.length, x).toBeLessThanOrEqual(9);
      // пробный дубль и подсказки: пары строк на поле
      const tut = t.tutorial;
      expect(tut.doneTitle.length).toBeLessThanOrEqual(21);
      const pairs = [tut.me, tut.crowd, tut.bots, tut.move, tut.crowdSoon, tut.crowdNow, tut.crowdOk, tut.crowdMiss, tut.spot, tut.actor, tut.hunt, tut.huntBot, tut.cut, tut.fists, tut.star, tut.starHud, tut.voteSoon, tut.voteNow, tut.voteOk, tut.voteMiss, tut.ghost, tut.ghostMark, tut.ghostMarkOk, tut.ghostClap, tut.ghostClapOk, tut.accuseOk, ...Object.values(tut.tips)];
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
        // плашка награды (scene.ts › awardCard): слева крупная иконка, тексту остаётся 16 знаков
        expect(tp(lang, a.text, 12).length, `${lang}: ${tp(lang, a.text, 12)}`).toBeLessThanOrEqual(16);
      }
      // кнопки итогов на холсте (scene.ts › addRow): ширина = 8 пикс. на знак + поля по 6, иконка 16 + зазор 4;
      // ряд — 162 пикс., «Поделиться» иконкой — 30 пикс. + зазор 2
      const btn = (s: string, icon = false) => s.length * 8 + 12 + (icon ? 20 : 0);
      expect(btn(fmt(g.next, { n: 9 })), g.next).toBeLessThanOrEqual(162 - 32);
      expect(btn(fmt(g.nextTake, { n: 9, s: 10 })), g.nextTake).toBeLessThanOrEqual(162 - 32);
      expect(btn(g.toFinal), g.toFinal).toBeLessThanOrEqual(162 - 32);
      expect(btn(fmt(g.toFinalIn, { s: 10 })), g.toFinalIn).toBeLessThanOrEqual(162 - 32);
      expect(btn(g.rematch) + 2 + btn(g.withFriends), `${g.rematch} + ${g.withFriends}`).toBeLessThanOrEqual(162);
      expect(btn(g.rematch), g.rematch).toBeLessThanOrEqual(162 - 32);
      expect(btn(g.share, true), g.share).toBeLessThanOrEqual(162);
      expect(btn(t.clip.film, true), t.clip.film).toBeLessThanOrEqual(174);
      // клип и карточка рисуются тем же шрифтом 8 пикс. на ширине 180
      const c = t.clip;
      for (const s of [c.film, c.hook, c.hookSub, c.cast, c.lead, c.cameo, c.extrasRole, c.bloopers, tp(lang, c.bots, 28), fmt(c.filmMaking, { n: 100 }), fmt(c.making, { n: 100 }), c.ready, c.failed, c.find, c.reveal, fmt(c.round, { n: 7 }), ...Object.values(c.kinds), c.cta, ...Object.values(t.card), c.findMe, c.thatWasMe, c.gotMe, c.whoGotMe, c.deathBtnLong, fmt(c.watch, { name: 'Ш'.repeat(12) }), fmt(c.koOf, { name: 'Ш'.repeat(11) }), c.star3Of, c.botOf, c.preparingLong]) {
        expect(s.length, `${lang}: «${s}»`).toBeLessThanOrEqual(21);
      }
      // финал фильма: заголовок сюжета — крупно (×4/3, до 14 знаков), доказательство и вызов — обычным
      for (const st of Object.values(c.stories)) {
        expect(st.title.length, `${lang}: «${st.title}»`).toBeLessThanOrEqual(14);
        for (const s of [fmt(st.fact, { n: 8, a: 3, b: 2 }), st.cta]) expect(s.length, `${lang}: «${s}»`).toBeLessThanOrEqual(21);
      }
      for (const s of [c.photoTie, c.rival, c.rewind]) expect(s.length, `${lang}: «${s}»`).toBeLessThanOrEqual(21);
      for (const s of [c.send, c.save, c.close]) expect(s.length).toBeLessThanOrEqual(10);
      // рядом с QR (33 пикс.) в концовке и титрах фильма — до 12 знаков
      for (const s of [c.play1, c.play2]) expect(s.length, s).toBeLessThanOrEqual(12);
      // кнопка клипа призрака в шапке: 65 пикс. — до 7 знаков (и «100%»)
      for (const s of [c.deathBtn, c.sendShort, c.preparing]) expect(s.length, s).toBeLessThanOrEqual(7);
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
