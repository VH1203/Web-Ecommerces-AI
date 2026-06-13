import { useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { API_ORIGIN } from "../services/env";

export default function useSocket(shopId) {
    const ref = useRef();
    useEffect(() => {
        const s = io(`${API_ORIGIN}/realtime`, {
            withCredentials: true,
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
        });
        s.emit("join-shop", { shopId });
        ref.current = s;
        return () => s.close();
    }, [shopId]);
    return ref;
}
