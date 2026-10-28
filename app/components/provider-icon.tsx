import Image from "next/image";
import type { Provider } from "../relaydesk-types";

export function ProviderIcon({ provider, size = 18, className = "" }: { provider: Provider; size?: number; className?: string }) {
  return <Image src={`/brands/${provider === "codex" ? "codex.png" : "claude.svg"}`} alt="" aria-hidden="true" width={size} height={size} unoptimized className={`provider-icon ${className}`} />;
}
