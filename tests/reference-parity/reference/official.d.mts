export function verifyCrash(serverSeed: string, clientSeed: string): number;
export function generateCard(serverSeed: string, clientSeed: string, cardNumber: number): { label: string; suit: string };
export function kenoDraw(serverSeed: string, clientSeed: string, nonce: string, version: string, mode: string): number[];
export function minesPlacement(
  serverSeed: string,
  clientSeed: string,
  nonce: string,
  version: string,
  gridSize: number,
  mineCount: number,
): number[];
