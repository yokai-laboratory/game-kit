// TRON is the Metatron platform credit, denominated at 1 TRON = 1 ledger cent. A whole-TRON stake
// therefore maps 1:1 to ledger cents -- the integer TRON count IS the cent amount, so a "5 TRON"
// stake debits 5 cents (5 TRON). Stakes are validated as whole TRON upstream. This is the TRON-rail
// counterpart to `ethToWei` (in game/settlement.ts), which prices the on-chain ETH rail in wei.
export function tronToCents(tron: string): number {
    return Math.round(Number(tron));
}
