"use client";

import { FormEvent, useEffect, useState } from "react";
import { ArrowRight, Check, Laptop, LockKeyhole } from "lucide-react";
import {
  createPhoneKeys,
  deriveSessionKey,
  exportSessionKey,
  sha256,
} from "../remote-crypto";
import {
  formatPairKey,
  normalizePairKey,
  PENDING_KEY,
  phoneName,
  STORAGE_KEY,
} from "../relaydesk-meta";
import type { PendingPair, StoredPairing } from "../relaydesk-types";

export function PairingScreen({ onPaired }: { onPaired: (pairing: StoredPairing) => void }) {
  const [keyText, setKeyText] = useState("");
  const [pending, setPending] = useState<PendingPair | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      const raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return;
      try {
        const saved = JSON.parse(raw) as PendingPair;
        if (saved.expiresAt > Date.now()) setPending(saved);
        else localStorage.removeItem(PENDING_KEY);
      } catch {
        localStorage.removeItem(PENDING_KEY);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const response = await fetch(`/api/pair/status?requestId=${encodeURIComponent(pending.requestId)}`, {
          headers: { authorization: `Bearer ${pending.pollToken}` },
          cache: "no-store",
        });
        const data = await response.json() as {
          status?: string;
          error?: string;
          clientId?: string;
          clientToken?: string;
          device?: { id: string; name: string; platform: string; publicKey: JsonWebKey };
        };
        if (!response.ok) throw new Error(data.error ?? "无法读取连接状态");
        if (data.status === "approved" && data.clientId && data.clientToken && data.device) {
          const sessionKey = await deriveSessionKey(pending.privateKey, data.device.publicKey, pending.pairKeyHash);
          const pairing: StoredPairing = {
            clientId: data.clientId,
            clientToken: data.clientToken,
            key: await exportSessionKey(sessionKey),
            device: { id: data.device.id, name: data.device.name, platform: data.device.platform },
          };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(pairing));
          localStorage.removeItem(PENDING_KEY);
          if (!stopped) onPaired(pairing);
          return;
        }
        if (["rejected", "expired"].includes(data.status ?? "")) {
          localStorage.removeItem(PENDING_KEY);
          if (!stopped) {
            setPending(null);
            setError(data.status === "rejected" ? "电脑拒绝了连接请求" : "请求已过期，请重新输入配对码");
          }
          return;
        }
      } catch (pollError) {
        if (!stopped) setError(pollError instanceof Error ? pollError.message : "连接中断，请重试");
      }
      if (!stopped) timer = setTimeout(check, 1_200);
    };
    void check();
    return () => { stopped = true; clearTimeout(timer); };
  }, [pending, onPaired]);

  async function requestPair(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizePairKey(keyText);
    if (normalized.length !== 16 || working) return;
    setWorking(true);
    setError("");
    try {
      const pairKeyHash = await sha256(normalized);
      const keys = await createPhoneKeys();
      const response = await fetch("/api/pair/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairKeyHash, publicKey: keys.publicKey, phoneName: phoneName() }),
      });
      const data = await response.json() as {
        error?: string;
        requestId?: string;
        pollToken?: string;
        deviceName?: string;
        expiresAt?: number;
      };
      if (!response.ok || !data.requestId || !data.pollToken || !data.expiresAt) {
        throw new Error(data.error ?? "无法发送连接请求");
      }
      const next: PendingPair = {
        requestId: data.requestId,
        pollToken: data.pollToken,
        privateKey: keys.privateKey,
        pairKeyHash,
        deviceName: data.deviceName ?? "你的电脑",
        expiresAt: data.expiresAt,
      };
      localStorage.setItem(PENDING_KEY, JSON.stringify(next));
      setPending(next);
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : "连接失败，请重试");
    } finally {
      setWorking(false);
    }
  }

  function cancelPending() {
    localStorage.removeItem(PENDING_KEY);
    setPending(null);
    setError("");
  }

  return (
    <main className="pair-shell">
      <header className="pair-brand"><strong>RelayDesk</strong><span>电脑上的工作，手机接着做</span></header>
      <section className="pair-card" aria-labelledby="pair-title">
        {pending ? (
          <div className="approval-state">
            <div className="approval-device"><Laptop size={22} strokeWidth={1.8} /><span><i />等待电脑确认</span></div>
            <p className="step-label">最后一步</p>
            <h1 id="pair-title">回到电脑确认</h1>
            <p className="pair-lead">打开 {pending.deviceName} 上的 RelayDesk 控制中心，点击“连接”。</p>
            <div className="approval-note"><Check size={16} /><span>确认后，这台手机会一直保持连接。</span></div>
            {error ? <p className="form-error">{error}</p> : null}
            <button className="text-button" type="button" onClick={cancelPending}>取消这次请求</button>
          </div>
        ) : (
          <>
            <p className="step-label">首次连接</p>
            <h1 id="pair-title">连接电脑</h1>
            <p className="pair-lead">输入电脑控制中心显示的 16 位配对码。</p>
            <form onSubmit={requestPair} className="pair-form">
              <label htmlFor="pair-key">配对码</label>
              <input
                id="pair-key"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                maxLength={19}
                value={keyText}
                onChange={(event) => setKeyText(formatPairKey(event.target.value))}
                placeholder="XXXX-XXXX-XXXX-XXXX"
              />
              {error ? <p className="form-error">{error}</p> : null}
              <button type="submit" disabled={normalizePairKey(keyText).length !== 16 || working}>
                <span>{working ? "正在连接" : "继续"}</span><ArrowRight size={17} />
              </button>
            </form>
          </>
        )}
      </section>
      <footer className="pair-foot"><LockKeyhole size={14} /><span>端到端加密。中继无法读取会话内容。</span></footer>
    </main>
  );
}
