export const runtime = 'edge';

export function GET() {
  return Response.json({ ok: true, app: 'kto-tut-zhivoy', stage: 2 });
}
