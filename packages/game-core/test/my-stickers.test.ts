import { describe, expect, it } from 'vitest';
import { MY_FIGS, MY_MARKS, STICKER_LIST, isMySticker, myCaption, myFigOpen, myTop, parseMySticker, rude } from '../src';

/** «Собери свой стикерпак»: свои стикеры, подпись и фильтр (game-core › shop.ts). Решает сервер тем же кодом. */

describe('свой стикер', () => {
  it('первые эмодзи всех стикеров разные: по ним бот находит стикер в паке', () => {
    const first = [...STICKER_LIST.map((s) => s.emoji[0]), ...MY_MARKS].map((e) => e.replace(/️/g, ''));
    expect(new Set(first).size).toBe(first.length);
  });

  it('подпись: перенос по пробелу на две строки, длинная и чужие знаки — нельзя', () => {
    expect(myCaption('  Привет,   мир ')).toEqual({ lines: ['Привет,', 'мир'] });
    expect(myCaption('')).toEqual({ lines: [] });
    expect(myCaption('Это мой дубль')).toEqual({ lines: ['Это мой', 'дубль'] });
    expect(myCaption('Оченьдлинноеслово')).toEqual({ error: 'long' });
    expect(myCaption('а'.repeat(30))).toEqual({ error: 'long' });
    expect(myCaption('@durov')).toEqual({ error: 'chars' });
    expect(myCaption('t.me/x')).toEqual({ error: 'chars' });
    expect(myCaption('Зайди kto.ru')).toEqual({ error: 'link' });
    expect(myCaption('www')).toEqual({ error: 'link' });
    expect(myCaption('Ура 🎉')).toEqual({ error: 'chars' });
    expect(myCaption('Ок​')).toEqual({ error: 'chars' });
    expect(myCaption(42)).toEqual({ error: 'chars' });
  });

  it('мат не проходит, обычные слова — проходят', () => {
    for (const s of ['Хуй', 'пиздец', 'ЕБАТЬ', 'бля', 'Сука!', 'xyй', 'х у й', 'бл.я', 'пидор', 'Fuck you', 'SHIT', 'заебал', 'мудак'])
      expect(rude(s), s).toBe(true);
    for (const s of ['Привет!', 'Рубля нет', 'Себя жалко', 'Небо', 'Команда', 'Мандарин', 'Употребляю', 'Хлебушек', 'Ах уехал', 'Топ издатель', 'Class', 'Погибла', 'Я массовка', 'Мотор!', 'Класс'])
      expect(rude(s), s).toBe(false);
    expect(myCaption('Ну ты сука')).toEqual({ error: 'rude' });
  });

  it('фигурки: актёр у всех, Кот-банан за покупку, герой площадки — за дубль на ней', () => {
    expect(myFigOpen('actor', [])).toBe(true);
    expect(myFigOpen('kotBanan', [])).toBe(false);
    expect(myFigOpen('kotBanan', ['kotBanan'])).toBe(true);
    expect(myFigOpen('chef', ['st:chef'])).toBe(true);
    expect(myFigOpen('chef', ['st:penguin'])).toBe(false);
    for (const f of MY_FIGS) if ('sticker' in f) expect(STICKER_LIST.some((s) => s.id === f.sticker && s.earn === 'theme')).toBe(true);
  });

  it('разбор с телефона: закрытая фигурка, плохая поза или цвет — отказ', () => {
    expect(parseMySticker({ fig: 'actor', pose: 'wave', color: 1, caption: 'Йо' }, [])).toEqual({ fig: 'actor', pose: 'wave', color: 1, text: ['Йо'] });
    expect(parseMySticker({ fig: 'kotBanan', pose: 'wave', color: 1 }, [])).toEqual({ error: 'locked' });
    expect(parseMySticker({ fig: 'actor', pose: 'fly', color: 1 }, [])).toEqual({ error: 'bad' });
    expect(parseMySticker({ fig: 'actor', pose: 'wave', color: 99 }, [])).toEqual({ error: 'bad' });
    expect(parseMySticker({ fig: 'actor', pose: 'wave', color: 0, caption: 'хуй' }, [])).toEqual({ error: 'rude' });
    expect(isMySticker({ slot: 0, rev: 1, fig: 'actor', pose: 'wave', color: 0, text: ['Йо'] })).toBe(true);
    expect(isMySticker({ slot: 5, rev: 1, fig: 'actor', pose: 'wave', color: 0, text: [] })).toBe(false);
    expect(isMySticker({ slot: 0, rev: 1, fig: 'actor', pose: 'wave', color: 0, text: ['@x'] })).toBe(false);
  });

  it('строка сверху, как в мемах: до 10 знаков, те же правила, мат между строк ловится', () => {
    expect(myTop('  Я не   плачу ')).toEqual({ line: 'Я не плачу' });
    expect(myTop('')).toEqual({ line: '' });
    expect(myTop('Я совсем не плачу')).toEqual({ error: 'long' });
    expect(myTop('@durov')).toEqual({ error: 'chars' });
    expect(myTop('сука')).toEqual({ error: 'rude' });
    const meme = parseMySticker({ fig: 'actor', pose: 'stun', color: 3, top: 'Я не плачу', caption: 'Это просто слезы' }, []);
    expect(meme).toEqual({ fig: 'actor', pose: 'stun', color: 3, top: 'Я не плачу', text: ['Это просто', 'слезы'] });
    // пустая верхняя строка — поля нет (старые стикеры и старые клиенты — как раньше)
    expect(parseMySticker({ fig: 'actor', pose: 'wave', color: 1, top: ' ', caption: 'Йо' }, [])).toEqual({ fig: 'actor', pose: 'wave', color: 1, text: ['Йо'] });
    expect(parseMySticker({ fig: 'actor', pose: 'wave', color: 1, top: 'Я совсем не плачу' }, [])).toEqual({ error: 'long' });
    expect(parseMySticker({ fig: 'actor', pose: 'wave', color: 1, top: 'х', caption: 'уй' }, [])).toEqual({ error: 'rude' });
    expect(isMySticker({ slot: 0, rev: 1, fig: 'actor', pose: 'wave', color: 0, top: 'Я не плачу', text: ['Это просто', 'слезы'] })).toBe(true);
    expect(isMySticker({ slot: 0, rev: 1, fig: 'actor', pose: 'wave', color: 0, top: '', text: [] })).toBe(false);
    expect(isMySticker({ slot: 0, rev: 1, fig: 'actor', pose: 'wave', color: 0, top: 'Я совсем не плачу', text: [] })).toBe(false);
    expect(isMySticker({ slot: 0, rev: 1, fig: 'actor', pose: 'wave', color: 0, top: 42, text: [] })).toBe(false);
  });
});
