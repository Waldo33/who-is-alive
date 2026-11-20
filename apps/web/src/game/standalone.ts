import { mountSandbox } from './shell';

/** Точка входа автономного HTML-билда (превью без Next.js). */
mountSandbox(document.getElementById('app')!, { fontFamily: '"Press Start 2P", monospace' });
