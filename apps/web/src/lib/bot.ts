/**
 * Боты превью ссылок и поисковики. Важно: iMessage строит превью настоящим WebKit со скриптами
 * и представляется как facebookexternalhit/Twitterbot — без этой проверки он входил бы в комнату
 * анонимным игроком и занимал место.
 */
// только известные имена: общее «bot» совпало бы, например, с телефонами CUBOT;
// встроенные браузеры приложений (Instagram, Snapchat, Viber…) — это живые люди, их не трогаем
const BOT_RE =
  /facebookexternalhit|facebot|twitterbot|slackbot|telegrambot|whatsapp|discordbot|linkedinbot|vkshare|skypeuripreview|embedly|quora link preview|pinterestbot|redditbot|applebot|googlebot|bingbot|yandexbot|duckduckbot|baiduspider|petalbot|iframely|bitlybot|crawler|spider/i;

export function isBotUA(ua: string | null | undefined): boolean {
  return !!ua && BOT_RE.test(ua);
}
