import type { GameScreenProps } from "@game-kit/game-core";
import { CoinflipScreen } from "@game-kit/game-coinflip/screen";
import { TwentyOneScreen } from "@game-kit/game-hosted-b658f0aa/screen";

// The web-side mirror of apps/api's game registry: maps a gameId to the React screen that renders
// its state. To add a game, import its screen and register it here. To remove the example, delete
// the coinflip entry.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GameScreen = (props: GameScreenProps<any, any>) => React.JSX.Element;

const SCREENS: Record<string, GameScreen> = {
    coinflip: CoinflipScreen as GameScreen,
    "hosted-b658f0aa": TwentyOneScreen as GameScreen,
};

export function getGameScreen(gameId: string): GameScreen | undefined {
    return SCREENS[gameId];
}

// Optional ambient backdrop per game — typically the game's ENGINE in attract mode (Unity,
// Godot, GameMaker, plain canvas… the shell doesn't care; see docs/SHELL.md). A game without one
// gets the shell's engine-free aurora.
export type GameBackdrop = () => React.JSX.Element;

const BACKDROPS: Record<string, GameBackdrop> = {};

export function getGameBackdrop(gameId: string): GameBackdrop | undefined {
    return BACKDROPS[gameId];
}
