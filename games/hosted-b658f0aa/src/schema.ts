import { z } from "zod";

// The hosted contract is schemaless (the sandbox validated by playthrough); these passthroughs
// keep the kit engine's I/O validation in place. Tighten them as you type your ported game.
export const stateSchema = z.looseObject({ players: z.array(z.string()) });
export const moveSchema = z.unknown();
export const configSchema = z.object({});
