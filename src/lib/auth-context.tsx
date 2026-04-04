"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, onAuthStateChanged, signOut, signInWithPopup, GoogleAuthProvider } from "firebase/auth";
import { auth, googleProvider } from "./firebase";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  accessToken: string | null;
  setAccessToken: (token: string | null) => void;
  signOut: () => Promise<void>;
  reauth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_KEY = "orderhub_access_token";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser]               = useState<User | null>(null);
  const [loading, setLoading]         = useState(true);
  const [accessToken, setAccessTokenState] = useState<string | null>(
    () => typeof window !== "undefined" ? sessionStorage.getItem(SESSION_KEY) : null
  );

  const setAccessToken = (token: string | null) => {
    setAccessTokenState(token);
    if (token) sessionStorage.setItem(SESSION_KEY, token);
    else sessionStorage.removeItem(SESSION_KEY);
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
      if (!u) setAccessToken(null);
    });
    return unsubscribe;
  }, []);

  const handleSignOut = async () => {
    await signOut(auth);
    setAccessToken(null);
  };

  const handleReauth = async () => {
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) setAccessToken(credential.accessToken);
  };

  return (
    <AuthContext.Provider value={{ user, loading, accessToken, setAccessToken, signOut: handleSignOut, reauth: handleReauth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
