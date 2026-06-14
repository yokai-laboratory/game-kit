export default {
	setup({ players, seed }) {
		// Shared ladder from 0; players alternate adding 1-3; whoever lands on exactly 21 wins the pot.
		return { players, total: 0, turn: 0, lastMover: null, seed };
	},
	moves(state) {
		const player = state.players[state.turn % state.players.length];
		const out = [];
		for (const add of [1, 2, 3]) {
			if (state.total + add <= 21) out.push({ playerId: player, move: { add } });
		}
		return out;
	},
	move(state, playerId, move) {
		const add = move && typeof move.add === "number" ? move.add : 0;
		if (add < 1 || add > 3) throw new Error("add must be 1, 2, or 3");
		if (state.total + add > 21) throw new Error("move would overshoot 21");
		return { ...state, total: state.total + add, turn: state.turn + 1, lastMover: playerId };
	},
	outcome(state) {
		if (state.total === 21) return { kind: "win", winner: state.lastMover };
		return null;
	},
};
