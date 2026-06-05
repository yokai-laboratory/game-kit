export function Landing(): React.JSX.Element {
    return (
        <main className="landing">
            <h1>game-kit</h1>
            <p className="muted">
                A full-stack web3 game template on the Titanium Games rails. Sign in with your TTG account to play the
                example coin-flip duel — then swap it for your own game.
            </p>
            <a className="cta" href="/api/auth/login">
                Sign in with Titanium Games
            </a>
        </main>
    );
}
