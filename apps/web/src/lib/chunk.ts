/**
 * Ленивая подгрузка частей приложения с защитой от обновления сайта: если вкладка открыта
 * со старой версии, а нужного файла на сервере уже нет — один раз перезагружаем страницу.
 */
const KEY = 'kto:chunk-reload';

export async function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    const m = await load();
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* приватный режим */
    }
    return m;
  } catch (e) {
    let tried = false;
    try {
      tried = sessionStorage.getItem(KEY) === '1';
      sessionStorage.setItem(KEY, '1');
    } catch {
      tried = true;
    }
    if (!tried) location.reload();
    throw e;
  }
}
