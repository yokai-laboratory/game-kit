import type { GameScreenProps } from "@game-kit/game-core";

// Twenty-One Dash — ported from the hosted window.ttg screen to a game-kit React screen. Receives
// the redacted per-seat view + submitMove from the generic Room component. The hosted module's
// view() broadcasts full state: { players: [hostUserId, guestUserId], total, turn, lastMover }.

type View = { players: string[]; total: number; turn: number; lastMover: string | null };
type Move = { add: number };

const ADDS = [1, 2, 3] as const;

export function TwentyOneScreen(props: GameScreenProps<View, Move>): React.JSX.Element {
	const { view, opponent, status, result, you, submitMove } = props;

	if (status !== "in_progress" && status !== "completed") {
		return <p className="muted">Waiting for both players to stake…</p>;
	}

	const opponentName = opponent?.displayName ?? "Opponent";
	const activeUserId = view.players[view.turn % view.players.length];
	const yourTurn = activeUserId === you.id;
	const decided = status === "completed" || view.total === 21;

	return (
		<div className="twentyone">
			<div className="scoreline">
				<span>
					Total <strong>{view.total}</strong> / 21
				</span>
				<span className="muted">{decided ? "Final" : yourTurn ? "Your move" : `${opponentName}'s move`}</span>
			</div>

			{!decided && yourTurn && (
				<div className="pick-buttons">
					{ADDS.map((n) => (
						<button
							key={n}
							disabled={view.total + n > 21}
							className="pick"
							onClick={() => submitMove({ add: n })}
						>
							+{n}
						</button>
					))}
				</div>
			)}

			{!decided && !yourTurn && <p className="muted">{opponentName} is climbing the ladder…</p>}

			{decided && (
				<div className="result">
					{result.kind === "win" && (
						<h3>{result.winnerUserId === you.id ? "🎉 You hit 21 — pot is yours!" : "You lost this one."}</h3>
					)}
					{result.kind === "draw" && <h3>Draw — stakes refunded.</h3>}
				</div>
			)}
		</div>
	);
}

export default TwentyOneScreen;
