import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getMe, logout as apiLogout } from "./api";
import { captureSessionFromUrl, clearSessionToken } from "./session";

interface User {
    id: string;
    displayName: string;
    email: string | null;
    points: number;
}

interface AuthContextValue {
    user: User | null;
    loading: boolean;
    refresh: () => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        try {
            const data = await getMe();
            setUser(data.user);
        } catch {
            setUser(null);
        } finally {
            setLoading(false);
        }
    }, []);

    const logout = useCallback(async () => {
        await apiLogout();
        clearSessionToken();
        await refresh();
    }, [refresh]);

    useEffect(() => {
        // The OAuth callback lands us at /lobby#session=<id>. Capture + persist the token (and strip
        // the fragment) before the first /me, so the very first load is already authenticated.
        captureSessionFromUrl();
        void refresh();
    }, [refresh]);

    return <AuthContext.Provider value={{ user, loading, refresh, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error("useAuth outside AuthProvider");
    return ctx;
}
